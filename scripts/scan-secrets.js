/**
 * 敏感信息扫描器：确保 API Key / Token / 私钥不会被打进安装包。
 *
 * 两种用法：
 *   1) 打包闸门（默认）：只扫描「会进入安装包」的内容（asar 的 files 白名单 + extraResources），
 *      由 scripts/beforePack.js 调用，命中即中断打包。
 *   2) 全仓审计：node scripts/scan-secrets.js --all，额外扫描源码/脚本/文档，
 *      用于发现"不小心把 key 写进代码"这类隐患。
 *
 * 命中时只输出掩码片段，不打印完整密钥。
 */
const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')

// 打包时会进入安装包的内容（与 electron-builder.yml 的 files / extraResources 对应）
const PACKAGED_PATHS = ['out', 'build/ffmpeg-bin', 'models', 'package.json']

// 覆盖面更广的仓库路径（仅 --all 审计时扫描）
const AUDIT_ONLY_PATHS = [
  'electron',
  'src',
  'shared',
  'scripts',
  'test',
  'docs',
  'README.md',
  'electron-builder.yml',
  'electron.vite.config.ts'
]

// 这些目录/文件名属于「本来就在本机产生、且会被 .gitignore 忽略」的产物，跳过以免噪音
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.workbuddy',
  'release',
  'release21',
  'release-build',
  'release-final',
  'release-out',
  'dist',
  '.vite'
])
const SKIP_FILE_RE = /\.(png|jpe?g|gif|webp|ico|bmp|woff2?|ttf|eot|zip|7z|exe|dll|node|so|dylib|mp4|mov|mkv|wav|mp3|asar)$/i
// 二进制大文件（ffmpeg.exe 等）只做前一段扫描会漏，整文件扫描代价高，按扩展名跳过即可

const PATTERNS = [
  { name: 'OpenAI 风格 Key (sk-)', re: /\bsk-[A-Za-z0-9_-]{16,}/g },
  { name: 'Bearer Token', re: /\bBearer\s+[A-Za-z0-9._\-]{24,}/g },
  { name: 'Google API Key', re: /\bAIza[0-9A-Za-z_\-]{30,}/g },
  { name: 'GitHub Token', re: /\bgh[pousr]_[A-Za-z0-9]{30,}/g },
  { name: 'Slack Token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/g },
  { name: '阿里云 AccessKey', re: /\bLTAI[A-Za-z0-9]{12,}/g },
  { name: '腾讯云 SecretId', re: /\bAKID[A-Za-z0-9]{13,}/g },
  { name: '私钥文件块', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
  {
    name: '字面量密钥赋值',
    // apiKey: 'sk-xxx' / API_KEY="..." / password: '...' —— 变量引用（apiKey: this.apiKey）不算
    re: /(?:api[_-]?key|apikey|access[_-]?token|auth[_-]?token|secret[_-]?key|password)\s*[:=]\s*['"`][^'"`\s]{16,}['"`]/gi
  }
]

/** 掩码：只保留首尾少量字符，便于定位又不泄露 */
function mask(s) {
  const t = s.replace(/\s+/g, ' ').trim()
  if (t.length <= 10) return t[0] + '***'
  return `${t.slice(0, 6)}…${t.slice(-3)}(len=${t.length})`
}

function walk(target, out, root) {
  const abs = path.join(root, target)
  let st
  try {
    st = fs.statSync(abs)
  } catch {
    return
  }
  if (st.isFile()) {
    out.push(abs)
    return
  }
  for (const name of fs.readdirSync(abs)) {
    if (SKIP_DIRS.has(name)) continue
    const p = path.join(abs, name)
    let s
    try {
      s = fs.statSync(p)
    } catch {
      continue
    }
    if (s.isDirectory()) walk(path.relative(root, p), out, root)
    else out.push(p)
  }
}

function scanFile(file) {
  const rel = path.relative(ROOT, file)
  if (SKIP_FILE_RE.test(file)) return []
  // 跳过明显是测试/示例的假 key 文件？不做特判，宁可多报
  let text
  try {
    const buf = fs.readFileSync(file)
    if (buf.length > 32 * 1024 * 1024) return [] // 超大文件跳过
    text = buf.toString('utf-8')
  } catch {
    return []
  }
  const hits = []
  for (const { name, re } of PATTERNS) {
    re.lastIndex = 0
    let m
    while ((m = re.exec(text)) !== null) {
      const line = text.slice(0, m.index).split('\n').length
      hits.push({ file: rel, line, rule: name, sample: mask(m[0]) })
      if (hits.length > 200) return hits
    }
  }
  return hits
}

function run(targets) {
  const files = []
  for (const t of targets) walk(t, files, ROOT)
  const hits = []
  for (const f of files) hits.push(...scanFile(f))
  return { fileCount: files.length, hits }
}

function main() {
  const all = process.argv.includes('--all')
  const targets = all ? [...PACKAGED_PATHS, ...AUDIT_ONLY_PATHS] : PACKAGED_PATHS
  const { fileCount, hits } = run(targets)

  const label = all ? '全仓审计' : '打包入包内容'
  console.log(`[secret-scan] ${label}：扫描 ${fileCount} 个文件，命中 ${hits.length} 处`)
  for (const h of hits.slice(0, 40)) {
    console.log(`  ✗ ${h.file}:${h.line} [${h.rule}] ${h.sample}`)
  }
  if (hits.length > 40) console.log(`  … 其余 ${hits.length - 40} 处省略`)

  return { fileCount, hits }
}

/** 供 beforePack 调用的闸门：命中即抛错中断打包 */
function assertNoSecrets() {
  const { fileCount, hits } = run(PACKAGED_PATHS)
  if (hits.length) {
    const detail = hits
      .slice(0, 10)
      .map((h) => `    ${h.file}:${h.line} [${h.rule}] ${h.sample}`)
      .join('\n')
    throw new Error(
      `[secret-scan] 检测到 ${hits.length} 处疑似密钥，已中断打包（防止 API Key 进入安装包）：\n${detail}\n` +
        '  处理方式：删除硬编码密钥，改用「设置页 → AI 配置」在运行时填写（存于用户数据目录，不入包）。'
    )
  }
  return { fileCount }
}

module.exports = { assertNoSecrets, run, PACKAGED_PATHS, AUDIT_ONLY_PATHS, PATTERNS }

if (require.main === module) {
  const { hits } = main()
  process.exit(hits.length ? 1 : 0)
}
