/*
 * 用「真实 API Key 原文」在指定目录里做逐字节搜索（不是模式匹配，不会漏改格式的 key）。
 * 同时覆盖 UTF-8 / UTF-16LE / Base64 / Base64URL 四种编码变体。
 *
 * 用法: node test/e2e/scan-real-key.js [root1] [root2] ...
 *       node test/e2e/scan-real-key.js --default   # 扫项目全树 + 用户数据目录
 *
 * 输出只打印命中文件路径与偏移，密钥一律以掩码形式呈现（如 sk-abc***456），绝不打印原文。
 *
 * 退出码：0 = 未在「不该出现的位置」找到密钥
 *            （默认扫描时，密钥只存在于用户数据目录属预期，仍为 0）
 *         1 = 在用户数据目录之外（例如项目树 / 打包产物）命中了密钥原文
 */
const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '../..')
const APPDATA = process.env.APPDATA || path.join(process.env.USERPROFILE || '', 'AppData', 'Roaming')
const SETTINGS_CANDIDATES = [
  path.join(APPDATA, 'vclip', 'settings.json'),
  path.join(APPDATA, 'VClip', 'settings.json')
]

function readKeys() {
  const keys = []
  for (const f of SETTINGS_CANDIDATES) {
    try {
      const s = JSON.parse(fs.readFileSync(f, 'utf-8'))
      const k = s && s.llm && s.llm.apiKey
      if (k && k.length >= 8 && !keys.includes(k)) keys.push(k)
    } catch {
      /* ignore */
    }
  }
  return keys
}

function variantsOf(key) {
  const out = [{ name: 'utf8', bytes: Buffer.from(key, 'utf-8') }]
  out.push({ name: 'utf16le', bytes: Buffer.from(key, 'utf-16le') })
  const b64 = Buffer.from(key, 'utf-8').toString('base64')
  out.push({ name: 'base64', bytes: Buffer.from(b64, 'utf-8') })
  out.push({ name: 'base64url', bytes: Buffer.from(b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''), 'utf-8') })
  // 只取 key 的「高熵主干」（去掉 sk- 前缀后 12 字符以上片段），防止只改了前缀就漏
  const body = key.replace(/^[a-z-]{2,4}-/i, '')
  if (body.length >= 24) out.push({ name: 'key-body', bytes: Buffer.from(body.slice(0, 24), 'utf-8') })
  return out
}

const SKIP_DIRS = new Set(['.git', '.cache', 'node_modules_broken'])

function walk(root, onFile) {
  const st = fs.statSync(root)
  if (st.isFile()) return onFile(root)
  const stack = [root]
  while (stack.length) {
    const dir = stack.pop()
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue
        stack.push(p)
      } else if (e.isFile()) {
        onFile(p)
      }
    }
  }
}

function scan(roots, variants) {
  const hits = []
  let scanned = 0
  let bytes = 0
  for (const root of roots) {
    if (!fs.existsSync(root)) continue
    walk(root, (file) => {
      let buf
      try {
        const st = fs.statSync(file)
        if (st.size > 600 * 1024 * 1024) return
        buf = fs.readFileSync(file)
      } catch {
        return
      }
      scanned++
      bytes += buf.length
      for (const v of variants) {
        const idx = buf.indexOf(v.bytes)
        if (idx >= 0) {
          hits.push({ file, variant: v.name, offset: idx, sample: masked(buf, idx, v.bytes.length) })
        }
      }
    })
  }
  return { hits, scanned, bytes }
}

function masked(buf, idx, len) {
  const s = buf.slice(idx, idx + len).toString('utf-8')
  return s.length <= 10 ? s[0] + '***' : s.slice(0, 6) + '***' + s.slice(-4) + ` (len=${s.length})`
}

const keys = readKeys()
if (!keys.length) {
  console.log('[scan-real-key] 未在用户数据目录找到任何已保存的 API Key（无可搜目标）')
  process.exit(0)
}
console.log(`[scan-real-key] 找到 ${keys.length} 个已保存密钥：` + keys.map((k) => k.slice(0, 8) + '***' + k.slice(-4) + `(len=${k.length})`).join(', '))
const variants = []
for (const k of keys) for (const v of variantsOf(k)) if (!variants.some((x) => x.bytes.equals(v.bytes))) variants.push(v)
console.log(`[scan-real-key] 生成 ${variants.length} 个检索变体: ` + variants.map((v) => v.name).join(', '))

const args = process.argv.slice(2).filter((a) => a !== '--default')
const isDefault = args.length === 0
const roots = isDefault ? [ROOT, path.join(APPDATA, 'vclip'), path.join(APPDATA, 'VClip')] : args

console.log('--- 扫描目标 ---')
for (const r of roots) console.log('  ' + r)

const { hits, scanned, bytes } = scan(roots, variants)
console.log('--- 结果 ---')
console.log(`扫描文件 ${scanned} 个，${(bytes / 1024 / 1024).toFixed(1)}MB`)

// 用户数据目录是密钥的「合法住处」——默认扫描包含它，命中属预期，不应判为泄漏。
// 只有出现在用户数据目录之外的命中（尤其项目树里）才是真问题，才让退出码非 0。
const USERDATA_DIRS = [path.join(APPDATA, 'vclip'), path.join(APPDATA, 'VClip')]
const isExpected = (file) => isDefault && USERDATA_DIRS.some((d) => file.startsWith(d))
const expected = hits.filter((h) => isExpected(h.file))
const leaks = hits.filter((h) => !isExpected(h.file))

if (!hits.length) {
  console.log('=== NO_KEY_FOUND === 所有目标中都没有出现密钥原文的任何编码变体')
} else {
  const byRoot = {}
  for (const h of hits) {
    const top = roots.find((r) => h.file.startsWith(r)) || h.file
    byRoot[top] = byRoot[top] || []
    byRoot[top].push(h)
  }
  for (const [root, list] of Object.entries(byRoot)) {
    console.log(`\n[${root}] 命中 ${list.length} 处`)
    for (const h of list.slice(0, 40)) console.log(`  ${h.variant.padEnd(10)} off=${h.offset}  ${h.file}  ${h.sample}`)
  }
}

if (leaks.length) {
  console.log(`\n=== KEY_LEAK_FOUND === 用户数据目录之外命中 ${leaks.length} 处，密钥已扩散到不该出现的位置！`)
} else if (expected.length) {
  console.log(
    `\n=== NO_LEAK === 密钥只存在于用户数据目录（${expected.length} 处，属预期）；` +
      '项目树与打包产物中 0 命中'
  )
} else {
  console.log('\n=== NO_LEAK === 目标中均未出现密钥原文')
}
process.exit(leaks.length ? 1 : 0)
