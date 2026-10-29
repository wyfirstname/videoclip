import { spawn } from 'child_process'
import * as path from 'path'
import * as fs from 'fs'
import { app } from 'electron'
import { getSettings } from './store'
import { buildConcatArgs, writeConcatList } from './concat'

const isWin = process.platform === 'win32'

// 真实 ffmpeg/ffprobe 二进制远大于 64KB；用于排除被误打包的脚本文件
const MIN_BIN_SIZE = 64 * 1024

function isUsableBinary(p: string): boolean {
  try {
    const st = fs.statSync(p)
    return st.isFile() && st.size > MIN_BIN_SIZE
  } catch {
    return false
  }
}

function fromResources(name: string): string | null {
  // 打包后的资源目录 / 开发时的 build 目录
  const candidates = [
    path.join(process.resourcesPath || '', 'ffmpeg-bin', name),
    path.join(app.getAppPath(), 'build', 'ffmpeg-bin', name)
  ]
  for (const c of candidates) {
    if (c && isUsableBinary(c)) return c
  }
  return null
}

function fromPath(name: string): string | null {
  try {
    const cmd = isWin ? 'where' : 'which'
    const out = require('child_process').execSync(`${cmd} ${name}`, { encoding: 'utf8' })
    const first = out.split(/\r?\n/).find(Boolean)
    return first && isUsableBinary(first) ? first : null
  } catch {
    return null
  }
}

export function resolveFfmpeg(): string {
  const settings = getSettings()
  if (settings.ffmpegPath) {
    if (!isUsableBinary(settings.ffmpegPath)) {
      throw new Error(`设置中的 FFmpeg 路径不可用: ${settings.ffmpegPath}`)
    }
    return settings.ffmpegPath
  }
  const bundled = fromResources(isWin ? 'ffmpeg.exe' : 'ffmpeg')
  if (bundled) return bundled
  const onPath = fromPath(isWin ? 'ffmpeg' : 'ffmpeg')
  if (onPath) return onPath
  throw new Error('未找到可用的 FFmpeg，请在「设置」中指定 FFmpeg 可执行文件路径')
}

export function resolveFfprobe(): string | null {
  return fromResources(isWin ? 'ffprobe.exe' : 'ffprobe') || fromPath(isWin ? 'ffprobe' : 'ffprobe')
}

export function checkFfmpeg(): { ffmpeg: string; ffprobe: string | null; ok: boolean } {
  let ffmpeg = ''
  try {
    ffmpeg = resolveFfmpeg()
  } catch {
    return { ffmpeg: '', ffprobe: resolveFfprobe(), ok: false }
  }
  const ffprobe = resolveFfprobe()
  let ok = false
  try {
    const out = require('child_process').execSync(`"${ffmpeg}" -version`, { encoding: 'utf8' })
    ok = out.startsWith('ffmpeg')
  } catch {
    ok = false
  }
  return { ffmpeg, ffprobe, ok }
}

function run(bin: string, args: string[], onLine?: (line: string) => void): Promise<number> {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args, { windowsHide: true })
    let stderrBuf = ''
    proc.stderr.on('data', (d: Buffer) => {
      const text = d.toString()
      stderrBuf += text
      if (stderrBuf.length > 50000) stderrBuf = stderrBuf.slice(-20000)
      if (onLine) onLine(text)
    })
    proc.on('close', (code) => resolve(code ?? -1))
    proc.on('error', (err) =>
      reject(new Error(`无法执行 FFmpeg (${bin}): ${err.message}`))
    )
    void stderrBuf
  })
}

/** 获取视频时长（秒），优先 ffprobe，失败则解析 ffmpeg 输出；任何异常都返回 0 */
export async function probeDuration(videoPath: string): Promise<number> {
  const ffprobe = resolveFfprobe()
  if (ffprobe) {
    try {
      const out = require('child_process').execSync(
        `"${ffprobe}" -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${videoPath}"`,
        { encoding: 'utf8' }
      )
      const d = parseFloat(out.trim())
      if (!isNaN(d) && d > 0) return d
    } catch {
      /* fallthrough */
    }
  }
  let ffmpeg: string
  try {
    ffmpeg = resolveFfmpeg()
  } catch {
    return 0
  }
  return new Promise((resolve) => {
    const proc = spawn(ffmpeg, ['-i', videoPath], { windowsHide: true })
    let out = ''
    proc.stderr.on('data', (d: Buffer) => (out += d.toString()))
    proc.on('close', () => {
      const m = out.match(/Duration:\s*(\d+):(\d+):(\d+\.?\d*)/)
      if (m) {
        resolve(parseInt(m[1]) * 3600 + parseInt(m[2]) * 60 + parseFloat(m[3]))
      } else {
        resolve(0)
      }
    })
    proc.on('error', () => resolve(0))
  })
}

/** 提取 16kHz 单声道 wav 音频 */
export async function extractAudio(videoPath: string, outWav: string): Promise<void> {
  const ffmpeg = resolveFfmpeg()
  const code = await run(ffmpeg, [
    '-y',
    '-i', videoPath,
    '-vn',
    '-ac', '1',
    '-ar', '16000',
    '-f', 'wav',
    outWav
  ])
  if (code !== 0) throw new Error(`音频提取失败 (ffmpeg exit ${code})`)
}

/** 切片导出 */
export async function cutClip(
  videoPath: string,
  start: number,
  end: number,
  outFile: string,
  precise: boolean
): Promise<void> {
  const ffmpeg = resolveFfmpeg()
  const duration = Math.max(0.5, end - start)
  const args = precise
    ? [
        '-y',
        '-ss', start.toFixed(3),
        '-t', duration.toFixed(3),
        '-i', videoPath,
        '-c:v', 'libx264',
        '-preset', 'veryfast',
        '-crf', '20',
        '-c:a', 'aac',
        '-b:a', '128k',
        '-movflags', '+faststart',
        outFile
      ]
    : [
        '-y',
        '-ss', start.toFixed(3),
        '-t', duration.toFixed(3),
        '-i', videoPath,
        '-c', 'copy',
        '-avoid_negative_ts', 'make_zero',
        outFile
      ]
  const code = await run(ffmpeg, args)
  if (code !== 0) throw new Error(`切片导出失败 (ffmpeg exit ${code})`)
}

/**
 * 把多个切片按顺序拼接成一个 MP4（切片合集）。
 * 入参应为本项目刚导出的切片文件 —— 同源、同编码参数，因此流复制即可无损拼接。
 * 精确模式直接重编码拼接；快速模式优先流复制，失败自动降级重编码（保证仍能出片）。
 */
export async function concatClips(
  inputs: string[],
  outFile: string,
  precise: boolean,
  listFile: string
): Promise<void> {
  if (inputs.length === 0) throw new Error('没有可拼接的切片')
  writeConcatList(listFile, inputs)

  const ffmpeg = resolveFfmpeg()
  const { primary, fallback } = buildConcatArgs(listFile, outFile, precise)

  const code = await run(ffmpeg, primary)
  if (code === 0) return
  if (!fallback) throw new Error(`切片合集拼接失败 (ffmpeg exit ${code})`)

  const retry = await run(ffmpeg, fallback)
  if (retry !== 0) throw new Error(`切片合集拼接失败 (ffmpeg exit ${retry})`)
}
