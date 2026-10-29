/**
 * 预置模型（extraResources）验证探针。
 * 加载打包产物里的主进程 + 全新 userData（其中没有任何已下载模型），
 * 调 models:list —— downloaded 标志走 isDownloaded → resolveModelDir → getBundledModelsDir
 * 链路；在干净 userData 下为 true 只可能来自安装包内的预置模型。
 *
 * 用法: npx electron test/e2e/probe-bundled.js [--disable-gpu --no-sandbox]
 * 可用 ASAR_PATH 显式指定 app.asar。
 */
const path = require('path')
const fs = require('fs')
const os = require('os')
const { app, BrowserWindow, dialog } = require('electron')

function findPackagedAsar() {
  if (process.env.ASAR_PATH) return process.env.ASAR_PATH
  const root = path.resolve(__dirname, '../..')
  const found = []
  for (const d of fs.readdirSync(root).filter((x) => /^release/i.test(x))) {
    const dir = path.join(root, d)
    if (!fs.statSync(dir).isDirectory()) continue
    for (const sub of ['', ...fs.readdirSync(dir)]) {
      const cand = path.join(dir, sub, 'win-unpacked', 'resources', 'app.asar')
      if (fs.existsSync(cand)) found.push({ p: cand, t: fs.statSync(cand).mtimeMs })
    }
  }
  found.sort((a, b) => b.t - a.t)
  if (!found.length) throw new Error('未找到打包产物 app.asar')
  return found[0].p
}

const ASAR = findPackagedAsar()
// 模拟打包态：真实 VClip.exe 的 process.resourcesPath 指向 win-unpacked/resources，
// 而本探针用 electron.exe 启动脚本，resourcesPath 是 electron dist —— 强制对齐后再加载主进程
try {
  Object.defineProperty(process, 'resourcesPath', {
    value: path.dirname(ASAR),
    writable: true,
    configurable: true
  })
} catch (e) {
  console.error('无法覆盖 process.resourcesPath:', String(e))
}
const UD = path.join(os.tmpdir(), `vclip-bundled-${Date.now()}`)
fs.mkdirSync(UD, { recursive: true })
app.setPath('userData', UD)

dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] })
dialog.showSaveDialog = async () => ({ canceled: true })

require(path.join(ASAR, 'out', 'main', 'index.js'))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  await app.whenReady()
  await sleep(2000)
  const win = BrowserWindow.getAllWindows()[0]
  const out = { asar: ASAR, userData: UD }

  if (!win) {
    out.fatal = '未创建窗口'
  } else {
    out.userDataModelsExists = fs.existsSync(path.join(UD, 'models')) // 必须为 false
    out.diag = {
      resourcesPath: process.resourcesPath,
      appPath: app.getAppPath(),
      cand1: fs.existsSync(path.join(process.resourcesPath || '', 'models')),
      cand2: fs.existsSync(path.join(app.getAppPath(), 'models')),
      cand3: fs.existsSync(path.join(path.dirname(app.getAppPath()), 'models')),
      resModelsList: fs.existsSync(path.join(process.resourcesPath || '', 'models'))
        ? fs.readdirSync(path.join(process.resourcesPath, 'models')).slice(0, 5)
        : null
    }
    const res = await Promise.race([
      win.webContents.executeJavaScript('window.vclip.invoke("models:list")', true),
      sleep(15000).then(() => '__TIMEOUT__')
    ])
    out.models = res
    out.anyDownloaded = Array.isArray(res) && res.some((m) => m.downloaded)
    out.pass = out.anyDownloaded && !out.userDataModelsExists
  }

  console.log('===BUNDLED_START===')
  console.log(JSON.stringify(out, null, 2))
  console.log('===BUNDLED_END===')

  try {
    fs.rmSync(UD, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
  app.exit(out.pass ? 0 : 1)
}

main().catch((e) => {
  console.log('===BUNDLED_START===')
  console.log(JSON.stringify({ fatal: String((e && e.stack) || e) }, null, 2))
  console.log('===BUNDLED_END===')
  app.exit(1)
})
