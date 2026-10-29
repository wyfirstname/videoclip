import { BrowserWindow } from 'electron'
import { randomUUID } from 'crypto'
import { Clip, SubtitleSegment } from '../../shared/types'
import { getSettings, getSubtitles, getClips, saveClips, getProject } from './store'
import { LlmClient, extractJsonArray } from './llm'
import { buildClipAnalysisPrompt } from './prompts'
import { adaptiveDurations, ruleBasedClips, DurationRange } from './rules'
import { timeToSeconds, secondsToSrtTime } from './utils'

const MAX_CHARS_PER_BLOCK = 6000
/** 两个切片重叠超过该秒数视为重复 */
const DUP_OVERLAP_SECONDS = 15

export interface AnalyzeResult {
  clips: Clip[]
  /** 是否使用了规则兜底 */
  usedRuleFallback: boolean
  /** 说明信息，便于前端展示原因 */
  message: string
}

function sendProgress(projectId: string, payload: Record<string, unknown>): void {
  const win = BrowserWindow.getAllWindows()[0]
  if (win && !win.isDestroyed()) {
    win.webContents.send('progress-event', { channel: 'analyze:progress', projectId, ...payload })
  }
}

/** 把字幕段按字符量分块 */
export function chunkSegments(segments: SubtitleSegment[]): SubtitleSegment[][] {
  const blocks: SubtitleSegment[][] = []
  let current: SubtitleSegment[] = []
  let chars = 0
  for (const seg of segments) {
    if (chars + seg.text.length > MAX_CHARS_PER_BLOCK && current.length > 0) {
      blocks.push(current)
      current = []
      chars = 0
    }
    current.push(seg)
    chars += seg.text.length
  }
  if (current.length) blocks.push(current)
  return blocks
}

function round1(n: number): number {
  return Math.round(n * 10) / 10
}

/**
 * 校验并规整 LLM 返回的切片。
 * 时长阈值由 range 决定（随视频总长自适应），不再硬编码，
 * 否则短视频（<15s）会被全部丢弃。
 */
export function normalizeClips(
  raw: unknown[],
  block: SubtitleSegment[],
  blockStart: number,
  blockEnd: number,
  range: DurationRange
): Clip[] {
  const clips: Clip[] = []
  const blockSpan = Math.max(0, blockEnd - blockStart)
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const obj = item as Record<string, unknown>
    const start = timeToSeconds(String(obj.start_time || obj.start || ''))
    const end = timeToSeconds(String(obj.end_time || obj.end || ''))
    const title = String(obj.title || obj.outline || '').trim()
    if (!title) continue
    // 短视频场景下 blockSpan 可能小于最小切片时长，此时以 block 为界放宽
    const minAllowed = Math.min(range.min, blockSpan * 0.9)
    if (end - start < minAllowed) continue
    // 限制在块范围内
    const s = Math.max(blockStart, Math.min(start, Math.max(blockStart, blockEnd - 0.5)))
    const e = Math.max(s + 0.5, Math.min(end, blockEnd))
    clips.push({
      id: randomUUID().slice(0, 8),
      title,
      summary: String(obj.summary || '').trim(),
      start: round1(s),
      end: round1(e),
      score: Math.max(0, Math.min(1, Number(obj.score) || 0)),
      reason: String(obj.reason || obj.recommend_reason || '').trim(),
      selected: true,
      edited: false,
      source: 'ai'
    })
  }
  // 去重：按重叠判定，保留先出现的（时间排序）
  clips.sort((a, b) => a.start - b.start)
  const dedup: Clip[] = []
  const overlapLimit = Math.min(DUP_OVERLAP_SECONDS, Math.max(1, blockSpan * 0.3))
  for (const c of clips) {
    const overlap = dedup.some(
      (d) => Math.min(d.end, c.end) - Math.max(d.start, c.start) > overlapLimit
    )
    if (!overlap) dedup.push(c)
  }
  void block
  return dedup
}

/** AI 分析：字幕 -> 切片建议（LLM 无产出时自动规则兜底） */
export async function analyzeProject(projectId: string): Promise<AnalyzeResult> {
  const project = getProject(projectId)
  if (!project) throw new Error('项目不存在')
  const segments = getSubtitles(projectId)
  if (!segments.length) throw new Error('请先完成字幕识别')

  const settings = getSettings()
  if (!settings.llm.apiKey) throw new Error('请先在设置中配置 AI (LLM) API Key')

  const totalDuration =
    project.duration || (segments.length ? segments[segments.length - 1].end : 0)
  const range = adaptiveDurations(totalDuration)

  const client = new LlmClient(settings.llm)
  const prompt = buildClipAnalysisPrompt(totalDuration)

  const blocks = chunkSegments(segments)
  const existing = getClips(projectId)
  const allClips: Clip[] = [...existing]

  let parseFailures = 0
  const pushUnique = (candidates: Clip[]): number => {
    let added = 0
    for (const c of candidates) {
      const dup = allClips.some(
        (d) => Math.min(d.end, c.end) - Math.max(d.start, c.start) > DUP_OVERLAP_SECONDS
      )
      if (!dup) {
        allClips.push(c)
        added++
      }
    }
    return added
  }

  let addedByModel = 0

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i]
    const blockStart = block[0].start
    const blockEnd = block[block.length - 1].end
    sendProgress(projectId, {
      percent: Math.floor((i / blocks.length) * 95),
      stage: `AI 分析中 (${i + 1}/${blocks.length})...`,
      detail: `当前块 ${secondsToSrtTime(blockStart)} - ${secondsToSrtTime(blockEnd)}`
    })

    const payload = {
      video_name: project.name,
      video_duration: secondsToSrtTime(totalDuration),
      segments: block.map((s, idx) => ({
        index: idx + 1,
        start: secondsToSrtTime(s.start).replace(',', '.'),
        end: secondsToSrtTime(s.end).replace(',', '.'),
        text: s.text
      }))
    }

    let raw: unknown[] | null = null
    let lastError = ''
    for (let attempt = 0; attempt < 2 && !raw; attempt++) {
      const response = await client.chat(prompt, payload)
      raw = extractJsonArray(response)
      if (!raw) lastError = response.slice(0, 200)
    }
    if (!raw) {
      parseFailures++
      sendProgress(projectId, {
        percent: Math.floor(((i + 1) / blocks.length) * 95),
        stage: `块 ${i + 1} 解析失败，已跳过`,
        detail: lastError
      })
      continue
    }

    const blockClips = normalizeClips(raw, block, blockStart, blockEnd, range)
    addedByModel += pushUnique(blockClips)
  }

  // ---- 兜底：模型完全没有产出（返回空数组 / 解析失败）时用规则切片，保证有结果可用 ----
  let usedRuleFallback = false
  if (allClips.length === 0) {
    const ruleClips = ruleBasedClips(segments, {
      min: range.min,
      target: range.target,
      max: range.max
    })
    pushUnique(ruleClips)
    usedRuleFallback = allClips.length > 0
  }

  allClips.sort((a, b) => a.start - b.start)
  saveClips(projectId, allClips)

  let message = `AI 分析完成，共 ${allClips.length} 个切片`
  if (usedRuleFallback) {
    message =
      parseFailures > 0
        ? `AI 返回内容无法解析，已用规则切片生成 ${allClips.length} 个候选（可手动调整）`
        : `AI 判断该素材没有突出片段（内容较短或信息密度低），已用规则切片生成 ${allClips.length} 个候选（可手动调整）`
  } else if (addedByModel === 0 && existing.length > 0) {
    message = `本次未新增切片，保留已有 ${allClips.length} 个切片`
  }

  sendProgress(projectId, { percent: 100, stage: message, done: true })
  return { clips: allClips, usedRuleFallback, message }
}

/** 纯规则切片：不需要 LLM，也不覆盖已有切片（追加） */
export async function analyzeByRules(projectId: string): Promise<AnalyzeResult> {
  const project = getProject(projectId)
  if (!project) throw new Error('项目不存在')
  const segments = getSubtitles(projectId)
  if (!segments.length) throw new Error('请先完成字幕识别')

  const totalDuration =
    project.duration || (segments.length ? segments[segments.length - 1].end : 0)
  const range = adaptiveDurations(totalDuration)

  const existing = getClips(projectId)
  const allClips = [...existing]
  const ruleClips = ruleBasedClips(segments, {
    min: range.min,
    target: range.target,
    max: range.max
  })

  for (const c of ruleClips) {
    const dup = allClips.some(
      (d) => Math.min(d.end, c.end) - Math.max(d.start, c.start) > DUP_OVERLAP_SECONDS
    )
    if (!dup) allClips.push(c)
  }

  allClips.sort((a, b) => a.start - b.start)
  saveClips(projectId, allClips)
  const message = `规则切片完成，共 ${allClips.length} 个切片（按语义边界自动聚合）`
  sendProgress(projectId, { percent: 100, stage: message, done: true })
  return { clips: allClips, usedRuleFallback: true, message }
}
