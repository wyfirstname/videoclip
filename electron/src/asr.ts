import { utilityProcess } from 'electron'
import * as path from 'path'
import * as fs from 'fs'
import { BrowserWindow } from 'electron'
import { SubtitleSegment } from '../../shared/types'
import { extractAudio } from './ffmpeg'
import { getSettings, getProjectDataDir } from './store'
import { resolveModelFiles, resolveAvailableModelId, resolveVadModelPath, VAD_MODEL_NAME } from './models'

function sendProgress(projectId: string, payload: Record<string, unknown>): void {
  const win = BrowserWindow.getAllWindows()[0]
  if (win && !win.isDestroyed()) {
    win.webContents.send('progress-event', { channel: 'transcribe:progress', projectId, ...payload })
  }
}

export async function transcribe(projectId: string, videoPath: string): Promise<SubtitleSegment[]> {
  const settings = getSettings()
  const { id: modelId, fallback } = resolveAvailableModelId(settings.asr.modelId)
  if (fallback) {
    console.warn(`[asr] 设置中的模型 ${settings.asr.modelId} 未下载，自动改用 ${modelId}`)
  }
  const { modelPath, tokensPath, type } = resolveModelFiles(modelId)

  const dir = getProjectDataDir(projectId)
  const wavPath = path.join(dir, 'audio.wav')

  sendProgress(projectId, { percent: 1, stage: '提取音频...' })
  await extractAudio(videoPath, wavPath)

  const vadCandidate = resolveVadModelPath()
  const vadPath = fs.existsSync(vadCandidate) ? vadCandidate : null

  return new Promise<SubtitleSegment[]>((resolve, reject) => {
    const workerPath = path.join(__dirname, 'asr-worker.js')
    const child = utilityProcess.fork(workerPath, [], { serviceName: 'vclip-asr' })

    const timeout = setTimeout(() => {
      child.kill()
      reject(new Error('识别超时'))
    }, 1000 * 60 * 60 * 4) // 4 小时兜底

    child.on('message', (msg: Record<string, unknown>) => {
      const type = msg.type as string
      if (type === 'progress') {
        sendProgress(projectId, msg)
      } else if (type === 'done') {
        clearTimeout(timeout)
        child.kill()
        resolve(msg.segments as SubtitleSegment[])
      } else if (type === 'error') {
        clearTimeout(timeout)
        child.kill()
        reject(new Error(String(msg.message)))
      }
    })
    child.on('exit', (code) => {
      clearTimeout(timeout)
      reject(new Error(`识别进程异常退出 (code ${code})`))
    })

    child.postMessage({
      wavPath,
      modelPath,
      tokensPath,
      type,
      numThreads: settings.asr.numThreads,
      vadPath
    })
  })
}
