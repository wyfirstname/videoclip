/**
 * 直接以「打包后的产物」启动主进程，验证 media:// Range/seek 在新包里可用。
 * 用 release/<ver>/win-unpacked/resources/app.asar 里的 out/main/index.js 作为入口，
 * 因此校验的是安装包内真实运行的代码。
 *
 * 用法: npx electron test/e2e/probe-packaged.js
 */
const path = require('path')
const fs = require('fs')
const { app, BrowserWindow, dialog } = require('electron')

function findPackagedAsar() {
  if (process.env.ASAR_PATH) return process.env.ASAR_PATH
  const root = path.resolve(__dirname, '../..')
  const found = []
  for (const d of fs.readdirSync(root).filter((x) => /^release/i.test(x))) {
    const dir = path.join(root, d)
    if (!fs.statSync(dir).isDirectory()) continue
    for (const cand of [
      path.join(dir, 'win-unpacked', 'resources', 'app.asar'),
      ...fs
        .readdirSync(dir)
        .map((sub) => path.join(dir, sub, 'win-unpacked', 'resources', 'app.asar'))
    ]) {
      if (fs.existsSync(cand)) found.push({ p: cand, t: fs.statSync(cand).mtimeMs })
    }
  }
  found.sort((a, b) => b.t - a.t)
  if (!found.length) throw new Error('未找到打包产物 app.asar（请先打包，或用 ASAR_PATH 指定）')
  return found[0].p
}

const ASAR = findPackagedAsar()
const VIDEO = process.env.VCLIP_VIDEO || 'D:\\desktop\\test.mp4'
const UD = path.join(__dirname, 'userdata-packaged')
fs.mkdirSync(UD, { recursive: true })
app.setPath('userData', UD)

dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [VIDEO] })
dialog.showSaveDialog = async () => ({ canceled: true })

require(path.join(ASAR, 'out', 'main', 'index.js'))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const mediaUrl = (p) =>
  'media://file' + (p.startsWith('/') ? '' : '/') + p.replace(/\\/g, '/').split('/').map(encodeURIComponent).join('/')

async function main() {
  await app.whenReady()
  await sleep(2500)
  const win = BrowserWindow.getAllWindows()[0]
  if (!win) {
    console.log('===PKG_START===')
    console.log(JSON.stringify({ fatal: '未创建窗口' }, null, 2))
    console.log('===PKG_END===')
    return app.exit(1)
  }
  const js = (s, t) =>
    Promise.race([
      win.webContents.executeJavaScript(s, true),
      sleep(t || 30000).then(() => '__TIMEOUT__')
    ])

  const out = { asar: ASAR, video: VIDEO, videoExists: fs.existsSync(VIDEO) }

  out.rangeProbe = await js(`(async () => {
      const url = ${JSON.stringify(mediaUrl(VIDEO))}
      const ranged = await fetch(url, { headers: { Range: 'bytes=0-99' } })
      const b = await ranged.arrayBuffer()
      return { status: ranged.status, len: ranged.headers.get('content-length'), cr: ranged.headers.get('content-range'), ar: ranged.headers.get('accept-ranges'), bytes: b.byteLength }
    })()`)

  const created = await js(
    `window.vclip.invoke('project:create', ${JSON.stringify(VIDEO)}).then(r=>JSON.stringify({id:r.id,name:r.name,duration:r.duration}))`
  )
  let pid = null
  try {
    pid = JSON.parse(created).id
  } catch {
    /* ignore */
  }
  out.createProject = created

  // 注入字幕，顺带验证打包版「全部字幕导出」
  const subs = [
    { start: 0.5, end: 3.2, text: '打包版字幕导出测试一' },
    { start: 4.0, end: 6.5, text: '打包版字幕导出测试二' }
  ]
  fs.mkdirSync(path.join(UD, 'projects', pid), { recursive: true })
  fs.writeFileSync(path.join(UD, 'projects', pid, 'subtitles.json'), JSON.stringify(subs), 'utf-8')
  out.subExport = await js(
    `window.vclip.invoke('subtitles:export', ${JSON.stringify(pid)}, 'srt', false).then(r=>JSON.stringify(r)).catch(e=>'ERR '+(e&&e.message))`
  )
  try {
    const o = JSON.parse(out.subExport)
    out.subExportFile = {
      path: o.path,
      count: o.count,
      exists: fs.existsSync(o.path),
      hasBom: fs.existsSync(o.path) ? fs.readFileSync(o.path)[0] === 0xef : false,
      head: fs.existsSync(o.path) ? fs.readFileSync(o.path, 'utf-8').replace('\uFEFF', '').split('\n').slice(0, 4) : null
    }
  } catch {
    /* ignore */
  }

  await js(`location.reload()`)
  await sleep(2500)
  await js(`(() => { const c=document.querySelector('.project-card-grid .ant-card'); if(c) c.click(); return 1 })()`)
  await sleep(3000)

  out.seekable = await js(`(() => {
      const v = document.querySelector('.player-section video')
      if (!v) return 'no video'
      return { duration: v.duration, readyState: v.readyState, seekableCount: v.seekable.length, seekableEnd: v.seekable.length ? v.seekable.end(0) : null }
    })()`)

  out.seek = await js(`(async () => {
      const v = document.querySelector('.player-section video')
      v.currentTime = Math.min(5, (v.duration||10) / 2)
      await new Promise(r=>setTimeout(r,1000))
      return { after: v.currentTime }
    })()`)

  out.ui = await js(`(async () => {
      const fit=[...document.querySelectorAll('.timeline-toolbar button')].find(x=>x.textContent.includes('适配'))
      if (fit) fit.click()
      await new Promise(r=>setTimeout(r,400))
      const inner = document.querySelector('.timeline-inner')
      const r = inner.getBoundingClientRect()
      const x = r.left + r.width * 0.6
      inner.dispatchEvent(new PointerEvent('pointerdown', { bubbles:true, cancelable:true, clientX:x, clientY:r.top+30, pointerId:1, button:0, buttons:1, isPrimary:true }))
      window.dispatchEvent(new PointerEvent('pointerup', { bubbles:true, clientX:x, clientY:r.top+30, pointerId:1, buttons:0, isPrimary:true }))
      await new Promise(q=>setTimeout(q,900))
      const sc = document.querySelector('.timeline-scroll')
      const sr = sc.getBoundingClientRect()
      sc.dispatchEvent(new PointerEvent('pointermove', { bubbles:true, clientX: sr.left + 200, clientY: sr.top + 40, pointerId:2, isPrimary:true }))
      await new Promise(q=>setTimeout(q,1200))
      const thumb = document.querySelector('.tl-hover-video')
      const mon = document.querySelector('.monitor-video')
      const v = document.querySelector('.player-section video')
      return {
        playheadLeft: parseFloat(document.querySelector('.tl-playhead').style.left) || 0,
        videoTime: v.currentTime,
        hasThumb: !!document.querySelector('.tl-hover'),
        thumbDecoded: thumb ? thumb.videoWidth > 0 : false,
        monitorDecoded: mon ? mon.videoWidth > 0 : false,
        monitorTime: mon ? mon.currentTime : null,
        hoverTc: (document.querySelector('.tl-hover-tc')||{}).textContent || null,
        monitorTc: (document.querySelector('.monitor-tc')||{}).textContent || null,
        hasSubtitleToolbar: !!document.querySelector('.subtitle-toolbar')
      }
    })()`)

  // 精确模式导出：确认无字幕文件
  const clips = [
    { id: 'c1', title: '打包切片一', summary: 's', start: 0, end: 4, score: 0.9, reason: 'r', selected: true, edited: false, source: 'rule' }
  ]
  await js(
    `window.vclip.invoke('project:saveClips', ${JSON.stringify(pid)}, ${JSON.stringify(clips)}).then(()=>1)`
  )
  out.preciseExport = await js(
    `window.vclip.invoke('export:clips', ${JSON.stringify(pid)}, { precise: true, subtitleMode: 'none', includeJson: false }).then(r=>JSON.stringify(r)).catch(e=>'ERR '+(e&&e.message))`,
    300000
  )

  console.log('===PKG_START===')
  console.log(JSON.stringify(out, null, 2))
  console.log('===PKG_END===')
  app.exit(0)
}

main().catch((e) => {
  console.log('===PKG_FATAL===')
  console.log((e && e.stack) || String(e))
  app.exit(1)
})
