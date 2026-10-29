// 共享类型定义（主进程 / 渲染进程共用）

export interface LLMSettings {
  baseUrl: string
  apiKey: string
  model: string
  temperature: number
}

export interface AppSettings {
  llm: LLMSettings
  asr: {
    modelId: string
    numThreads: number
  }
  ffmpegPath: string
  outputDir: string
  downloadMirror: string
}

export interface ProjectMeta {
  id: string
  name: string
  videoPath: string
  duration: number
  createdAt: number
  hasSubtitles: boolean
  hasClips: boolean
  clipCount: number
}

export interface SubtitleSegment {
  start: number // 秒
  end: number // 秒
  text: string
}

export interface Clip {
  id: string
  title: string
  summary: string
  start: number
  end: number
  score: number
  reason: string
  selected: boolean
  edited: boolean // 用户手动调整过
  /** 切片来源：ai=模型分析，rule=规则兜底，manual=用户手工创建 */
  source?: 'ai' | 'rule' | 'manual'
}

export interface ProjectData extends ProjectMeta {
  clips: Clip[]
}

export interface AsrModelInfo {
  id: string
  name: string
  description: string
  sizeHint: string
  type: 'sense-voice' | 'paraformer'
  url: string
  dirName: string
  fileName: string
  downloaded: boolean
}

export interface ProgressEvent {
  channel: string
  projectId?: string
  modelId?: string
  percent: number
  stage: string
  detail?: string
  done?: boolean
  error?: string
}

/** 切片导出时的字幕处理方式 */
export type ClipSubtitleMode = 'none' | 'sidecar'

export interface ExportOptions {
  precise: boolean // true=重新编码（精确），false=流复制（快速）
  /** none=不生成任何字幕（默认，精确模式强制）；sidecar=额外生成外挂 SRT（不烧录进画面） */
  subtitleMode: ClipSubtitleMode
  includeJson: boolean
  /** 是否导出单个切片（逐个成片）。默认 true（不传时按旧行为），可与 mergeCollection 任选其一或全选 */
  individualClips?: boolean
  /** 是否把所有选中切片按顺序拼接成一个合集 MP4（00_切片合集.mp4） */
  mergeCollection?: boolean
}

/** 切片合集（所有选中切片按顺序拼接成的单个 MP4） */
export interface CollectionResult {
  path: string
  clipCount: number
  duration: number
}

export interface ExportResult {
  outputDir: string
  files: string[]
  failed: { id: string; title: string; error: string }[]
  /** 对本次导出的说明（例如精确模式已跳过字幕生成） */
  notes?: string[]
  /** 切片合集结果；未开启该选项或拼接失败时为 null */
  collection?: CollectionResult | null
}

/** 全部字幕导出格式 */
export type SubtitleFormat = 'srt' | 'txt' | 'json'

export interface SubtitleExportResult {
  path: string
  count: number
  format: SubtitleFormat
}

export interface ApiSnapshot {
  baseUrl: string
  apiKey: string
  model: string
}
