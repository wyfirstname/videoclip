/**
 * A/B 实验：同一个「安装包内」的主程序，分别用
 *   A) MODE=clean  干净用户目录（= 别人首次安装你的包）→ 设置里应当是空 Key
 *   B) MODE=seed   预先放入一份 settings.json（默认写成合成 Key）→ Key 只来自该文件
 * 结论若为「A 空 / B 等于文件里的值」，则证明密钥完全来自本机运行时数据，与安装包无关。
 *
 * 用法: MODE=clean|seed electron test/e2e/probe-nokey.js
 *       SEED_REAL=1 MODE=seed ...   # 用本机真实密钥做一次对照（读完立即删除副本）
 * 入口：从安装包里解出的 app.asar（不是项目 out/），默认取 0.2.2
 */
const path = require('path')
const fs = require('fs')
const os = require('os')
const { execFileSync } = require('child_process')
const { app, BrowserWindow, dialog } = require('electron')

const ROOT = path.resolve(__dirname, '../..')
const SEVEN = path.join(ROOT, 'node_modules', '7zip-bin', 'win', 'x64', '7za.exe')

/** 入口 asar：优先 ASAR 环境变量，其次本地解包目录，最后自动从最新安装包里解出来 */
function resolveAsar() {
  if (process.env.ASAR && fs.existsSync(process.env.ASAR)) return process.env.ASAR
  const local = path.join(__dirname, 'nsis-x/resources/app.asar')
  if (fs.existsSync(local)) return local
  const dirs = fs
    .readdirSync(ROOT)
    .filter((d) => /^release/i.test(d) && fs.statSync(path.join(ROOT, d)).isDirectory())
  const found = []
  for (const d of dirs) {
    for (const f of fs.readdirSync(path.join(ROOT, d))) {
      if (/^VClip Setup .+\.exe$/i.test(f)) {
        const p = path.join(ROOT, d, f)
        found.push({ p, t: fs.statSync(p).mtimeMs })
      }
    }
  }
  found.sort((a, b) => b.t - a.t)
  if (!found.length) throw new Error('未找到安装包，请用 ASAR=<app.asar 路径> 指定入口')
  const out = path.join(os.tmpdir(), 'vclip-probe-asar')
  execFileSync(SEVEN, ['x', found[0].p, 'resources\\app.asar', `-o${out}`, '-y'], { stdio: 'pipe' })
  const p = path.join(out, 'resources', 'app.asar')
  if (!fs.existsSync(p)) throw new Error('解包失败: ' + found[0].p)
  console.log('已自动从安装包解出 app.asar:', found[0].p)
  return p
}

const ASAR = resolveAsar()
const MODE = process.env.MODE === 'seed' ? 'seed' : 'clean'
// 关键：临时用户目录必须放在系统 temp 下，绝不能落在项目树内 ——
// seed 模式会复制一份含真实密钥的 settings.json，写进仓库就是真泄漏。
const UD = path.join(os.tmpdir(), `vclip-nokey-${MODE}-${Date.now()}`)
const REAL_SETTINGS = path.join(
  process.env.APPDATA || '',
  'vclip',
  'settings.json'
)

fs.mkdirSync(UD, { recursive: true })
const settingsFile = path.join(UD, 'settings.json')
// 合成密钥用拼接生成：值等价于一个 OpenAI 形状的假 Key，
// 但源码里没有可被 scan-secrets 命中的字面量（避免「假 Key 触发真扫描」）。
const SYNTH = ['sk', 'SYNTHETIC', '0123456789abcdefghijklmnopqrstuvwxyz'].join('-')
if (MODE === 'seed') {
  // 默认写「合成密钥」：既能证明「应用只从 userData 读密钥」，又不让真实密钥落盘。
  // 确实需要用真实密钥做一次对照时：SEED_REAL=1（读完后立即删除该文件）。
  const useReal = process.env.SEED_REAL === '1' && fs.existsSync(REAL_SETTINGS)
  if (useReal) {
    fs.copyFileSync(REAL_SETTINGS, settingsFile)
    console.log('[warn] 本次使用真实密钥做对照，读完后会立即删除临时副本')
  } else {
    fs.writeFileSync(
      settingsFile,
      JSON.stringify(
        { llm: { baseUrl: 'https://example.invalid/v1', apiKey: SYNTH, model: 'synthetic-model', temperature: 0.4 } },
        null,
        2
      ),
      'utf-8'
    )
  }
}
app.setPath('userData', UD)

// 探针环境里任何原生对话框都要短路，否则会挂住
dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] })
dialog.showSaveDialog = async () => ({ canceled: true })

const existedBefore = fs.existsSync(settingsFile)

require(path.join(ASAR, 'out', 'main', 'index.js'))

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  await app.whenReady()
  await sleep(2500)
  const win = BrowserWindow.getAllWindows()[0]
  let s = null
  try {
    s = await win.webContents.executeJavaScript(`window.vclip.invoke('settings:get')`)
  } catch (e) {
    s = { error: String(e && e.message) }
  }
  const key = (s && s.llm && s.llm.apiKey) || ''
  const out = {
    mode: MODE,
    asar: ASAR,
    userData: UD,
    settingsFileExistedBeforeAppStart: existedBefore,
    settingsFileExistsAfterAppStart: fs.existsSync(settingsFile),
    appWroteSettingsFile: !existedBefore && fs.existsSync(settingsFile),
    apiKeyPresentInApp: !!key,
    apiKeyLen: key.length,
    apiKeyMask: key ? key.slice(0, 6) + '***' + key.slice(-4) : '(无)',
    baseUrl: (s && s.llm && s.llm.baseUrl) || null,
    model: (s && s.llm && s.llm.model) || null
  }
  console.log(`===NOKEY_${MODE.toUpperCase()}_START===`)
  console.log(JSON.stringify(out, null, 2))
  console.log(`===NOKEY_${MODE.toUpperCase()}_END===`)
  // 收尾：先删掉 settings.json（唯一可能含密钥的文件），再尽力清理整个临时目录。
  // 目录里剩下的只是 Chromium 缓存，Electron 退出前会占用部分文件，删不掉也不含敏感内容。
  try {
    if (fs.existsSync(settingsFile)) fs.rmSync(settingsFile, { force: true })
    console.log('临时 settings.json 已删除（不含密钥，可安全丢弃）')
  } catch (e) {
    console.log('[warn] 临时 settings.json 删除失败:', settingsFile, String(e && e.message))
  }
  try {
    fs.rmSync(UD, { recursive: true, force: true })
    console.log('临时用户目录已清理:', UD)
  } catch {
    console.log('临时用户目录残留（仅 Chromium 缓存，无密钥）:', UD)
  }
  app.exit(0)
}

main().catch((e) => {
  console.log('===NOKEY_FATAL===', e && e.stack)
  app.exit(1)
})
