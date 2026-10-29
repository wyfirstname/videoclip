/**
 * 真实长视频全链路测试：新建项目 → 字幕识别 → AI 分析 → 规则切片 → 导出
 * 验证改动没有破坏「有内容的正常视频」这条主路径。
 *
 * 用法： electron test/e2e/fullflow.js --disable-gpu --no-sandbox
 * 环境变量：VCLIP_VIDEO 指定视频路径
 */
const { app, ipcMain } = require('electron')
const prereq = require('./_prereq')
const path = require('path')
const fs = require('fs')

const UD = process.env.VCLIP_USERDATA || path.join(__dirname, 'userdata-full')
fs.mkdirSync(UD, { recursive: true })
app.setPath('userData', UD)
prereq.prepare(UD) // 预写 ffmpegPath（源码运行时应用自带的 ffmpeg 查不到）

const VIDEO = process.env.VCLIP_VIDEO || 'E:\\autoclip\\董明珠的回应-智造未来 打破行业僵局.mp4'

const report = { video: VIDEO, steps: [] }
const log = (name, value) => {
  report.steps.push({ name, value })
  console.log(`[STEP] ${name}: ${typeof value === 'string' ? value : JSON.stringify(value)}`)
}

require('../../out/main/index.js')

app.whenReady().then(async () => {
  console.log('FLOW_START')
  try {
    const invoke = (channel) => {
      const h = ipcMain._invokeHandlers.get(channel)
      if (!h) throw new Error(`未找到 IPC handler: ${channel}`)
      return h
    }

    // 1. 新建项目
    if (!fs.existsSync(VIDEO)) throw new Error('视频不存在: ' + VIDEO)
    const project = await invoke('project:create')({}, VIDEO)
    log('新建项目', { id: project.id, name: project.name, duration: project.duration })

    // 2. 字幕识别（本地模型）
    const t0 = Date.now()
    const r = await invoke('asr:transcribe')({}, project.id)
    log('字幕识别', { count: r.count, seconds: Math.round((Date.now() - t0) / 1000) })

    const subs = await invoke('subtitles:get')({}, project.id)
    log('字幕样例', subs.slice(0, 3).map((s) => `${s.start}-${s.end} ${s.text}`))

    // 3. AI 分析（自适应时长 + 禁止空数组）
    const t1 = Date.now()
    const ai = await invoke('analyze:start')({}, project.id)
    log('AI 分析', {
      count: ai.clips.length,
      usedRuleFallback: ai.usedRuleFallback,
      message: ai.message,
      seconds: Math.round((Date.now() - t1) / 1000)
    })
    log(
      'AI 切片明细',
      ai.clips.slice(0, 8).map((c) => ({
        title: c.title,
        dur: +(c.end - c.start).toFixed(1),
        score: c.score,
        source: c.source
      }))
    )

    // 4. 导出（只导出前 2 个切片，节省时间）
    const toExport = ai.clips.map((c, i) => ({ ...c, selected: i < 2 }))
    await invoke('project:saveClips')({}, project.id, toExport)
    const ex = await invoke('export:clips')({}, project.id, {
      precise: true,
      includeSrt: true,
      includeJson: true
    })
    log('导出', {
      outputDir: ex.outputDir,
      mp4: ex.files.filter((f) => f.endsWith('.mp4')).length,
      srt: ex.files.filter((f) => f.endsWith('.srt')).length,
      failed: ex.failed
    })
    const sizes = ex.files
      .filter((f) => f.endsWith('.mp4'))
      .map((f) => (fs.existsSync(f) ? fs.statSync(f).size : -1))
    log('导出产物大小', sizes)
  } catch (e) {
    log('脚本异常', (e && e.stack) || String(e))
  }

  console.log(JSON.stringify(report, null, 2))
  console.log('FLOW_END')
  setTimeout(() => app.exit(0), 200)
})
