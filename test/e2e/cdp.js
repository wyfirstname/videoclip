/**
 * 通过 CDP 驱动已打包的 VClip.exe，验证真实产物行为
 * 前置：env -u ELECTRON_RUN_AS_NODE VClip.exe --remote-debugging-port=9222 --disable-gpu --no-sandbox
 * 用法: node test/e2e/cdp.js "<视频路径>"
 */
const VIDEO = process.argv[2] || 'D:\\desktop\\test.mp4'
const PORT = process.env.CDP_PORT || 9222

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function getPageTarget() {
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`)
      const list = await res.json()
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
      if (page) return page
    } catch {
      /* 未就绪 */
    }
    await sleep(1000)
  }
  throw new Error('未找到可调试页面')
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl)
    let id = 0
    const pending = new Map()
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data)
      if (msg.id && pending.has(msg.id)) {
        pending.get(msg.id)(msg)
        pending.delete(msg.id)
      }
    })
    ws.addEventListener('open', () =>
      resolve({
        send: (method, params) =>
          new Promise((res) => {
            const mid = ++id
            pending.set(mid, res)
            ws.send(JSON.stringify({ id: mid, method, params }))
          }),
        close: () => ws.close()
      })
    )
    ws.addEventListener('error', reject)
  })
}

async function main() {
  const target = await getPageTarget()
  const cdp = await connect(target.webSocketDebuggerUrl)
  await cdp.send('Runtime.enable')

  const report = { url: target.url, steps: [] }
  const evaluate = async (expr) => {
    const r = await cdp.send('Runtime.evaluate', {
      expression: expr,
      awaitPromise: true,
      returnByValue: true
    })
    const res = r.result || {}
    if (res.exceptionDetails) {
      return 'EXCEPTION ' + JSON.stringify(res.exceptionDetails.exception)
    }
    return res.result ? res.result.value : r
  }
  const step = async (name, expr, waitMs) => {
    const p = evaluate(expr)
    const value = waitMs ? await Promise.race([p, sleep(waitMs).then(() => '__TIMEOUT__')]) : await p
    report.steps.push({ name, value })
    return value
  }

  await step('页面标题', `document.title`)
  await step('FFmpeg 检测', `window.vclip.invoke('ffmpeg:check').then(r=>JSON.stringify(r)).catch(e=>'ERR '+e.message)`)
  await step('模型目录', `window.vclip.invoke('app:modelsDir').then(r=>'OK '+r).catch(e=>'ERR '+e.message)`)
  await step('模型下载状态', `window.vclip.invoke('models:list').then(l=>JSON.stringify(l.map(m=>m.id+':'+m.downloaded))).catch(e=>'ERR '+e.message)`)

  const projects = await step('现有项目', `window.vclip.invoke('project:list').then(l=>JSON.stringify(l.map(p=>({id:p.id,name:p.name,sub:p.hasSubtitles})))).catch(e=>'ERR '+e.message)`)
  let useCreate = true
  try {
    if (JSON.parse(projects).length) useCreate = false
  } catch {
    /* ignore */
  }

  if (useCreate) {
    await step(
      '创建项目',
      `window.vclip.invoke('project:create', ${JSON.stringify(VIDEO)})
         .then(r=>JSON.stringify({id:r.id,name:r.name,duration:r.duration}))
         .catch(e=>'ERR '+e.message)`
    )
  } else {
    report.steps.push({ name: '创建项目', value: '复用已有项目' })
  }

  await step('刷新首页', `(()=>{location.reload();return 'ok'})()`)
  await sleep(2500)
  await step(
    '进入项目详情页',
    `(()=>{const c=document.querySelector('.project-card-grid .ant-card'); if(!c) return 'no card'; c.click(); return 'clicked'})()`
  )
  await sleep(2500)
  await step(
    'video 播放状态',
    `(()=>{const v=document.querySelector('video'); if(!v) return 'no video';
      return JSON.stringify({src:v.getAttribute('src'), readyState:v.readyState, networkState:v.networkState,
        error:v.error?{code:v.error.code,msg:v.error.message}:null, duration:v.duration, w:v.videoWidth})})()`
  )

  // 识别字幕（验证打包版 ffmpeg 是否可用）
  await step('挂载进度监听', `(()=>{window.__ev=[]; window.vclip.onProgress(e=>window.__ev.push(e)); return 'ok'})()`)
  await step(
    '点击「识别字幕」',
    `(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.textContent.includes('识别字幕'));
      if(!b) return 'no button'; if(b.disabled) return 'disabled'; b.click(); return 'clicked'})()`
  )
  let msg = ''
  for (let i = 0; i < 60; i++) {
    await sleep(2500)
    msg = await evaluate(
      `[...document.querySelectorAll('.ant-message-notice-content')].map(e=>e.textContent.trim()).join(' | ')`
    )
    if (msg) break
  }
  report.steps.push({ name: '识别结果提示', value: msg })
  await step('进度事件', `JSON.stringify((window.__ev||[]).slice(-10))`)
  await step('底部面板', `[...document.querySelectorAll('.bottom-tab')].map(e=>e.textContent.trim()).join(' / ')`)
  await step('页面错误提示', `[...document.querySelectorAll('.ant-message-error,.ant-alert-error')].map(e=>e.textContent.trim()).join(' | ')`)

  cdp.close()
  console.log('===CDP_START===')
  console.log(JSON.stringify(report, null, 2))
  console.log('===CDP_END===')
}

main().catch((e) => {
  console.log('===CDP_FATAL===' + ((e && e.stack) || e))
  process.exit(1)
})
