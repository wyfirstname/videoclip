/**
 * 探针：验证 media:// 协议是否支持 Range（决定视频能否 seek）
 * 用法: npx electron test/e2e/probe-media.js
 */
const path = require('path')
const fs = require('fs')
const { app, BrowserWindow, dialog } = require('electron')
const prereq = require('./_prereq')

const VIDEO = process.env.VCLIP_VIDEO || 'D:\\desktop\\test.mp4'
const UD = path.join(__dirname, 'userdata-probe')
fs.mkdirSync(UD, { recursive: true })
app.setPath('userData', UD)
prereq.prepare(UD)

dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [VIDEO] })
dialog.showSaveDialog = async () => ({ canceled: true })

require(path.join(__dirname, '../../out/main/index.js'))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  await app.whenReady()
  await sleep(2500)
  const win = BrowserWindow.getAllWindows()[0]
  const js = (s) => win.webContents.executeJavaScript(s, true)
  const out = {}

  out.ffmpeg = prereq.ffmpegPath || null

  // 1) 直接对 media:// 发带 Range 的请求
  out.rangeProbe = await js(`(async () => {
      const url = 'media://file/D%3A/desktop/test.mp4'
      const full = await fetch(url)
      const ranged = await fetch(url, { headers: { Range: 'bytes=0-99' } })
      const rangedBody = await ranged.arrayBuffer()
      return {
        fullStatus: full.status,
        fullLength: full.headers.get('content-length'),
        fullAcceptRanges: full.headers.get('accept-ranges'),
        fullContentRange: full.headers.get('content-range'),
        rangeStatus: ranged.status,
        rangeLength: ranged.headers.get('content-length'),
        rangeContentRange: ranged.headers.get('content-range'),
        rangeAcceptRanges: ranged.headers.get('accept-ranges'),
        rangeBodyBytes: rangedBody.byteLength
      }
    })()`)

  // 2) 创建项目并进入详情页
  const created = await js(
    `window.vclip.invoke('project:create', ${JSON.stringify(VIDEO)}).then(r=>JSON.stringify({id:r.id,name:r.name}))`
  )
  const pid = JSON.parse(created).id
  await js(`location.reload()`)
  await sleep(2500)
  await js(
    `(() => { const c=document.querySelector('.project-card-grid .ant-card'); if(c) c.click(); return 1 })()`
  )
  await sleep(3000)

  // 3) 媒体元素可 seek 性 + 实际 seek
  out.videoBefore = await js(`(() => {
      const v = document.querySelector('.player-section video')
      if (!v) return 'no video'
      return {
        duration: v.duration, readyState: v.readyState, currentTime: v.currentTime,
        seekableCount: v.seekable.length,
        seekableRange: v.seekable.length ? [v.seekable.start(0), v.seekable.end(0)] : null,
        bufferedRanges: [...Array(v.buffered.length)].map((_,i)=>[v.buffered.start(i), v.buffered.end(i)]),
        networkState: v.networkState, src: v.getAttribute('src')
      }
    })()`)

  out.seekResult = await js(`(async () => {
      const v = document.querySelector('.player-section video')
      const before = v.currentTime
      v.currentTime = 5
      await new Promise(r=>setTimeout(r,1200))
      return { before, after: v.currentTime, seeked: Math.abs(v.currentTime-5) < 0.6, ended: v.ended, paused: v.paused }
    })()`)

  out.monitorSeek = await js(`(async () => {
      const v = document.querySelector('.monitor-video')
      const before = v.currentTime
      v.currentTime = 5
      await new Promise(r=>setTimeout(r,1200))
      return { before, after: v.currentTime, ok: Math.abs(v.currentTime-5) < 0.6 }
    })()`)

  // 4) 走 UI：点击时间轴定位
  out.uiSeek = await js(`(async () => {
      const inner = document.querySelector('.timeline-inner')
      const r = inner.getBoundingClientRect()
      const x = r.left + r.width * 0.5
      inner.dispatchEvent(new PointerEvent('pointerdown', { bubbles:true, cancelable:true, clientX:x, clientY:r.top+30, pointerId:1, button:0, buttons:1, isPrimary:true }))
      window.dispatchEvent(new PointerEvent('pointerup', { bubbles:true, clientX:x, clientY:r.top+30, pointerId:1, buttons:0, isPrimary:true }))
      await new Promise(q=>setTimeout(q,900))
      const v = document.querySelector('.player-section video')
      return { playheadLeft: document.querySelector('.tl-playhead').style.left, videoTime: v.currentTime, monitorTc: (document.querySelector('.monitor-tc')||{}).textContent }
    })()`)

  console.log('===PROBE_START===')
  console.log(JSON.stringify(out, null, 2))
  console.log('===PROBE_END===')
  app.exit(0)
}

main().catch((e) => {
  console.log('===PROBE_FATAL===')
  console.log((e && e.stack) || String(e))
  app.exit(1)
})
