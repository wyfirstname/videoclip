/**
 * 校验打包后的 app.asar：
 *  1) 只包含构建产物 + 依赖，不含源码/脚本/文档/用户数据
 *  2) 不含任何密钥痕迹（与 scripts/scan-secrets.js 同一套规则）
 *  3) 主进程代码确实是最新构建（关键标记字符串）
 *
 * 用法: node test/e2e/verify-asar.js [asar 路径]
 *       不带参数时，自动选取最新生成的 release... / win-unpacked / resources / app.asar
 */
const asar = require('@electron/asar')
const fs = require('fs')
const path = require('path')
const { PATTERNS } = require('../../scripts/scan-secrets')

/** 自动找最新的打包产物（release/、release22/ 等任意 release* 目录，含一层版本子目录） */
function findLatestAsar() {
  if (process.env.ASAR_PATH) return process.env.ASAR_PATH
  const root = path.resolve(__dirname, '../..')
  const found = []
  for (const d of fs.readdirSync(root).filter((x) => /^release/i.test(x))) {
    const dir = path.join(root, d)
    if (!fs.statSync(dir).isDirectory()) continue
    const cands = [path.join(dir, 'win-unpacked', 'resources', 'app.asar')]
    for (const sub of fs.readdirSync(dir)) {
      cands.push(path.join(dir, sub, 'win-unpacked', 'resources', 'app.asar'))
    }
    for (const cand of cands) {
      try {
        if (fs.existsSync(cand)) found.push({ p: cand, t: fs.statSync(cand).mtimeMs })
      } catch {
        /* ignore */
      }
    }
  }
  found.sort((a, b) => b.t - a.t)
  if (!found.length) {
    throw new Error(
      '未找到任何打包产物 app.asar。请先 `npm run dist:win`，或用 `node test/e2e/verify-asar.js <asar路径>` 指定。'
    )
  }
  return found[0].p
}

const ASAR = process.argv[2] || findLatestAsar()
const norm = (p) => p.replace(/\\/g, '/').replace(/^\//, '')
const files = asar.listPackage(ASAR)
const read = (name) => {
  const hit = files.find((f) => norm(f) === name)
  if (!hit) throw new Error(`asar 内缺少 ${name}`)
  // @electron/asar 的 extractFile 不接受前导分隔符
  return asar.extractFile(ASAR, hit.replace(/^[\\/]/, '')).toString('utf-8')
}

const out = { asar: ASAR, sizeMB: +(fs.statSync(ASAR).size / 1024 / 1024).toFixed(1), entries: files.length }

// 1) 目录结构
out.buildEntries = files.filter((f) => norm(f).startsWith('out/')).map(norm).sort()
// 只看「自己的」条目：node_modules 里第三方包自带的 docs/ 测试证书等不算问题
const ownEntries = files.filter((f) => !norm(f).startsWith('node_modules/'))
const forbidden = ownEntries.filter((f) =>
  /(^|\/)(\.env|settings\.json|test|scripts|docs)(\/|$)|\.(pem|key|p12|crt|log)$/i.test(norm(f))
)
out.forbiddenEntries = forbidden.length ? forbidden.slice(0, 10) : '无'

// 2) 密钥扫描（整个 asar 二进制，字符串明文存储）
const text = fs.readFileSync(ASAR).toString('utf-8')
const hits = []
for (const { name, re } of PATTERNS) {
  re.lastIndex = 0
  let m
  while ((m = re.exec(text)) !== null) {
    hits.push({ rule: name, sample: m[0].slice(0, 6) + '…' })
    if (hits.length > 20) break
  }
}
out.secretHits = hits.length ? hits : 0

// 3) 代码新鲜度标记
const main = read('out/main/index.js')
out.mainKB = +(main.length / 1024).toFixed(0)
out.mainMarkers = {
  setApplicationMenu: main.includes('setApplicationMenu'),
  autoHideMenuBar: main.includes('autoHideMenuBar'),
  redactSecrets: main.includes('redactSecrets'),
  mediaRange: main.includes('Accept-Ranges')
}
out.rendererAssets = files.filter((f) => norm(f).startsWith('out/renderer/')).map(norm)

console.log(JSON.stringify(out, null, 2))

const pass =
  out.forbiddenEntries === '无' && out.secretHits === 0 && Object.values(out.mainMarkers).every(Boolean)
console.log(pass ? '===VERIFY_PASS===' : '===VERIFY_FAIL===')
process.exit(pass ? 0 : 1)
