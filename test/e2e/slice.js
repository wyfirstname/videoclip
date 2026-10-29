/**
 * 切片链路端到端诊断脚本
 * 加载真实构建产物 (out/main/index.js)，直接调用 IPC 处理函数，
 * 覆盖：AI 分析 → 规则切片 → 精确/快速两种模式导出，并记录 LLM 原始响应。
 *
 * 用法：
 *   electron test/e2e/slice.js [projectId] --disable-gpu --no-sandbox
 * 环境变量：
 *   VCLIP_USERDATA  隔离的用户数据目录（默认 test/e2e/userdata）
 */
const { app, ipcMain } = require('electron')
const prereq = require('./_prereq')
const path = require('path')
const fs = require('fs')

const PROJECT_ID = process.argv.find((a) => /^[0-9a-f]{8}$/.test(a)) || '104ae4e3'

// 隔离的 userData，避免污染真实应用数据（必须在 require 主进程代码之前设置）
const UD = process.env.VCLIP_USERDATA || path.join(__dirname, 'userdata')
fs.mkdirSync(UD, { recursive: true })
app.setPath('userData', UD)
prereq.prepare(UD) // 预写 ffmpegPath（源码运行时应用自带的 ffmpeg 查不到）

// ---- 拦截 fetch，记录 LLM 交互 ----
const llmLogs = []
const origFetch = global.fetch
global.fetch = async (url, init) => {
  const res = await origFetch(url, init)
  try {
    const text = await res.clone().text()
    llmLogs.push({ url: String(url), status: res.status, req: init && init.body ? String(init.body) : '', resp: text })
  } catch {
    /* ignore */
  }
  return res
}

const report = { project: PROJECT_ID, steps: [], llm: [] }

function log(name, value) {
  report.steps.push({ name, value })
  console.log(`[STEP] ${name}: ${typeof value === 'string' ? value : JSON.stringify(value)}`)
}

require('../../out/main/index.js')

app.whenReady().then(async () => {
  console.log('SLICE_START')
  try {
    const invoke = (channel) => {
      const h = ipcMain._invokeHandlers.get(channel)
      if (!h) throw new Error(`未找到 IPC handler: ${channel}`)
      return h
    }

    const project = await invoke('project:get')({}, PROJECT_ID)
    if (!project) throw new Error('项目不存在: ' + PROJECT_ID)
    log('项目信息', {
      name: project.name,
      duration: project.duration,
      clipCount: project.clipCount,
      hasClips: project.hasClips
    })

    const subs = await invoke('subtitles:get')({}, PROJECT_ID)
    log('字幕条数', subs.length)
    log('字幕时长范围', subs.length ? `${subs[0].start} ~ ${subs[subs.length - 1].end}` : 'n/a')

    // ================= 场景 1：AI 分析（内容贫乏的短视频） =================
    await invoke('project:saveClips')({}, PROJECT_ID, [])
    const ai = await invoke('analyze:start')({}, PROJECT_ID)
    log('AI 分析', {
      count: ai.clips.length,
      usedRuleFallback: ai.usedRuleFallback,
      message: ai.message
    })
    log(
      'AI 切片明细',
      ai.clips.map((c) => ({
        title: c.title,
        s: c.start,
        e: c.end,
        dur: +(c.end - c.start).toFixed(1),
        source: c.source
      }))
    )
    const afterAi = await invoke('project:get')({}, PROJECT_ID)
    log('分析后 hasClips / clipCount', { hasClips: afterAi.hasClips, clipCount: afterAi.clipCount })

    // ================= 场景 2：规则切片 =================
    await invoke('project:saveClips')({}, PROJECT_ID, [])
    const rule = await invoke('analyze:rules')({}, PROJECT_ID)
    log('规则切片', { count: rule.clips.length, message: rule.message })
    log(
      '规则切片明细',
      rule.clips.map((c) => ({
        title: c.title,
        s: c.start,
        e: c.end,
        dur: +(c.end - c.start).toFixed(1),
        score: c.score
      }))
    )

    // ================= 场景 3：两种导出模式 =================
    for (const precise of [true, false]) {
      const label = precise ? '精确模式' : '快速模式'
      try {
        const r = await invoke('export:clips')({}, PROJECT_ID, {
          precise,
          includeSrt: true,
          includeJson: true
        })
        const mp4s = r.files.filter((f) => f.endsWith('.mp4'))
        log(`导出-${label}`, {
          outputDir: r.outputDir,
          mp4: mp4s.length,
          srt: r.files.filter((f) => f.endsWith('.srt')).length,
          failed: r.failed
        })
        // 校验产物真实可用
        const sizes = mp4s.map((f) => (fs.existsSync(f) ? fs.statSync(f).size : -1))
        log(`导出产物校验-${label}`, sizes)
      } catch (e) {
        log(`导出异常-${label}`, e && e.message)
      }
    }

    report.llm = llmLogs.map((l) => ({
      url: l.url,
      status: l.status,
      req: l.req.slice(0, 400),
      resp: l.resp.slice(0, 2000)
    }))
  } catch (e) {
    log('脚本异常', (e && e.stack) || String(e))
  }

  console.log(JSON.stringify(report, null, 2))
  console.log('SLICE_END')
  setTimeout(() => app.exit(0), 200)
})
