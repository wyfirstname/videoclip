// electron-builder beforePack hook:
// 1) 脱敏闸门：扫描「即将入包」的内容，发现 API Key / Token / 私钥立即中断打包
// 2) 把 ffmpeg/ffprobe 二进制收集到 build/ffmpeg-bin，随应用打包进 extraResources。
//    优先使用 ffmpeg-static（node_modules），其次使用系统 PATH 中的 ffmpeg。
//
// 注意：ffmpeg-static 的 require.resolve() 返回的是 index.js（脚本），
// 必须用 require('ffmpeg-static') 才能拿到真正的二进制路径。
// 且必须校验体积，避免把脚本文件误当成二进制打进安装包（会导致 spawn UNKNOWN）。
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')
const { assertNoSecrets } = require('./scan-secrets')

const binDir = path.join(__dirname, '..', 'build', 'ffmpeg-bin')
const isWin = process.platform === 'win32'
const ffName = isWin ? 'ffmpeg.exe' : 'ffmpeg'
const fpName = isWin ? 'ffprobe.exe' : 'ffprobe'
// 真实二进制远大于 64KB，脚本文件通常只有几 KB
const MIN_BIN_SIZE = 64 * 1024

function isRealBinary(p) {
  try {
    const st = fs.statSync(p)
    return st.isFile() && st.size > MIN_BIN_SIZE
  } catch {
    return false
  }
}

function findOnPath(name) {
  // Windows 上直接用 where.exe 的绝对路径：裸调 'where' 在某些环境（Git Bash / 沙箱）
  // 会抛 spawnSync EBUSY，导致探测静默失败。多策略逐个尝试，任一成功即返回。
  const cmds = isWin
    ? [path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'where.exe'), 'where.exe', 'where']
    : ['which']
  for (const cmd of cmds) {
    try {
      const out = execFileSync(cmd, [name], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore']
      })
      const p = out
        .split(/\r?\n/)
        .map((s) => s.trim())
        .find((s) => s && isRealBinary(s))
      if (p) return p
    } catch {
      /* 换下一个策略 */
    }
  }
  return null
}

/** build/ffmpeg-bin 里上次留下的二进制：直接复用，避免每次都依赖外部的下载/PATH */
function fromCache(dest) {
  return isRealBinary(dest) ? dest : null
}

function copyBinary(src, dest) {
  if (!src || !isRealBinary(src)) return false
  const size = (fs.statSync(src).size / 1024 / 1024).toFixed(1)
  // 源就是目标本身（缓存命中）时不能再 copyFileSync，Windows 上会 EBUSY/EPERM
  if (path.resolve(src) === path.resolve(dest)) {
    console.log(`[beforePack] reuse ${dest} (${size}MB)`)
    return true
  }
  fs.mkdirSync(binDir, { recursive: true })
  fs.copyFileSync(src, dest)
  console.log(`[beforePack] copied ${src} -> ${dest} (${size}MB)`)
  return true
}

/** ffmpeg-static 导出的是二进制路径；安装不完整时会指向不存在的文件 */
function fromFfmpegStatic() {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const p = require('ffmpeg-static')
    return typeof p === 'string' ? p : null
  } catch {
    return null
  }
}

exports.default = async function () {
  // 0) 脱敏闸门：宁可打包失败，也不能把 API Key 带进安装包
  const { fileCount } = assertNoSecrets()
  console.log(`[beforePack][secret-scan] 已扫描 ${fileCount} 个入包文件，未发现密钥`)

  // 直接覆盖写入（不用 unlinkSync —— 删除在受保护环境中会被安全钩子拦截，
  // 曾导致整个打包流程在 beforePack 处中断）
  fs.mkdirSync(binDir, { recursive: true })

  // ffmpeg: 缓存 -> ffmpeg-static -> 系统 PATH
  const ffmpegDest = path.join(binDir, ffName)
  const ffmpegSrc = [fromCache(ffmpegDest), fromFfmpegStatic(), findOnPath('ffmpeg')].find((p) =>
    isRealBinary(p)
  )
  if (!copyBinary(ffmpegSrc, ffmpegDest)) {
    throw new Error(
      '[beforePack] 未找到可用的 ffmpeg 二进制。请安装 ffmpeg-static 或把 ffmpeg 加入 PATH 后重新打包。'
    )
  }

  // ffprobe: 缓存 -> 系统 PATH（ffmpeg-static 不含 ffprobe）；缺失时运行时回退解析 ffmpeg 输出
  const ffprobeDest = path.join(binDir, fpName)
  if (!copyBinary(fromCache(ffprobeDest) || findOnPath('ffprobe'), ffprobeDest)) {
    console.warn('[beforePack] 未找到 ffprobe，打包后将使用 ffmpeg 输出解析时长。')
  }
}
