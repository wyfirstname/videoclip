/**
 * 端到端自测：加载真实构建产物 out/main/index.js，模拟「选择视频 -> 创建项目 -> 进入项目页」
 * 用法: npx electron test/e2e/main.js "<视频路径>"
 */
const path = require('path')
const fs = require('fs')
const { app, BrowserWindow, dialog } = require('electron')

const VIDEO =
  process.argv.slice(2).find((a) => /\.(mp4|mkv|mov|avi|flv|webm|ts|m4v)$/i.test(a)) ||
  'E:\\autoclip\\董明珠的回应-智造未来 打破行业僵局.mp4'

// 拦截文件选择对话框，返回测试视频
dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [VIDEO] })

const logs = []
const mainErrors = []
process.on('uncaughtException', (e) => mainErrors.push('uncaughtException: ' + (e && e.stack)))
process.on('unhandledRejection', (e) =>
  mainErrors.push('unhandledRejection: ' + ((e && e.stack) || String(e)))
)

// 尽早挂监听，捕获渲染进程控制台与加载失败
app.on('browser-window-created', (_e, win) => {
  win.webContents.on('console-message', (_ev, level, message, line, source) => {
    logs.push(`[renderer:${level}] ${message} (${source}:${line})`)
  })
  win.webContents.on('did-fail-load', (_ev, code, desc, url) => {
    logs.push(`[did-fail-load] ${code} ${desc} ${url}`)
  })
  win.webContents.on('render-process-gone', (_ev, details) => {
    logs.push(`[render-process-gone] ${JSON.stringify(details)}`)
  })
})

// 加载真实主进程产物
require(path.join(__dirname, '../../out/main/index.js'))

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  await app.whenReady()
  await sleep(3500)

  const win = BrowserWindow.getAllWindows()[0]
  const report = { video: VIDEO, videoExists: fs.existsSync(VIDEO), steps: [] }

  if (!win) {
    report.fatal = '未创建窗口'
    return finish(report)
  }

  const step = async (name, js) => {
    try {
      const value = await win.webContents.executeJavaScript(js, true)
      report.steps.push({ name, ok: true, value })
    } catch (err) {
      report.steps.push({ name, ok: false, error: String((err && err.message) || err) })
    }
  }

  // A. 桥接与首页渲染
  await step('window.vclip 存在', `typeof window.vclip`)
  await step('首页标题', `document.querySelector('h2')?.textContent?.trim()`)
  await step('按钮列表', `[...document.querySelectorAll('button')].map(b=>b.textContent.trim())`)

  // B. 直接调用创建接口（暴露真实异常）
  await step(
    'invoke project:create',
    `window.vclip.invoke('project:create', ${JSON.stringify(VIDEO)})
       .then(r => 'OK ' + JSON.stringify({id:r.id,name:r.name,duration:r.duration}))
       .catch(e => 'ERR ' + (e && e.message))`
  )

  // C. 清理上一步产生的项目，再从 UI 走一遍
  await step(
    '清理测试项目',
    `window.vclip.invoke('project:list').then(list => Promise.all(list.map(p=>window.vclip.invoke('project:delete',p.id)))).then(()=> 'cleaned')`
  )

  await step(
    '点击「新建项目（选择视频）」',
    `(() => { const b=[...document.querySelectorAll('button')].find(x=>x.textContent.includes('新建项目')); if(!b) return 'no button'; b.click(); return 'clicked' })()`
  )
  await sleep(2500)
  await step(
    'UI 提示文本',
    `[...document.querySelectorAll('.ant-message-notice-content, .ant-message-error, .ant-message-success')].map(e=>e.textContent.trim())`
  )
  await step('is 进入项目页', `!!document.querySelector('.project-page')`)

  // D. 项目页：检查视频是否可播放
  await sleep(1500)
  await step(
    'video 元素状态',
    `(() => { const v=document.querySelector('video'); if(!v) return 'no video'; return {src:v.getAttribute('src'), readyState:v.readyState, networkState:v.networkState, error:v.error?{code:v.error.code,message:v.error.message}:null, duration:v.duration, videoWidth:v.videoWidth} })()`
  )
  await step('页面可见文本', `document.querySelector('.project-page')?.innerText?.slice(0,300)`)
  await step('页面内错误提示', `[...document.querySelectorAll('.ant-message-error,.ant-alert-error')].map(e=>e.textContent.trim())`)

  // E. 设置页接口
  await step(
    'invoke app:modelsDir',
    `window.vclip.invoke('app:modelsDir').then(r=>'OK '+r).catch(e=>'ERR '+(e&&e.message))`
  )
  await step(
    'invoke ffmpeg:check',
    `window.vclip.invoke('ffmpeg:check').then(r=>'OK '+JSON.stringify(r)).catch(e=>'ERR '+(e&&e.message))`
  )
  await step(
    'invoke settings:get',
    `window.vclip.invoke('settings:get').then(r=>'OK '+JSON.stringify(r)).catch(e=>'ERR '+(e&&e.message))`
  )

  return finish(report)
}

function finish(report) {
  report.rendererLogs = logs.slice(-40)
  report.mainErrors = mainErrors
  const outFile = path.join(__dirname, 'result.json')
  fs.writeFileSync(outFile, JSON.stringify(report, null, 2), 'utf-8')
  console.log('===E2E_RESULT_START===')
  console.log(JSON.stringify(report, null, 2))
  console.log('===E2E_RESULT_END===')
  app.exit(0)
}

main().catch((e) => {
  console.log('===E2E_FATAL===')
  console.log(e && e.stack)
  app.exit(1)
})
