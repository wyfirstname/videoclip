import { app } from 'electron'
import * as path from 'path'
import * as fs from 'fs'
import { AppSettings, ProjectData, ProjectMeta, SubtitleSegment, Clip } from '../../shared/types'
import { readJson, writeJson, ensureDir, buildSrt, UTF8_BOM } from './utils'

export const DEFAULT_SETTINGS: AppSettings = {
  llm: {
    baseUrl: 'https://api.deepseek.com/v1',
    apiKey: '',
    model: 'deepseek-chat',
    temperature: 0.4
  },
  asr: {
    modelId: 'sense-voice-small',
    numThreads: 4
  },
  ffmpegPath: '',
  outputDir: '',
  downloadMirror: ''
}

export function getUserDataDir(): string {
  return app.getPath('userData')
}

export function getProjectsRoot(): string {
  return path.join(getUserDataDir(), 'projects')
}

export function getProjectDir(id: string): string {
  return path.join(getProjectsRoot(), id)
}

export function getSettingsFile(): string {
  return path.join(getUserDataDir(), 'settings.json')
}

export function getModelsDir(): string {
  return path.join(getUserDataDir(), 'models')
}

/**
 * 包内预置模型目录（随安装包通过 extraResources 打入）：
 * - 打包态：安装目录/resources/models
 * - 开发态：项目根 models/（开发时免去往 userData 复制）
 * 不存在返回 null。
 */
export function getBundledModelsDir(): string | null {
  const appPath = app.getAppPath()
  const candidates = [
    process.resourcesPath ? path.join(process.resourcesPath, 'models') : '',
    path.join(appPath, 'models'),
    // e2e 探针以 require(app.asar/out/main/index.js) 方式运行时，
    // getAppPath 是 .../resources/app.asar，预置模型在其同级的 resources/models
    path.join(path.dirname(appPath), 'models')
  ]
  const seen = new Set<string>()
  for (const c of candidates) {
    if (!c || seen.has(c)) continue
    seen.add(c)
    try {
      if (
        fs.existsSync(c) &&
        (fs.existsSync(path.join(c, 'silero_vad.onnx')) ||
          fs.existsSync(path.join(c, 'sense-voice-small', 'model.int8.onnx')))
      ) {
        return c
      }
    } catch {
      /* ignore */
    }
  }
  return null
}

export function getSettings(): AppSettings {
  const saved = readJson<Partial<AppSettings>>(getSettingsFile(), {})
  return {
    ...DEFAULT_SETTINGS,
    ...saved,
    llm: { ...DEFAULT_SETTINGS.llm, ...(saved.llm || {}) },
    asr: { ...DEFAULT_SETTINGS.asr, ...(saved.asr || {}) }
  }
}

export function saveSettings(settings: AppSettings): AppSettings {
  writeJson(getSettingsFile(), settings)
  return settings
}

const projectsIndexFile = (): string => path.join(getProjectsRoot(), 'index.json')

/** 修正历史数据里 hasClips 与实际数量不一致的状态（旧版本空结果被标记为已完成） */
function normalizeMeta(m: ProjectMeta): ProjectMeta {
  const count = typeof m.clipCount === 'number' ? m.clipCount : 0
  return { ...m, clipCount: count, hasClips: count > 0 }
}

export function listProjects(): ProjectMeta[] {
  return readJson<ProjectMeta[]>(projectsIndexFile(), []).map(normalizeMeta)
}

export function saveProjectIndex(list: ProjectMeta[]): void {
  writeJson(projectsIndexFile(), list)
}

export function getProjectDataDir(id: string): string {
  const dir = getProjectDir(id)
  ensureDir(dir)
  return dir
}

export function getProject(id: string): ProjectData | null {
  const file = path.join(getProjectDir(id), 'project.json')
  if (!fs.existsSync(file)) return null
  const data = readJson<ProjectData | null>(file, null)
  if (!data) return null
  // clips.json 是切片数据的主存储；只有它不存在时才回退到 project.json 里的副本
  const clipsFile = path.join(getProjectDir(id), 'clips.json')
  const clips = fs.existsSync(clipsFile)
    ? readJson<Clip[]>(clipsFile, [])
    : Array.isArray(data.clips)
      ? data.clips
      : []
  return { ...normalizeMeta(data), clips, hasClips: clips.length > 0, clipCount: clips.length }
}

export function saveProject(project: ProjectData): void {
  writeJson(path.join(getProjectDir(project.id), 'project.json'), project)
  // 同步索引
  const list = listProjects().filter((p) => p.id !== project.id)
  list.unshift({
    id: project.id,
    name: project.name,
    videoPath: project.videoPath,
    duration: project.duration,
    createdAt: project.createdAt,
    hasSubtitles: project.hasSubtitles,
    hasClips: project.hasClips,
    clipCount: project.clips ? project.clips.length : 0
  })
  saveProjectIndex(list)
}

export function deleteProject(id: string): void {
  const dir = getProjectDir(id)
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
  saveProjectIndex(listProjects().filter((p) => p.id !== id))
}

export function getSubtitles(id: string): SubtitleSegment[] {
  return readJson<SubtitleSegment[]>(path.join(getProjectDir(id), 'subtitles.json'), [])
}

export function saveSubtitles(id: string, segments: SubtitleSegment[]): void {
  writeJson(path.join(getProjectDir(id), 'subtitles.json'), segments)
  // 同时导出一份 SRT（带 BOM，避免中文在部分播放器里乱码）
  fs.writeFileSync(
    path.join(getProjectDir(id), 'subtitles.srt'),
    UTF8_BOM + buildSrt(segments),
    'utf-8'
  )
}

export function getClips(id: string): Clip[] {
  return readJson<Clip[]>(path.join(getProjectDir(id), 'clips.json'), [])
}

export function saveClips(id: string, clips: Clip[]): void {
  writeJson(path.join(getProjectDir(id), 'clips.json'), clips)
}
