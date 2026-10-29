import * as path from 'path'
import * as fs from 'fs'

export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true })
}

export function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8')) as T
  } catch {
    return fallback
  }
}

export function writeJson(file: string, data: unknown): void {
  ensureDir(path.dirname(file))
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf-8')
}

/** 秒 -> HH:MM:SS,mmm (SRT 格式) */
export function secondsToSrtTime(sec: number): string {
  const ms = Math.max(0, Math.round(sec * 1000))
  const h = Math.floor(ms / 3600000)
  const m = Math.floor((ms % 3600000) / 60000)
  const s = Math.floor((ms % 60000) / 1000)
  const mm = ms % 1000
  const p = (n: number, w = 2): string => String(n).padStart(w, '0')
  return `${p(h)}:${p(m)}:${p(s)},${p(mm, 3)}`
}

/** 秒 -> mm:ss 或 h:mm:ss (显示用) */
export function formatDuration(sec: number): string {
  const s = Math.max(0, Math.floor(sec))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = s % 60
  const p = (n: number): string => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${p(m)}:${p(ss)}` : `${m}:${p(ss)}`
}

/** "HH:MM:SS,mmm" 或 "HH:MM:SS.mmm" 或 "mm:ss" -> 秒 */
export function timeToSeconds(t: string): number {
  const str = String(t || '').trim().replace(',', '.')
  const parts = str.split(':').map((x) => parseFloat(x))
  if (parts.some((n) => isNaN(n))) return 0
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + (parts[2] || 0)
  if (parts.length === 2) return parts[0] * 60 + (parts[1] || 0)
  return parts[0] || 0
}

/** UTF-8 BOM：Windows 上多数播放器/记事本靠它识别 UTF-8，缺了会显示成乱码 */
export const UTF8_BOM = '\uFEFF'

/** 清洗字幕段：排序、修正负时长/零时长、丢弃空文本与完全重复项 */
export function normalizeSegments<T extends { start: number; end: number; text: string }>(
  segments: T[]
): T[] {
  const out: T[] = []
  const seen = new Set<string>()
  for (const s of [...segments].sort((a, b) => a.start - b.start)) {
    const start = Math.max(0, Number(s.start) || 0)
    const end = Math.max(start + 0.05, Number(s.end) || 0)
    const text = String(s.text || '').replace(/\s+/g, ' ').trim()
    if (!text) continue
    const key = `${start.toFixed(2)}|${end.toFixed(2)}|${text}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ ...s, start, end, text })
  }
  return out
}

/** 字幕段 -> SRT 文本（不含 BOM，序号自动重排） */
export function buildSrt(segments: { start: number; end: number; text: string }[]): string {
  return normalizeSegments(segments)
    .map((s, i) => `${i + 1}\n${secondsToSrtTime(s.start)} --> ${secondsToSrtTime(s.end)}\n${s.text}\n`)
    .join('\n')
}

/** 字幕段 -> 带时间码的纯文本 */
export function buildPlainText(segments: { start: number; end: number; text: string }[]): string {
  return normalizeSegments(segments)
    .map((s) => `[${formatDuration(s.start)}] ${s.text}`)
    .join('\n')
}

export function sanitizeFilename(name: string): string {
  return String(name || 'clip')
    .replace(/[\\/:*?"<>|\r\n]+/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80)
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
