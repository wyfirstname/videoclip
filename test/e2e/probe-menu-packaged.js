/**
 * 直接以「打包后的产物」启动主进程，验证菜单栏已被移除。
 * 入口取安装包产物里的 out/main/index.js，校验的是安装包内真实运行的代码。
 * 路径：自动找最新的 release... / win-unpacked / resources / app.asar；
 *       也可用 ASAR_PATH 环境变量显式指定。
 */
const path = require('path')
const fs = require('fs')
const { app, BrowserWindow, Menu, dialog } = require('electron')

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
const UD = path.join(__dirname, 'userdata-menu-pkg')
fs.mkdirSync(UD, { recursive: true })
app.setPath('userData', UD)

dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] })
dialog.showSaveDialog = async () => ({ canceled: true })

require(path.join(ASAR, 'out', 'main', 'index.js'))

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  await app.whenReady()
  await sleep(2500)
  const win = BrowserWindow.getAllWindows()[0]
  const out = {
    asar: ASAR,
    asarExists: fs.existsSync(ASAR),
    appMenuIsNull: Menu.getApplicationMenu() === null,
    menuBarVisible: win ? win.isMenuBarVisible() : null,
    menuBarAutoHide: win ? win.isMenuBarAutoHide() : null,
    windowCreated: !!win,
    webContentsOk: win ? !win.webContents.isCrashed() : null
  }
  console.log('===PKGMENU_START===')
  console.log(JSON.stringify(out, null, 2))
  console.log('===PKGMENU_END===')
  app.exit(0)
}

main().catch((e) => {
  console.log('===PKGMENU_FATAL===', e && e.stack)
  app.exit(1)
})
