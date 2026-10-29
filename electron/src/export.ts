import * as path from 'path'
import * as fs from 'fs'
import { BrowserWindow, app } from 'electron'
import {
  ExportOptions,
  ExportResult,
  Clip,
  CollectionResult,
  SubtitleSegment,
  SubtitleFormat
} from '../../shared/types'
import { cutClip, concatClips, probeDuration } from './ffmpeg'
import { getProject, getProjectDir, getSettings, getSubtitles } from './store'
import {
  ensureDir,
  sanitizeFilename,
  secondsToSrtTime,
  normalizeSegments,
  buildSrt,
  buildPlainText,
  UTF8_BOM
} from './utils'

function sendProgress(projectId: string, payload: Record<string, unknown>): void {
  const win = BrowserWindow.getAllWindows()[0]
  if (win && !win.isDestroyed()) {
    win.webContents.send('progress-event', { channel: 'export:progress', projectId, ...payload })
  }
}

/** 切片合集文件名（00_ 前缀让它排在各切片之前，一眼可辨） */
const COLLECTION_NAME = '00_切片合集.mp4'
/** concat demuxer 的临时清单，拼接完即删 */
const COLLECTION_LIST = '.collection-list.txt'

export async function exportClips(
  projectId: string,
  options: ExportOptions
): Promise<ExportResult> {
  const project = getProject(projectId)
  if (!project) throw new Error('项目不存在')
  const clips = (project.clips || []).filter((c) => c.selected)
  if (!clips.length) throw new Error('没有勾选任何切片')

  // 两种产出可任选/全选：单个切片 + 切片合集
  const wantClips = options.individualClips !== false // 不传时按旧行为＝导出单切片
  const wantCollection = !!options.mergeCollection
  if (!wantClips && !wantCollection) {
    throw new Error('请至少选择一种导出内容（单个切片 / 切片合集）')
  }

  const settings = getSettings()
  const baseDir =
    settings.outputDir && fs.existsSync(settings.outputDir)
      ? settings.outputDir
      : app_downloads()
  const outputDir = path.join(baseDir, 'VClip', sanitizeFilename(project.name))
  ensureDir(outputDir)

  // 只导合集时，各切片只是拼接的中间产物：切到临时子目录，拼完整体清理，
  // 输出目录里只留一个合集文件，不会混进一堆碎切片。
  const partsDir = wantCollection && !wantClips ? path.join(outputDir, '.collection-parts') : null
  if (partsDir) ensureDir(partsDir)
  const clipOutDir = partsDir || outputDir

  const subtitles = getSubtitles(projectId)
  const files: string[] = []
  const failed: { id: string; title: string; error: string }[] = []
  const notes: string[] = []
  // clipId -> 切出的视频文件（避免用标题子串匹配导致错配）
  const fileOf = new Map<string, string>()

  // 精确模式（重新编码）一律不产出任何字幕文件：重编码后的时间基准与原字幕
  // 不完全一致，外挂 SRT 会出现整体偏移/错位，因此这里只导视频本体。
  // 只导合集时也不产逐切片字幕（那些切片不保留）。
  const wantSrt = options.subtitleMode === 'sidecar' && !options.precise && wantClips

  // 开启合集时给拼接阶段留出进度区间
  const clipBudget = wantCollection ? 88 : 95

  for (let i = 0; i < clips.length; i++) {
    const clip = clips[i]
    const idx = String(i + 1).padStart(2, '0')
    const name = `${idx}_${sanitizeFilename(clip.title)}.mp4`
    const outFile = path.join(clipOutDir, name)
    sendProgress(projectId, {
      percent: Math.floor((i / clips.length) * clipBudget),
      stage: wantClips
        ? `导出 ${i + 1}/${clips.length}: ${clip.title}`
        : `切出片段 ${i + 1}/${clips.length}: ${clip.title}（用于合集）`,
      detail: options.precise
        ? '精确模式（重新编码 · 不附带字幕）'
        : wantSrt
          ? '快速模式（流复制 · 附带 SRT）'
          : '快速模式（流复制）'
    })
    try {
      await cutClip(project.videoPath, clip.start, clip.end, outFile, options.precise)
      fileOf.set(clip.id, outFile)

      if (wantClips) {
        files.push(outFile)
        if (wantSrt) {
          const srtFile = outFile.replace(/\.mp4$/, '.srt')
          if (writeClipSrt(subtitles, clip, srtFile)) files.push(srtFile)
        }
      }
    } catch (err) {
      failed.push({
        id: clip.id,
        title: clip.title,
        error: err instanceof Error ? err.message : String(err)
      })
    }
  }

  // ---- 切片合集：把成功切出的片段按切片顺序拼成一个 MP4 ----
  let collection: CollectionResult | null = null
  if (wantCollection) {
    // 用 fileOf 取文件，保证顺序与切片列表一致（失败/跳过的切片不会混进来）
    const ordered = clips
      .map((c) => fileOf.get(c.id))
      .filter((f): f is string => typeof f === 'string' && fs.existsSync(f))

    if (!ordered.length) {
      notes.push('切片合集未生成：本次没有任何成功导出的切片')
    } else {
      sendProgress(projectId, {
        percent: 92,
        stage: `拼接切片合集（${ordered.length} 段）`,
        detail: options.precise ? '重编码拼接' : '流复制拼接（失败自动降级重编码）'
      })
      const collectionFile = path.join(outputDir, COLLECTION_NAME)
      const listFile = path.join(outputDir, COLLECTION_LIST)
      try {
        await concatClips(ordered, collectionFile, options.precise, listFile)
        const duration = await probeDuration(collectionFile)
        files.push(collectionFile)
        collection = { path: collectionFile, clipCount: ordered.length, duration }
        notes.push(
          `切片合集已生成：${COLLECTION_NAME}（${ordered.length} 段，约 ${duration.toFixed(1)} 秒）`
        )
      } catch (err) {
        // 合集失败不影响单个切片，降级为只提示
        const msg = err instanceof Error ? err.message : String(err)
        notes.push(`切片合集生成失败（单个切片不受影响）：${msg}`)
      } finally {
        try {
          fs.rmSync(listFile, { force: true })
        } catch {
          /* 清单文件残留无害 */
        }
      }
    }
  }

  // 清掉「只导合集」时的中间切片
  if (partsDir) {
    try {
      fs.rmSync(partsDir, { recursive: true, force: true })
    } catch {
      /* 残留无害，输出目录已含合集 */
    }
  }

  if (options.includeJson) {
    const jsonFile = path.join(outputDir, 'clips.json')
    fs.writeFileSync(
      jsonFile,
      JSON.stringify(
        clips.map((c) => ({
          title: c.title,
          summary: c.summary,
          start: secondsToSrtTime(c.start),
          end: secondsToSrtTime(c.end),
          score: c.score,
          reason: c.reason,
          // 只导合集时切片文件未保留，这里记 null（避免指向已清理的临时文件）
          file: wantClips ? fileOf.get(c.id) || null : null
        })),
        null,
        2
      ),
      'utf-8'
    )
    files.push(jsonFile)
  }

  if (options.precise) {
    notes.push('精确模式不生成任何字幕文件（既不做外挂 SRT，也不烧录进画面）')
  }
  if (failed.length) notes.push(`${failed.length} 个切片导出失败，详见失败列表`)

  sendProgress(projectId, {
    percent: 100,
    stage: failed.length ? `导出完成，${failed.length} 个失败` : '导出完成',
    done: true
  })
  return { outputDir, files, failed, notes, collection }
}

function app_downloads(): string {
  return app.getPath('videos') || app.getPath('home')
}

/**
 * 生成某个切片的外挂 SRT。
 * 时间基准统一换算为「相对切片起点」，并做边界裁剪 + 去重 + 单调化，
 * 避免出现负数时间码、重叠条或零时长条。返回是否真的写入了文件。
 */
function writeClipSrt(subtitles: SubtitleSegment[], clip: Clip, srtFile: string): boolean {
  const raw = subtitles
    .filter((s) => s.end > clip.start + 0.02 && s.start < clip.end - 0.02)
    .map((s) => ({
      start: Math.max(0, s.start - clip.start),
      end: Math.min(clip.end - clip.start, s.end - clip.start),
      text: s.text
    }))
    .filter((s) => s.end - s.start > 0.1)

  const segs = normalizeSegments(raw)
  if (!segs.length) return false

  const body = segs
    .map((s, i) => `${i + 1}\n${secondsToSrtTime(s.start)} --> ${secondsToSrtTime(s.end)}\n${s.text}\n`)
    .join('\n')
  fs.writeFileSync(srtFile, UTF8_BOM + body, 'utf-8')
  return true
}

const SUBTITLE_FILTERS: Record<SubtitleFormat, { name: string; extensions: string[] }> = {
  srt: { name: 'SRT 字幕', extensions: ['srt'] },
  txt: { name: '纯文本（带时间码）', extensions: ['txt'] },
  json: { name: 'JSON 数据', extensions: ['json'] }
}

export function subtitleFilter(format: SubtitleFormat): { name: string; extensions: string[] } {
  return SUBTITLE_FILTERS[format]
}

/** 把整份字幕序列化成字符串（含 UTF-8 BOM，保证中文不乱码） */
export function serializeSubtitles(
  segments: SubtitleSegment[],
  format: SubtitleFormat
): string {
  const clean = normalizeSegments(segments)
  if (format === 'json') {
    return JSON.stringify(
      clean.map((s, i) => ({
        index: i + 1,
        start: secondsToSrtTime(s.start),
        end: secondsToSrtTime(s.end),
        startSec: Number(s.start.toFixed(3)),
        endSec: Number(s.end.toFixed(3)),
        text: s.text
      })),
      null,
      2
    )
  }
  if (format === 'txt') return UTF8_BOM + buildPlainText(clean) + '\n'
  return UTF8_BOM + buildSrt(clean)
}

/** 导出一份完整字幕到指定路径，返回写入条数 */
export function writeAllSubtitles(
  filePath: string,
  segments: SubtitleSegment[],
  format: SubtitleFormat
): number {
  const clean = normalizeSegments(segments)
  fs.writeFileSync(filePath, serializeSubtitles(clean, format), 'utf-8')
  return clean.length
}

export function getProjectMediaDir(projectId: string): string {
  return getProjectDir(projectId)
}
