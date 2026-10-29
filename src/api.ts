// 渲染进程 API 封装
import type { AppSettings, ProjectData, ProjectMeta, SubtitleSegment, Clip, ExportOptions, ExportResult, AsrModelInfo, SubtitleFormat, SubtitleExportResult } from '../shared/types'

export interface ProgressEventPayload {
  channel: string
  projectId?: string
  modelId?: string
  percent: number
  stage: string
  detail?: string
  done?: boolean
  error?: string
}

declare global {
  interface Window {
    vclip: {
      invoke: (channel: string, ...args: unknown[]) => Promise<unknown>
      onProgress: (cb: (e: ProgressEventPayload) => void) => () => void
    }
  }
}

export const api = window.vclip

/** 把 IPC 抛出的错误转成用户可读的一行文本（去掉远程调用前缀噪音） */
export function errText(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  return raw
    .replace(/^Error invoking remote method '[^']+':\s*/, '')
    .replace(/^Error:\s*/, '')
    .trim()
}

export async function getSettings(): Promise<AppSettings> {
  return api.invoke('settings:get') as Promise<AppSettings>
}
export async function setSettings(s: AppSettings): Promise<AppSettings> {
  return api.invoke('settings:set', s) as Promise<AppSettings>
}
export async function checkFfmpeg(): Promise<{ ffmpeg: string; ffprobe: string | null; ok: boolean }> {
  return api.invoke('ffmpeg:check') as Promise<{ ffmpeg: string; ffprobe: string | null; ok: boolean }>
}
export async function testLlm(llm: AppSettings['llm']): Promise<{ ok: boolean; message: string }> {
  return api.invoke('llm:test', llm) as Promise<{ ok: boolean; message: string }>
}
export async function pickVideo(): Promise<string | null> {
  return api.invoke('dialog:pickVideo') as Promise<string | null>
}
export async function pickDirectory(): Promise<string | null> {
  return api.invoke('dialog:pickDirectory') as Promise<string | null>
}
export async function createProject(videoPath: string): Promise<ProjectData> {
  return api.invoke('project:create', videoPath) as Promise<ProjectData>
}
export async function listProjects(): Promise<ProjectMeta[]> {
  return api.invoke('project:list') as Promise<ProjectMeta[]>
}
export async function getProject(id: string): Promise<ProjectData | null> {
  return api.invoke('project:get', id) as Promise<ProjectData | null>
}
export async function deleteProject(id: string): Promise<void> {
  return api.invoke('project:delete', id) as Promise<void>
}
export async function saveClips(id: string, clips: Clip[]): Promise<void> {
  return api.invoke('project:saveClips', id, clips) as Promise<void>
}
export async function getSubtitles(id: string): Promise<SubtitleSegment[]> {
  return api.invoke('subtitles:get', id) as Promise<SubtitleSegment[]>
}
/** 导出全部字幕；ask=true 弹保存对话框，false 直接写到输出目录；取消返回 null */
export async function exportSubtitles(
  id: string,
  format: SubtitleFormat,
  ask = true
): Promise<SubtitleExportResult | null> {
  return api.invoke('subtitles:export', id, format, ask) as Promise<SubtitleExportResult | null>
}
export async function transcribe(id: string): Promise<{ count: number }> {
  return api.invoke('asr:transcribe', id) as Promise<{ count: number }>
}
export interface AnalyzeResult {
  clips: Clip[]
  usedRuleFallback: boolean
  message: string
}

export async function analyze(id: string): Promise<AnalyzeResult> {
  return api.invoke('analyze:start', id) as Promise<AnalyzeResult>
}
export async function analyzeRules(id: string): Promise<AnalyzeResult> {
  return api.invoke('analyze:rules', id) as Promise<AnalyzeResult>
}
export async function exportClips(id: string, options: ExportOptions): Promise<ExportResult> {
  return api.invoke('export:clips', id, options) as Promise<ExportResult>
}
export async function listModels(): Promise<AsrModelInfo[]> {
  return api.invoke('models:list') as Promise<AsrModelInfo[]>
}
export async function downloadModel(id: string): Promise<void> {
  return api.invoke('models:download', id) as Promise<void>
}
export async function deleteModel(id: string): Promise<void> {
  return api.invoke('models:delete', id) as Promise<void>
}
export async function openPath(p: string): Promise<unknown> {
  return api.invoke('shell:openPath', p)
}
export async function showItemInFolder(p: string): Promise<void> {
  return api.invoke('shell:showItemInFolder', p) as Promise<void>
}
