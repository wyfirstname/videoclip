/**
 * media:// 变体对照：区分「空 host」「net.fetch」「Range」三个因素
 */
const fs = require('fs')
const path = require('path')
const { pathToFileURL } = require('url')
const { app, BrowserWindow, protocol, net } = require('electron')

const VIDEO = process.env.VCLIP_VIDEO || 'D:\\desktop\\test.mp4'
const PAGE = path.join(__dirname, 'proto-page3.html')

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'media',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: true }
  }
])

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const toPath = (u) => decodeURIComponent(new URL(u).pathname).replace(/^\/([A-Za-z]:)/, '$1')

function streamResponse(filePath, req, withRange) {
  const stat = fs.statSync(filePath)
  const headers = { 'Content-Type': 'video/mp4', 'Accept-Ranges': withRange ? 'bytes' : 'none' }
  const range = withRange && (req.headers.get('Range') || req.headers.get('range'))
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range)
    const start = m && m[1] ? parseInt(m[1], 10) : 0
    const end = m && m[2] ? parseInt(m[2], 10) : stat.size - 1
    return new Response(fs.createReadStream(filePath, { start, end }), {
      status: 206,
      headers: {
        ...headers,
        'Content-Length': String(end - start + 1),
        'Content-Range': `bytes ${start}-${end}/${stat.size}`
      }
    })
  }
  return new Response(fs.createReadStream(filePath), {
    status: 200,
    headers: { ...headers, 'Content-Length': String(stat.size) }
  })
}

app.whenReady().then(async () => {
  const out = {}

  protocol.handle('media', async (req) => {
    const host = new URL(req.url).host
    const filePath = toPath(req.url)
    if (host === 'manual') return streamResponse(filePath, req, false)
    if (host === 'range') return streamResponse(filePath, req, true)
    return net.fetch(pathToFileURL(filePath).toString()) // 空 host 或 local
  })

  const enc = VIDEO.replace(/\\/g, '/').split('/').map(encodeURIComponent).join('/')
  fs.writeFileSync(
    PAGE,
    `<!doctype html><html><body>
    <video id="a" src="media:///${enc}" preload="auto"></video>
    <video id="b" src="media://local/${enc}" preload="auto"></video>
    <video id="c" src="media://manual/${enc}" preload="auto"></video>
    <video id="d" src="media://range/${enc}" preload="auto"></video>
    </body></html>`,
    'utf-8'
  )

  const win = new BrowserWindow({ show: false })
  await win.loadFile(PAGE)
  await sleep(6000)

  const probe = (id) =>
    win.webContents.executeJavaScript(
      `(()=>{const v=document.getElementById('${id}');return {readyState:v.readyState, error:v.error?v.error.message:null, duration:v.duration, w:v.videoWidth}})()`
    )
  out.a_emptyHost_netFetch = await probe('a')
  out.b_localHost_netFetch = await probe('b')
  out.c_manualNoRange = await probe('c')
  out.d_manualWithRange = await probe('d')

  console.log('===PROTO3_START===')
  console.log(JSON.stringify(out, null, 2))
  console.log('===PROTO3_END===')
  app.exit(0)
})
