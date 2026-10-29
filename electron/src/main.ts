import { app, BrowserWindow, Menu, ipcMain, dialog, shell, protocol } from 'electron'
import * as path from 'path'
import * as fs from 'fs'
import { Readable } from 'stream'
import { randomUUID } from 'crypto'
import {
  AppSettings,
  ExportOptions,
  ProjectData,
  SubtitleSegment,
  SubtitleFormat,
  SubtitleExportResult,
  Clip
} from '../../shared/types'
import {
  getSettings,
  saveSettings,
  listProjects,
  getProject,
  saveProject,
  deleteProject,
  getSubtitles,
  getClips,
  saveClips,
  saveSubtitles,
  getProjectDataDir,
  getModelsDir
} from './store'
import { checkFfmpeg, probeDuration, extractAudio } from './ffmpeg'
import { listModels, downloadModel, deleteModel } from './models'
import { transcribe } from './asr'
import { analyzeProject, analyzeByRules } from './pipeline'
import { exportClips, writeAllSubtitles, subtitleFilter } from './export'
import { sanitizeFilename, ensureDir } from './utils'
import { LlmClient } from './llm'

let mainWindow: BrowserWindow | null = null

const isDev = !app.isPackaged

// 自定义协议必须在 app ready 之前注册为特权协议：
// 否则 <video> 会以 "Media load rejected by URL safety check" 拒绝加载
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'media',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      bypassCSP: true
    }
  }
])

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    title: 'VClip - AI 视频切片',
    // 应用自身已有顶部栏（.app-header），系统菜单栏纯属多余：
    // autoHideMenuBar 让菜单栏不可见（Windows/Linux），菜单被移除后按 Alt 也不会弹出
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  // 菜单项的 role 会绑定默认快捷键（Ctrl+W/Ctrl+Q/Ctrl+R…），移除菜单后一并补回常用项，
  // 避免用户失去「刷新/开发者工具」这类入口；不使用菜单加速器，所以不会出现菜单栏
  if (isDev) {
    mainWindow.webContents.on('before-input-event', (_e, input) => {
      if (input.type !== 'keyDown') return
      const key = input.key.toLowerCase()
      const mod = input.control || input.meta
      if (key === 'f12' || (mod && input.shift && key === 'i')) {
        mainWindow?.webContents.toggleDevTools()
      } else if (mod && key === 'r') {
        mainWindow?.webContents.reload()
      }
    })
  }

  if (isDev && process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
    mainWindow.webContents.openDevTools()
  } else {
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))
  }
}

// media:// 协议：安全地在渲染进程播放本地视频
// 注意 URL 必须带 host（media://file/E:/x.mp4），空 host 的 media:/// 会被 URL 安全检查拒绝
//
// 关键：必须自己实现 Range/206。
// 早期实现直接返回 net.fetch(pathToFileURL(...))，响应里既没有 Content-Length 也没有
// Accept-Ranges，还被剥掉了请求的 Range 头。结果是媒体元素的 seekable 只有 [0,0]、
// 只能缓冲开头几秒 —— 播放进度条拖不动，时间轴定位、预览全都会失效。
const MIME_BY_EXT: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
  '.flv': 'video/x-flv',
  '.ts': 'video/mp2t',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.wav': 'audio/wav',
  '.srt': 'text/plain; charset=utf-8',
  '.vtt': 'text/vtt; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8'
}

function mimeOf(filePath: string): string {
  return MIME_BY_EXT[path.extname(filePath).toLowerCase()] || 'application/octet-stream'
}

/** 解析 "bytes=start-end" / "bytes=start-" / "bytes=-suffix"，返回闭区间 */
function parseRange(
  header: string | null,
  size: number
): { start: number; end: number } | null | 'invalid' {
  if (!header) return null
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!m) return null
  const [, rawStart, rawEnd] = m
  if (rawStart === '' && rawEnd === '') return 'invalid'
  let start: number
  let end: number
  if (rawStart === '') {
    // 末尾 N 字节
    const suffix = parseInt(rawEnd, 10)
    if (!Number.isFinite(suffix) || suffix <= 0) return 'invalid'
    start = Math.max(0, size - suffix)
    end = size - 1
  } else {
    start = parseInt(rawStart, 10)
    end = rawEnd === '' ? size - 1 : parseInt(rawEnd, 10)
  }
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 'invalid'
  if (start >= size) return 'invalid'
  if (end >= size) end = size - 1
  if (start > end) return 'invalid'
  return { start, end }
}

function registerMediaProtocol(): void {
  protocol.handle('media', async (request) => {
    let filePath = decodeURIComponent(new URL(request.url).pathname)
    // Windows: /E:/dir/a.mp4 -> E:/dir/a.mp4 ；macOS/Linux 保留前导 /
    if (/^\/[A-Za-z]:/.test(filePath)) filePath = filePath.slice(1)

    let stat: fs.Stats
    try {
      stat = fs.statSync(filePath)
    } catch {
      return new Response('Not Found', { status: 404 })
    }
    if (!stat.isFile()) return new Response('Not Found', { status: 404 })

    const size = stat.size
    const baseHeaders: Record<string, string> = {
      'Content-Type': mimeOf(filePath),
      'Accept-Ranges': 'bytes',
      'Last-Modified': stat.mtime.toUTCString()
    }

    const range = parseRange(request.headers.get('Range'), size)

    if (range === 'invalid') {
      return new Response(null, {
        status: 416,
        headers: { ...baseHeaders, 'Content-Range': `bytes */${size}` }
      })
    }

    if (!range) {
      if (request.method === 'HEAD') {
        return new Response(null, {
          status: 200,
          headers: { ...baseHeaders, 'Content-Length': String(size) }
        })
      }
      return new Response(Readable.toWeb(fs.createReadStream(filePath)) as ReadableStream, {
        status: 200,
        headers: { ...baseHeaders, 'Content-Length': String(size) }
      })
    }

    const body =
      request.method === 'HEAD'
        ? null
        : (Readable.toWeb(
            fs.createReadStream(filePath, { start: range.start, end: range.end })
          ) as ReadableStream)
    return new Response(body, {
      status: 206,
      headers: {
        ...baseHeaders,
        'Content-Length': String(range.end - range.start + 1),
        'Content-Range': `bytes ${range.start}-${range.end}/${size}`
      }
    })
  })
}

/** 把切片写回项目元数据；hasClips 必须按实际数量判断，否则空结果会被标记为已完成 */
function syncClipsToProject(projectId: string, clips: Clip[]): void {
  const project = getProject(projectId)
  if (!project) return
  project.clips = clips
  project.hasClips = clips.length > 0
  project.clipCount = clips.length
  saveProject(project)
  saveClips(projectId, clips)
}

function registerIpc(): void {
  // ---- 设置 ----
  ipcMain.handle('settings:get', () => getSettings())
  ipcMain.handle('settings:set', (_e, s: AppSettings) => saveSettings(s))
  ipcMain.handle('ffmpeg:check', () => checkFfmpeg())
  ipcMain.handle('llm:test', async (_e, llm: AppSettings['llm']) => {
    return new LlmClient(llm).test()
  })

  // ---- 对话框 ----
  ipcMain.handle('dialog:pickVideo', async () => {
    const res = await dialog.showOpenDialog(mainWindow!, {
      title: '选择视频文件',
      properties: ['openFile'],
      filters: [
        { name: '视频文件', extensions: ['mp4', 'mkv', 'mov', 'avi', 'flv', 'webm', 'ts', 'm4v'] }
      ]
    })
    return res.canceled ? null : res.filePaths[0]
  })
  ipcMain.handle('dialog:pickDirectory', async () => {
    const res = await dialog.showOpenDialog(mainWindow!, {
      title: '选择目录',
      properties: ['openDirectory']
    })
    return res.canceled ? null : res.filePaths[0]
  })
  ipcMain.handle('shell:openPath', (_e, p: string) => shell.openPath(p))
  ipcMain.handle('shell:showItemInFolder', (_e, p: string) => shell.showItemInFolder(p))

  // ---- 项目 ----
  ipcMain.handle(
    'project:create',
    async (_e, videoPath: string): Promise<ProjectData> => {
      const parsed = path.parse(videoPath)
      const id = randomUUID().slice(0, 8)
      const duration = await probeDuration(videoPath)
      const project: ProjectData = {
        id,
        name: parsed.name,
        videoPath,
        duration,
        createdAt: Date.now(),
        hasSubtitles: false,
        hasClips: false,
        clipCount: 0,
        clips: []
      }
      saveProject(project)
      getProjectDataDir(id) // 确保目录存在
      return project
    }
  )
  ipcMain.handle('project:list', () => listProjects())
  ipcMain.handle('project:get', (_e, id: string) => getProject(id))
  ipcMain.handle('project:delete', (_e, id: string) => deleteProject(id))
  ipcMain.handle('project:saveClips', (_e, id: string, clips: Clip[]) => {
    syncClipsToProject(id, clips)
    return true
  })
  ipcMain.handle('subtitles:get', (_e, id: string): SubtitleSegment[] => getSubtitles(id))
  ipcMain.handle('clips:get', (_e, id: string) => getClips(id))

  // ---- 全部字幕导出（SRT / 带时间码文本 / JSON；UTF-8 BOM，中文不乱码）----
  ipcMain.handle(
    'subtitles:export',
    async (_e, id: string, format: SubtitleFormat, ask = true): Promise<SubtitleExportResult | null> => {
      const project = getProject(id)
      if (!project) throw new Error('项目不存在')
      const segments = getSubtitles(id)
      if (!segments.length) throw new Error('当前项目还没有字幕，请先识别字幕')

      const base = sanitizeFilename(project.name) || 'subtitles'
      const defaultName = `${base}.字幕.${format}`

      let target: string
      if (ask) {
        const res = await dialog.showSaveDialog(mainWindow!, {
          title: '导出全部字幕',
          defaultPath: path.join(app.getPath('videos'), defaultName),
          filters: [subtitleFilter(format), { name: '所有文件', extensions: ['*'] }]
        })
        if (res.canceled || !res.filePath) return null
        target = res.filePath
      } else {
        const settings = getSettings()
        const root =
          settings.outputDir && fs.existsSync(settings.outputDir)
            ? settings.outputDir
            : app.getPath('videos')
        const dir = path.join(root, 'VClip', base)
        ensureDir(dir)
        target = path.join(dir, defaultName)
      }

      const count = writeAllSubtitles(target, segments, format)
      return { path: target, count, format }
    }
  )

  // ---- ASR ----
  ipcMain.handle('asr:transcribe', async (_e, id: string) => {
    const project = getProject(id)
    if (!project) throw new Error('项目不存在')
    try {
      const segments = await transcribe(id, project.videoPath)
      saveSubtitles(id, segments)
      project.hasSubtitles = true
      saveProject(project)
      return { count: segments.length }
    } catch (err) {
      throw new Error(err instanceof Error ? err.message : String(err))
    }
  })
  // 音频预提取（worker 需要真实文件路径，此接口供重试场景使用）
  ipcMain.handle('asr:extractAudio', async (_e, id: string) => {
    const project = getProject(id)
    if (!project) throw new Error('项目不存在')
    const dir = getProjectDataDir(id)
    await extractAudio(project.videoPath, path.join(dir, 'audio.wav'))
    return true
  })

  // ---- AI 分析 ----
  ipcMain.handle('analyze:start', async (_e, id: string) => {
    const result = await analyzeProject(id)
    syncClipsToProject(id, result.clips)
    return result
  })
  // 规则切片：不依赖 LLM，作为兜底/快速方案
  ipcMain.handle('analyze:rules', async (_e, id: string) => {
    const result = await analyzeByRules(id)
    syncClipsToProject(id, result.clips)
    return result
  })

  // ---- 导出 ----
  ipcMain.handle('export:clips', async (_e, id: string, options: ExportOptions) =>
    exportClips(id, options)
  )

  // ---- 模型 ----
  ipcMain.handle('models:list', () => listModels())
  ipcMain.handle('models:download', async (_e, modelId: string) => {
    await downloadModel(modelId)
    return true
  })
  ipcMain.handle('models:delete', (_e, modelId: string) => deleteModel(modelId))

  // ---- 应用 ----
  ipcMain.handle('app:version', () => app.getVersion())
  ipcMain.handle('app:modelsDir', () => getModelsDir())
}

app.whenReady().then(() => {
  // 移除 Electron 默认应用菜单（左上角 File/Edit/View/Window/Help）。
  // macOS 的菜单在屏幕顶部且承载 Cmd+Q/Cmd+C 等系统快捷键，保留不动。
  if (process.platform !== 'darwin') Menu.setApplicationMenu(null)

  registerMediaProtocol()
  registerIpc()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// 处理 asar 内的 ffmpeg 占位（打包环境下 build/ffmpeg-bin 会复制到 resources）
if (!fs.existsSync(path.join(process.resourcesPath || '', 'ffmpeg-bin'))) {
  // 开发环境无需处理，运行时回退到系统 PATH
}
