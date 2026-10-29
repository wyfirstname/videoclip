// ASR worker：运行在 Electron utilityProcess 中，执行本地语音识别
// 输入：wav 文件 + 模型路径；输出：带时间戳的字幕段
import * as fs from 'fs'

interface WorkerPayload {
  wavPath: string
  modelPath: string
  tokensPath: string
  type: 'sense-voice' | 'paraformer'
  numThreads: number
  vadPath: string | null
}

interface SubtitleSegment {
  start: number
  end: number
  text: string
}

function post(msg: Record<string, unknown>): void {
  // parentPort 仅存在于 utilityProcess 环境
  process.parentPort?.postMessage(msg)
}

function readWav(file: string): Float32Array {
  const buf = fs.readFileSync(file)
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF') {
    throw new Error('无效的 WAV 文件')
  }
  let pos = 12
  let dataOffset = -1
  let dataLen = 0
  while (pos + 8 <= buf.length) {
    const id = buf.toString('ascii', pos, pos + 4)
    const size = buf.readUInt32LE(pos + 4)
    if (id === 'data') {
      dataOffset = pos + 8
      dataLen = Math.min(size, buf.length - dataOffset)
      break
    }
    pos += 8 + size + (size % 2)
  }
  if (dataOffset < 0) throw new Error('WAV 中未找到 data 块')
  const n = Math.floor(dataLen / 2)
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    out[i] = buf.readInt16LE(dataOffset + i * 2) / 32768
  }
  return out
}

const PUNCT = new Set(['，', '。', '！', '？', '；', '、', ',', '.', '!', '?', ';', '：', ':'])

/** 判断模型是否返回了可用的 token 级时间戳（Paraformer 等模型可能返回全 0） */
function hasUsableTimestamps(timestamps: number[], duration: number): boolean {
  if (!timestamps || timestamps.length < 2) return false
  const last = timestamps[timestamps.length - 1]
  const first = timestamps[0]
  return last > 0.2 && last <= duration + 5 && last > first
}

/** 用 token 级时间戳把识别文本切成字幕段 */
function buildSubtitles(
  tokens: string[],
  timestamps: number[],
  offsetSec: number
): SubtitleSegment[] {
  const pieces: SubtitleSegment[] = []
  let curText = ''
  let curStart = -1
  let lastT = 0
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]
    if (!tok || tok.startsWith('<')) continue
    const t = typeof timestamps[i] === 'number' ? timestamps[i] : lastT
    if (curStart < 0) curStart = t
    curText += tok
    lastT = t
    const isPunct = PUNCT.has(tok)
    const tooLong = t - curStart > 6
    if (isPunct || tooLong) {
      const text = curText.trim()
      if (text) pieces.push({ start: offsetSec + curStart, end: offsetSec + t + 0.25, text })
      curText = ''
      curStart = -1
    }
  }
  const rest = curText.trim()
  if (rest) {
    const endT = timestamps.length ? timestamps[timestamps.length - 1] + 0.4 : curStart + 1
    pieces.push({ start: offsetSec + (curStart < 0 ? 0 : curStart), end: offsetSec + endT, text: rest })
  }
  return pieces
}

/**
 * 无 token 时间戳时的兜底：按字符数比例把文本分配到该音频区间内。
 * （Paraformer 等模型不返回可靠时间戳，此处按朗读节奏近似）
 */
function buildSubtitlesProportional(
  text: string,
  offsetSec: number,
  durationSec: number,
  maxChars = 30
): SubtitleSegment[] {
  const clean = String(text || '').replace(/<[^>]*>/g, '').trim()
  if (!clean) return []
  // 先按标点/长度切分
  const parts: string[] = []
  let buf = ''
  for (const ch of clean) {
    buf += ch
    if ((PUNCT.has(ch) && buf.length >= 8) || buf.length >= maxChars) {
      parts.push(buf)
      buf = ''
    }
  }
  if (buf.trim()) parts.push(buf)
  if (!parts.length) return []

  const totalChars = parts.reduce((n, p) => n + p.length, 0) || 1
  const out: SubtitleSegment[] = []
  let cursor = offsetSec
  for (const p of parts) {
    const span = (p.length / totalChars) * durationSec
    out.push({ start: cursor, end: cursor + span, text: p.trim() })
    cursor += span
  }
  return out
}

function run(payload: WorkerPayload): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const sherpa = require('sherpa-onnx-node')
    const samples = readWav(payload.wavPath)
    const sampleRate = 16000
    const totalSec = samples.length / sampleRate
    post({ type: 'progress', percent: 2, stage: '加载识别模型...' })

    const modelConfig: Record<string, unknown> = {
      tokens: payload.tokensPath,
      numThreads: payload.numThreads || 4,
      debug: 0,
      provider: 'cpu'
    }
    if (payload.type === 'sense-voice') {
      modelConfig.senseVoice = { model: payload.modelPath }
      modelConfig.useInverseTextNormalization = 1
    } else {
      modelConfig.paraformer = { model: payload.modelPath }
    }

    const recognizer = new sherpa.OfflineRecognizer({
      featConfig: { sampleRate, featureDim: 80 },
      modelConfig,
      decodingMethod: 'greedy_search'
    })

    // 1. 生成分段
    interface Chunk {
      startSample: number
      samples: Float32Array
    }
    const chunks: Chunk[] = []

    if (payload.vadPath && fs.existsSync(payload.vadPath)) {
      post({ type: 'progress', percent: 5, stage: '语音活动检测 (VAD)...' })
      try {
        const vadConfig = {
          sileroVad: {
            model: payload.vadPath,
            threshold: 0.5,
            minSpeechDuration: 0.3,
            minSilenceDuration: 0.4,
            windowSize: 512,
            maxSpeechDuration: 15
          },
          sampleRate,
          numThreads: 1,
          debug: 0,
          provider: 'cpu'
        }
        const vad = new sherpa.Vad(vadConfig)
        const windowSize = 512
        // 注意：front() 必须传 false，否则返回的是外部内存缓冲区，
        // 在 Electron 中继续传给识别器会被 napi 拒绝（External buffers are not allowed）
        for (let i = 0; i + windowSize <= samples.length; i += windowSize) {
          vad.acceptWaveform(samples.subarray(i, i + windowSize))
          while (!vad.isEmpty()) {
            const seg = vad.front(false)
            vad.pop()
            chunks.push({ startSample: seg.start, samples: seg.samples })
          }
        }
        vad.flush()
        while (!vad.isEmpty()) {
          const seg = vad.front(false)
          vad.pop()
          chunks.push({ startSample: seg.start, samples: seg.samples })
        }
      } catch (e) {
        console.error('[asr-worker] VAD 失败，回退固定分段:', e)
        post({
          type: 'progress',
          percent: 5,
          stage: 'VAD 不可用，改用固定分段',
          detail: e instanceof Error ? e.message : String(e)
        })
        chunks.length = 0
      }
    }

    if (chunks.length === 0) {
      // 兜底：固定 5 秒分段（无 VAD 时用较短窗口以降低时间戳误差）
      const win = sampleRate * 5
      for (let i = 0; i < samples.length; i += win) {
        chunks.push({ startSample: i, samples: samples.subarray(i, Math.min(i + win, samples.length)) })
      }
    }

    // 2. 逐段识别
    const subtitles: SubtitleSegment[] = []
    let doneSec = 0
    let lastPct = 0
    for (const chunk of chunks) {
      const stream = recognizer.createStream()
      stream.acceptWaveform({ sampleRate, samples: chunk.samples })
      recognizer.decode(stream)
      const result = recognizer.getResult(stream)
      if (result) {
        const offset = chunk.startSample / sampleRate
        const chunkDuration = chunk.samples.length / sampleRate
        const tokens: string[] = result.tokens || []
        const timestamps: number[] = result.timestamps || []
        if (hasUsableTimestamps(timestamps, chunkDuration)) {
          subtitles.push(...buildSubtitles(tokens, timestamps, offset))
        } else {
          // 模型无可靠时间戳：按字符比例分配（并尽量使用全文字段）
          const text = result.text || tokens.join('')
          subtitles.push(...buildSubtitlesProportional(text, offset, chunkDuration))
        }
      }
      doneSec += chunk.samples.length / sampleRate
      const pct = Math.min(99, Math.floor((doneSec / totalSec) * 95) + 4)
      if (pct > lastPct) {
        lastPct = pct
        post({
          type: 'progress',
          percent: pct,
          stage: '识别中...',
          detail: `${Math.round(doneSec)}s / ${Math.round(totalSec)}s`
        })
      }
      // 让出事件循环
      awaitYield()
    }

    // 3. 过滤、合并过短碎片
    const raw = subtitles
      .filter((s) => s.text && s.end > s.start)
      .sort((a, b) => a.start - b.start)
    const cleaned: SubtitleSegment[] = []
    for (const s of raw) {
      const prev = cleaned[cleaned.length - 1]
      const tooShort = s.text.length < 6 || s.end - s.start < 0.8
      if (prev && tooShort && s.start - prev.end < 2) {
        // 碎片并入前一段
        prev.text += s.text
        prev.end = Math.max(prev.end, s.end)
      } else {
        cleaned.push({ ...s })
      }
    }
    post({ type: 'done', segments: cleaned, duration: totalSec })
  } catch (err) {
    post({ type: 'error', message: err instanceof Error ? err.message : String(err) })
  }
}

function awaitYield(): void {
  // 同步循环中定期触发 GC/IO：Node 同步阻塞无法真正 yield，此处为占位
}

// utilityProcess 使用 parentPort 通信
try {
  // parentPort 仅存在于 utilityProcess 环境
  process.parentPort?.on('message', (e: { data: WorkerPayload }) => {
    if (e?.data?.wavPath) run(e.data)
  })
} catch {
  /* ignore */
}
