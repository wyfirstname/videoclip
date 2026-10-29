/**
 * 验证「隐藏 Electron 自带菜单栏（左上角 File/Edit/View/Window/Help）」是否生效。
 * 直接 require 构建产物 out/main/index.js，检查的是真实运行的代码。
 *
 * 用法: env -u ELECTRON_RUN_AS_NODE npx electron test/e2e/probe-menu.js --disable-gpu --no-sandbox
 */
const path = require('path')
const fs = require('fs')
const { app, BrowserWindow, Menu, dialog } = require('electron')

const ROOT = path.resolve(__dirname, '../..')
const UD = path.join(__dirname, 'userdata-menu')
fs.mkdirSync(UD, { recursive: true })
app.setPath('userData', UD)

dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] })
dialog.showSaveDialog = async () => ({ canceled: true })

require(path.join(ROOT, 'out', 'main', 'index.js'))

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  await app.whenReady()
  await sleep(3000)

  const win = BrowserWindow.getAllWindows()[0]
  const out = {
    platform: process.platform,
    appMenuIsNull: Menu.getApplicationMenu() === null,
    menuBarVisible: win ? win.isMenuBarVisible() : null,
    menuBarAutoHide: win ? win.isMenuBarAutoHide() : null,
    bounds: win ? win.getBounds() : null,
    contentBounds: win ? win.getContentBounds() : null,
    hasWindowChrome: false,
    shot: null
  }

  if (win) {
    // 标题栏仍在的旁证：窗口外框比内容区高出一截（Windows 约 31~39px）
    const b = win.getBounds()
    const c = win.getContentBounds()
    out.titleBarHeight = b.height - c.height
    out.hasWindowChrome = out.titleBarHeight > 0
    out.webContentsOk = !win.webContents.isCrashed()
    out.url = win.webContents.getURL().split('/').pop()

    try {
      const img = await win.capturePage()
      const p = path.join(UD, 'window.png')
      fs.writeFileSync(p, img.toPNG())
      out.shot = p
    } catch (e) {
      out.shotError = String(e && e.message)
    }
  }

  console.log('===MENU_START===')
  console.log(JSON.stringify(out, null, 2))
  console.log('===MENU_END===')
  app.exit(0)
}

main().catch((e) => {
  console.log('===MENU_FATAL===', e && e.stack)
  app.exit(1)
})
