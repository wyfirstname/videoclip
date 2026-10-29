import * as fs from 'fs'
import * as path from 'path'
import { spawn } from 'child_process'
import { BrowserWindow } from 'electron'
import { AsrModelInfo } from '../../shared/types'
import { getModelsDir, getBundledModelsDir, getSettings } from './store'
import { ensureDir } from './utils'

const ASR_MODEL_BASE = 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models'

interface ModelDef extends Omit<AsrModelInfo, 'downloaded'> {
  extractDir?: string // tar 包内的顶层目录名
}

const MODEL_DEFS: ModelDef[] = [
  {
    id: 'sense-voice-small',
    name: 'SenseVoice Small（推荐）',
    description: 'FunASR 系列多语种模型，支持中/英/日/韩/粤语，自动标点，速度快精度高',
    sizeHint: '约 240MB',
    type: 'sense-voice',
    url: `${ASR_MODEL_BASE}/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17.tar.bz2`,
    dirName: 'sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17',
    fileName: 'model.int8.onnx',
    extractDir: 'sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17'
  },
  {
    id: 'paraformer-zh',
    name: 'FunASR Paraformer 中文大模型',
    description: '阿里 FunASR Paraformer 大模型，中文识别精准',
    sizeHint: '约 230MB',
    type: 'paraformer',
    url: `${ASR_MODEL_BASE}/sherpa-onnx-paraformer-zh-2023-09-14.tar.bz2`,
    dirName: 'sherpa-onnx-paraformer-zh-2023-09-14',
    fileName: 'model.int8.onnx',
    extractDir: 'sherpa-onnx-paraformer-zh-2023-09-14'
  },
  {
    id: 'paraformer-zh-small',
    name: 'FunASR Paraformer 中文小型',
    description: 'Paraformer 轻量版，下载更快、识别速度快，精度略低',
    sizeHint: '约 90MB',
    type: 'paraformer',
    url: `${ASR_MODEL_BASE}/sherpa-onnx-paraformer-zh-small-2024-03-09.tar.bz2`,
    dirName: 'sherpa-onnx-paraformer-zh-small-2024-03-09',
    fileName: 'model.int8.onnx',
    extractDir: 'sherpa-onnx-paraformer-zh-small-2024-03-09'
  }
]

export const VAD_MODEL_NAME = 'silero_vad.onnx'
export const VAD_MODEL_URL = `${ASR_MODEL_BASE}/silero_vad.onnx`

export function getModelDir(id: string): string {
  return path.join(getModelsDir(), id)
}

/**
 * 解析某个模型的实际目录：userData 优先（用户重新下载/更新的版本），
 * 其次安装包内预置模型（extraResources），都没有则返回 userData 路径（供下载后使用）。
 */
export function resolveModelDir(id: string): string {
  const local = path.join(getModelsDir(), id)
  if (fs.existsSync(local)) return local
  const bundled = getBundledModelsDir()
  if (bundled) {
    const p = path.join(bundled, id)
    if (fs.existsSync(p)) return p
  }
  return local
}

/** VAD 模型实际路径（同样 userData 优先、预置兜底） */
export function resolveVadModelPath(): string {
  const local = path.join(getModelsDir(), VAD_MODEL_NAME)
  if (fs.existsSync(local)) return local
  const bundled = getBundledModelsDir()
  if (bundled) {
    const p = path.join(bundled, VAD_MODEL_NAME)
    if (fs.existsSync(p)) return p
  }
  return local
}

function isDownloaded(def: ModelDef): boolean {
  return fs.existsSync(path.join(resolveModelDir(def.id), def.fileName))
}

export function listModels(): AsrModelInfo[] {
  return MODEL_DEFS.map((def) => ({
    id: def.id,
    name: def.name,
    description: def.description,
    sizeHint: def.sizeHint,
    type: def.type,
    url: def.url,
    dirName: def.dirName,
    fileName: def.fileName,
    downloaded: isDownloaded(def)
  }))
}

function sendProgress(channel: string, payload: Record<string, unknown>): void {
  const win = BrowserWindow.getAllWindows()[0]
  if (win && !win.isDestroyed()) {
    win.webContents.send('progress-event', { channel, ...payload })
  }
}

/** 下载文件（支持镜像前缀），汇报进度 */
async function downloadFile(url: string, dest: string, channel: string, tag: string): Promise<void> {
  const settings = getSettings()
  const finalUrl = settings.downloadMirror ? settings.downloadMirror.replace(/\/$/, '') + '/' + url : url
  ensureDir(path.dirname(dest))

  const res = await fetch(finalUrl, { redirect: 'follow' })
  if (!res.ok || !res.body) throw new Error(`下载失败: HTTP ${res.status} (${finalUrl})`)

  const total = Number(res.headers.get('content-length') || 0)
  const fileStream = fs.createWriteStream(dest)
  let received = 0
  let lastPct = -1

  const reader = res.body.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    received += value.byteLength
    fileStream.write(Buffer.from(value))
    if (total > 0) {
      const pct = Math.floor((received / total) * 100)
      if (pct !== lastPct) {
        lastPct = pct
        sendProgress(channel, {
          modelId: tag,
          percent: pct,
          stage: `下载中 ${pct}%`,
          detail: `${(received / 1024 / 1024).toFixed(1)} / ${(total / 1024 / 1024).toFixed(1)} MB`
        })
      }
    }
  }
  await new Promise<void>((resolve, reject) => {
    fileStream.end((err?: Error | null) => (err ? reject(err) : resolve()))
  })
  sendProgress(channel, { modelId: tag, percent: 100, stage: '下载完成' })
}

/** 使用系统 tar 解压 .tar.bz2（Windows 10+/macOS/Linux 均自带） */
function extractTarBz2(archive: string, destDir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const tar = process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar'
    const proc = spawn(tar, ['-xjf', archive, '-C', destDir], { windowsHide: true })
    let err = ''
    proc.stderr.on('data', (d: Buffer) => (err += d.toString()))
    proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`解压失败 (tar exit ${code}): ${err}`))))
    proc.on('error', reject)
  })
}

export async function downloadModel(modelId: string): Promise<void> {
  const def = MODEL_DEFS.find((m) => m.id === modelId)
  if (!def) throw new Error(`未知模型: ${modelId}`)
  if (isDownloaded(def)) return

  const channel = 'models:progress'
  try {
    // 1. 模型包
    sendProgress(channel, { modelId, percent: 0, stage: '开始下载模型' })
    const archive = path.join(getModelsDir(), `${def.dirName}.tar.bz2`)
    await downloadFile(def.url, archive, channel, modelId)
    sendProgress(channel, { modelId, percent: 100, stage: '解压模型包...' })
    await extractTarBz2(archive, getModelsDir())
    fs.rmSync(archive, { force: true })
    // tar 包内有一层目录，移动到 models/<id>
    const inner = path.join(getModelsDir(), def.extractDir || def.dirName)
    const target = getModelDir(modelId)
    if (path.resolve(inner) !== path.resolve(target) && fs.existsSync(inner)) {
      fs.rmSync(target, { recursive: true, force: true })
      fs.renameSync(inner, target)
    }
    if (!isDownloaded(def)) throw new Error('模型文件缺失，解压结果异常')

    // 2. VAD 模型（小文件，用于语音分段）——预置了就不再下载
    if (!fs.existsSync(resolveVadModelPath())) {
      const vadPath = path.join(getModelsDir(), VAD_MODEL_NAME)
      sendProgress(channel, { modelId, percent: 0, stage: '下载语音检测模型 (VAD)...' })
      await downloadFile(VAD_MODEL_URL, vadPath, channel, modelId)
    }

    sendProgress(channel, { modelId, percent: 100, stage: '模型就绪', done: true })
  } catch (err) {
    sendProgress(channel, {
      modelId,
      percent: 0,
      stage: '下载失败',
      error: err instanceof Error ? err.message : String(err),
      done: true
    })
    throw err
  }
}

export function deleteModel(modelId: string): void {
  const def = MODEL_DEFS.find((m) => m.id === modelId)
  if (!def) return
  fs.rmSync(getModelDir(modelId), { recursive: true, force: true })
}

/** 解析当前设置所用模型的具体文件路径 */
export function resolveModelFiles(modelId: string): { modelPath: string; tokensPath: string; type: string } {
  const def = MODEL_DEFS.find((m) => m.id === modelId)
  if (!def) throw new Error(`未知模型: ${modelId}`)
  const dir = resolveModelDir(modelId)
  const modelPath = path.join(dir, def.fileName)
  const tokensPath = path.join(dir, 'tokens.txt')
  if (!fs.existsSync(modelPath) || !fs.existsSync(tokensPath)) {
    throw new Error(`模型尚未下载，请在设置中先下载模型: ${def.name}`)
  }
  return { modelPath, tokensPath, type: def.type }
}

/**
 * 选择实际可用的模型：优先设置项，未下载时自动回退到任一已下载模型
 */
export function resolveAvailableModelId(preferred: string): { id: string; fallback: boolean } {
  const def = MODEL_DEFS.find((m) => m.id === preferred)
  if (def && isDownloaded(def)) return { id: preferred, fallback: false }
  const fallback = MODEL_DEFS.find((m) => isDownloaded(m))
  if (fallback) return { id: fallback.id, fallback: true }
  throw new Error('尚未下载任何语音识别模型，请到「设置 → 语音识别模型」中下载后再试')
}
