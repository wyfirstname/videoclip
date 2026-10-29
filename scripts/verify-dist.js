/*
 * 发布产物「无密钥」验收：直接对内层 app.asar 做真实密钥原文扫描。
 *
 * 与 beforePack/afterPack 的「模式扫描」互补 —— 那两个防的是「新引入的密钥写法」，
 * 这个防的是「本机正在用的那把 key 被带进包里」，用字面量比对，任何格式都跑不掉。
 *
 * 用法:
 *   node scripts/verify-dist.js                       # 自动取最新的安装包
 *   node scripts/verify-dist.js "<安装包路径>"          # 指定安装包
 *   node scripts/verify-dist.js --unpacked "<win-unpacked 目录>"   # 直接查目录
 *
 * 退出码 0 = 通过，1 = 有问题（可接进 CI / 发布前手工闸门）
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFileSync } = require('child_process')

const ROOT = path.resolve(__dirname, '..')
const SEVEN = path.join(ROOT, 'node_modules', '7zip-bin', 'win', 'x64', '7za.exe')
const FORBIDDEN = /(^|\/)(\.env[^/]*|settings\.json|[^/]*\.(pem|key|p12|crt))$/i
// 说明：
//   后两项是「整合包制作方信息栏」（顶部 + 底部），用于确认打进去的是含该改动的版本；
//   「切片合集 / individualClips」是「导出内容可任选」功能的产物名与字段名，
//   用于确认合集拼接 + 单个切片/合集独立勾选的代码确实入了包。
const MARKERS = [
  'setApplicationMenu',
  'redactSecrets',
  '***REDACTED***',
  '莹百游素材铺',
  'zyyzing',
  '切片合集',
  'individualClips'
]

const fails = []
const oks = []
const ok = (m) => oks.push(m)
const bad = (m) => fails.push(m)

// ---------- 1. 取真实密钥（仅用于比对，绝不打印原文） ----------
function realKeys() {
  const out = []
  for (const dir of ['vclip', 'VClip']) {
    const f = path.join(process.env.APPDATA || '', dir, 'settings.json')
    try {
      const k = JSON.parse(fs.readFileSync(f, 'utf-8')).llm.apiKey
      if (k && k.length >= 8 && !out.includes(k)) out.push(k)
    } catch {
      /* 没有就是没有 */
    }
  }
  return out
}

function variants(keys) {
  const vs = []
  for (const k of keys) {
    vs.push({ n: 'utf8', b: Buffer.from(k, 'utf-8') })
    vs.push({ n: 'utf16le', b: Buffer.from(k, 'utf-16le') })
    const b64 = Buffer.from(k, 'utf-8').toString('base64')
    vs.push({ n: 'base64', b: Buffer.from(b64, 'utf-8') })
    vs.push({ n: 'base64url', b: Buffer.from(b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''), 'utf-8') })
    const body = k.replace(/^[a-z-]{2,4}-/i, '')
    if (body.length >= 24) vs.push({ n: 'key-body', b: Buffer.from(body.slice(0, 24), 'utf-8') })
  }
  return vs
}

// ---------- 2. 定位被测产物 ----------
function findInstaller() {
  const found = []
  const pushIfInstaller = (dir) => {
    for (const f of fs.readdirSync(dir)) {
      if (/^VClip Setup .+\.exe$/i.test(f)) {
        const p = path.join(dir, f)
        found.push({ p, t: fs.statSync(p).mtimeMs })
      }
    }
  }
  const topDirs = fs.readdirSync(ROOT).filter((d) => /^release/i.test(d) && fs.statSync(path.join(ROOT, d)).isDirectory())
  for (const d of topDirs) {
    const dir = path.join(ROOT, d)
    pushIfInstaller(dir)
    // 兼容 release/<version>/ 这种两层布局（electron-builder 默认 output 模板）
    for (const sub of fs.readdirSync(dir)) {
      const subDir = path.join(dir, sub)
      try {
        if (fs.statSync(subDir).isDirectory()) pushIfInstaller(subDir)
      } catch {
        /* ignore */
      }
    }
  }
  found.sort((a, b) => b.t - a.t)
  return found[0] && found[0].p
}

/*
 * 本机 node_modules 里的 7za.exe 有时会处于「被锁定/待删除」状态：
 * 文件明明存在，但 spawnSync 直接抛 EBUSY（errno -4082），导致解包静默失败。
 * 实测把该 exe 复制一份到临时目录后即可正常执行，故这里做「原路径 → 副本」两段式尝试。
 */
let sevenZipPath = null

function sevenZipCandidates() {
  const list = []
  if (sevenZipPath) list.push(sevenZipPath)
  if (fs.existsSync(SEVEN)) list.push(SEVEN)
  if (!sevenZipPath && fs.existsSync(SEVEN)) {
    try {
      const alt = path.join(os.tmpdir(), `vclip-7za-${process.pid}.exe`)
      fs.copyFileSync(SEVEN, alt)
      sevenZipPath = alt
      list.push(alt)
    } catch {
      /* 复制失败就只试原路径 */
    }
  }
  return list
}

function extractAsar(installer, tmpDir) {
  fs.mkdirSync(tmpDir, { recursive: true })
  const args = ['x', installer, 'resources\\app.asar', `-o${tmpDir}`, '-y']
  const errs = []
  for (const exe of sevenZipCandidates()) {
    try {
      execFileSync(exe, args, { stdio: 'pipe' })
      const p = path.join(tmpDir, 'resources', 'app.asar')
      if (fs.existsSync(p)) return p
      errs.push(`${path.basename(exe)}: 执行成功但未产出 app.asar`)
    } catch (e) {
      errs.push(`${path.basename(exe)}: ${e.code || e.message}`)
    }
  }
  throw new Error('解包失败（' + errs.join(' | ') + '）')
}

// ---------- 3. 主流程 ----------
function main() {
  const argv = process.argv.slice(2)
  let asarPath = null
  let installer = null

  if (argv[0] === '--unpacked') {
    asarPath = path.join(argv[1], 'resources', 'app.asar')
    installer = `(unpacked) ${argv[1]}`
    if (!fs.existsSync(asarPath)) {
      console.log(`✗ 找不到 ${asarPath}`)
      process.exit(1)
    }
  } else {
    installer = argv[0] || findInstaller()
    if (!installer || !fs.existsSync(installer)) {
      console.log('✗ 未找到安装包，请显式传入路径')
      process.exit(1)
    }
  }

  console.log('=== 发布产物无密钥验收 ===')
  console.log('产物:', installer)
  console.log('大小:', installer.startsWith('(') ? '-' : `${(fs.statSync(installer).size / 1024 / 1024).toFixed(1)}MB`)

  const keys = realKeys()
  console.log(
    '本机已保存密钥:',
    keys.length ? keys.map((k) => `${k.slice(0, 6)}***${k.slice(-4)}(len=${k.length})`).join(', ') : '(无，退化为仅结构检查)'
  )
  const vs = variants(keys)

  const tmpDir = path.join(os.tmpdir(), `vclip-verify-${Date.now()}`)
  let tmpAsar = null
  let degraded = null
  if (!asarPath) {
    try {
      tmpAsar = extractAsar(installer, tmpDir)
      asarPath = tmpAsar
      console.log('已从安装包内层解出 app.asar:', (fs.statSync(tmpAsar).size / 1024 / 1024).toFixed(1) + 'MB')
    } catch (e) {
      // 降级：本机安全策略会拦截 node 侧对 7za.exe 的 spawn（EBUSY，bash 通道正常）。
      // NSIS 是把 win-unpacked/resources/app.asar 原样封进安装包的，故该文件可作为等价对象验证。
      const fb = path.join(path.dirname(installer), 'win-unpacked', 'resources', 'app.asar')
      if (!fs.existsSync(fb)) {
        console.log('✗', e.message)
        console.log('  且未找到同级 win-unpacked/resources/app.asar，无法降级验证')
        process.exit(1)
      }
      degraded = e.message
      asarPath = fb
      console.log('⚠ 安装包内层解包失败：' + e.message)
      console.log('⚠ 降级为验证同级 win-unpacked 的 app.asar（NSIS 原样封装该文件）:')
      console.log('   ' + fb)
      console.log('   如需 100% 确认等价性，请在 bash 通道手工解包并比对 SHA256')
    }
  }

  // 3.1 字面量密钥扫描
  const buf = fs.readFileSync(asarPath)
  const hits = []
  for (const v of vs) {
    const i = buf.indexOf(v.b)
    if (i >= 0) hits.push(`${v.n}@${i}`)
  }
  if (hits.length) bad(`app.asar 内命中真实密钥（变体: ${hits.join(', ')}）`)
  else ok(`真实密钥原文（${vs.length} 个编码变体）在 app.asar 内 0 命中`)

  // 3.1b 降级模式下，额外对安装包本体做明文扫描（压缩后密钥原文不应出现）
  if (degraded && !installer.startsWith('(')) {
    const exeBuf = fs.readFileSync(installer)
    const exeHits = vs.filter((v) => exeBuf.indexOf(v.b) >= 0).map((v) => v.n)
    const mb = (exeBuf.length / 1024 / 1024).toFixed(1)
    if (exeHits.length) bad(`安装包本体命中真实密钥明文（${exeHits.join(', ')}）`)
    else ok(`安装包本体 ${mb}MB 明文扫描 0 命中`)
  }

  // 3.2 结构检查
  let entries = []
  try {
    const asar = require('@electron/asar')
    entries = asar.listPackage(asarPath).map((e) => e.replace(/\\/g, '/').replace(/^\/+/, ''))
  } catch (e) {
    bad('无法列出 asar 内容: ' + (e && e.message))
  }
  const forbidden = entries.filter((e) => FORBIDDEN.test(e))
  if (forbidden.length) bad('包内含敏感文件: ' + forbidden.slice(0, 5).join(', '))
  else ok(`无 settings.json / .env / *.pem / *.key（共 ${entries.length} 个条目）`)

  if (!entries.some((e) => e.startsWith('out/main/'))) bad('缺少 out/main/ 构建产物')
  else ok('包含 out/main 构建产物')

  // 3.3 代码标记（确认打的是新代码，而不是拿旧包冒充）
  const text = buf.toString('utf-8')
  const missing = MARKERS.filter((m) => !text.includes(m))
  if (missing.length) bad('asar 内缺少代码标记: ' + missing.join(', '))
  else ok(`代码标记齐备: ${MARKERS.join(', ')}`)

  if (tmpAsar) {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    } catch {
      console.log('（临时解包目录清理失败，可手工删:', tmpDir, '）')
    }
  }

  console.log('\n--- 检查项 ---')
  for (const o of oks) console.log('  ✓', o)
  for (const f of fails) console.log('  ✗', f)
  if (degraded) {
    console.log('\n⚠ 注意：本次未解安装包内层（7za 被本机安全策略拦截），')
    console.log('  验证对象是同级 win-unpacked/resources/app.asar。结构/密钥结论同样有效，')
    console.log('  但「内层与外层字节一致」需在 bash 通道手工核对 SHA256。')
  }
  console.log(fails.length ? '\n===VERIFY_DIST_FAIL===' : '\n===VERIFY_DIST_PASS===')
  process.exit(fails.length ? 1 : 0)
}

main()
