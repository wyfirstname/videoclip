/**
 * 端到端流程自测：上传视频 -> 创建项目 -> 识别字幕
 * 用法: VCLIP_USERDATA="<测试用户数据目录>" npx electron test/e2e/flow.js "<视频路径>"
 */
const path = require('path')
const fs = require('fs')
const { app, BrowserWindow, dialog } = require('electron')
const prereq = require('./_prereq')

const VIDEO = process.env.VCLIP_VIDEO || 'D:\\desktop\\test.mp4'
const UD = process.env.VCLIP_USERDATA || path.join(__dirname, 'userdata')
app.setPath('userData', UD)
prereq.prepare(UD) // 预写 ffmpegPath（源码运行时应用自带的 ffmpeg 查不到）

dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [VIDEO] })
dialog.showSaveDialog = async () => ({ canceled: true })

const events = []
const logs = []
const mainErrors = []
process.on('uncaughtException', (e) => mainErrors.push('uncaughtException: ' + (e && e.stack)))
process.on('unhandledRejection', (e) =>
  mainErrors.push('unhandledRejection: ' + ((e && e.stack) || String(e)))
)

app.on('browser-window-created', (_e, win) => {
  win.webContents.on('console-message', (_ev, level, message, source, line) =>
    logs.push(`[renderer:${level}] ${message} (${source}:${line})`)
  )
})

require(path.join(__dirname, '../../out/main/index.js'))

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  await app.whenReady()

  const report = {
    appPath: app.getAppPath(),
    resourcesPath: process.resourcesPath,
    userData: app.getPath('userData'),
    envUserData: process.env.VCLIP_USERDATA || '(default)',
    video: VIDEO,
    videoExists: fs.existsSync(VIDEO),
    steps: [],
    progressEvents: events
  }

  await sleep(3000)
  const win = BrowserWindow.getAllWindows()[0]
  if (!win) {
    report.fatal = '未创建窗口'
    return finish(report)
  }

  const step = async (name, js, timeout) => {
    try {
      const p = win.webContents.executeJavaScript(js, true)
      const value = timeout ? await Promise.race([p, sleep(timeout).then(() => '__TIMEOUT__')]) : await p
      report.steps.push({ name, ok: true, value })
      return value
    } catch (err) {
      const msg = String((err && err.message) || err)
      report.steps.push({ name, ok: false, error: msg })
      return 'ERR ' + msg
    }
  }

  await step('invoke ffmpeg:check', `window.vclip.invoke('ffmpeg:check').then(r=>JSON.stringify(r))`)

  // 1. 创建项目（等同上传视频）
  const created = await step(
    '创建项目',
    `window.vclip.invoke('project:create', ${JSON.stringify(VIDEO)})
       .then(r => JSON.stringify({id:r.id, name:r.name, duration:r.duration}))
       .catch(e => 'ERR ' + (e && e.message))`
  )
  let pid = null
  try {
    pid = JSON.parse(created).id
  } catch {
    /* ignore */
  }

  // 2. 走 UI：进入项目页
  await step(
    '刷新首页列表',
    `(() => { location.reload(); return 'reloading' })()`
  )
  await sleep(2500)
  await step(
    '点击项目卡片进入详情页',
    `(() => { const c=document.querySelector('.project-card-grid .ant-card'); if(!c) return 'no card'; c.click(); return 'clicked' })()`
  )
  await sleep(2000)

  await step(
    'video 播放状态',
    `(() => { const v=document.querySelector('video'); if(!v) return 'no video'; return {src:v.getAttribute('src'), readyState:v.readyState, networkState:v.networkState, error:v.error?{code:v.error.code,message:v.error.message}:null, duration:v.duration, w:v.videoWidth} })()`
  )

  // 3. 识别字幕：先走 UI 按钮
  await step('挂载进度监听', `(() => { window.__ev=[]; window.vclip.onProgress(e=>window.__ev.push(e)); return 'ok' })()`)
  await step(
    '点击「识别字幕」',
    `(() => { const b=[...document.querySelectorAll('button')].find(x=>x.textContent.includes('识别字幕')); if(!b) return 'no button'; b.click(); return 'clicked' })()`
  )
  // 轮询等待识别结束（最多 150s）
  let uiMsg = 'unknown'
  for (let i = 0; i < 60; i++) {
    await sleep(2500)
    uiMsg = await win.webContents.executeJavaScript(
      `[...document.querySelectorAll('.ant-message-notice-content')].map(e=>e.textContent.trim()).join(' | ')`,
      true
    )
    if (uiMsg) break
  }
  report.steps.push({ name: 'UI 识别结果提示', ok: true, value: uiMsg })
  await step('进度事件', `JSON.stringify((window.__ev||[]).slice(-12))`)
  await step('字幕条数(界面)', `[...document.querySelectorAll('.bottom-tab')].map(e=>e.textContent.trim())`)

  // 4. 直接调用 asr:transcribe 拿准确报错（更可靠）
  await step(
    'invoke asr:transcribe',
    `(window.__pid ? Promise.resolve(window.__pid) : window.vclip.invoke('project:list').then(l=>l[0]&&l[0].id))
       .then(id => id ? window.vclip.invoke('asr:transcribe', id).then(r=>'OK '+JSON.stringify(r)).catch(e=>'ERR '+(e&&e.message)) : 'no project')`,
    600000
  )

  return finish(report)
}

function finish(report) {
  report.rendererLogs = logs.slice(-25)
  report.mainErrors = mainErrors
  fs.writeFileSync(path.join(__dirname, 'flow-result.json'), JSON.stringify(report, null, 2), 'utf-8')
  console.log('===FLOW_START===')
  console.log(JSON.stringify(report, null, 2))
  console.log('===FLOW_END===')
  app.exit(0)
}

main().catch((e) => {
  console.log('===FLOW_FATAL===')
  console.log((e && e.stack) || String(e))
  app.exit(1)
})
