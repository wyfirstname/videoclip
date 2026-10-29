/**
 * e2e 脚本公共前置：定位 ffmpeg / ffprobe。
 *
 * 为什么需要它：
 *   应用打包后靠 extraResources 把 ffmpeg 放到 resources/ffmpeg-bin；
 *   开发时靠 app.getAppPath()/build/ffmpeg-bin。
 *   但**直接用 electron 跑 test/e2e/xxx.js 时**，app.getAppPath() 并不是项目根，
 *   两条路径都落空 → 导出报「未找到可用的 FFmpeg」、project:create 探不到时长（duration=0）
 *   → 时间轴定位/联动的断言也会连带失败。
 *
 *   这里由测试脚本显式把 ffmpeg 路径写进 settings.ffmpegPath，
 *   让应用走「用户指定路径」这一条分支（应用侧无需改动）。
 */
const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '../..')
const MIN_BIN_SIZE = 64 * 1024

function pick(list) {
  for (const c of list) {
    try {
      if (c && fs.statSync(c).isFile() && fs.statSync(c).size > MIN_BIN_SIZE) return c
    } catch {
      /* 下一个候选 */
    }
  }
  return null
}

function ffmpegStatic() {
  try {
    const p = require(path.join(ROOT, 'node_modules', 'ffmpeg-static'))
    return typeof p === 'string' ? p : null
  } catch {
    return null
  }
}

const ffmpegPath = pick([
  path.join(ROOT, 'build', 'ffmpeg-bin', 'ffmpeg.exe'),
  path.join(ROOT, 'build', 'ffmpeg-bin', 'ffmpeg'),
  ffmpegStatic()
])

const ffprobePath = pick([
  path.join(ROOT, 'build', 'ffmpeg-bin', 'ffprobe.exe'),
  path.join(ROOT, 'build', 'ffmpeg-bin', 'ffprobe')
])

/**
 * 可直接展开进 settings 的补丁对象。
 * 找不到 ffmpeg 时返回空对象 —— 不写脏值，保持应用原有的回退逻辑。
 */
function settingsPatch() {
  const patch = {}
  if (ffmpegPath) patch.ffmpegPath = ffmpegPath
  return patch
}

/** 打印一行解析结果，便于排查（脚本里可选调用） */
function logResolved() {
  if (ffmpegPath) console.log('[e2e] ffmpeg  ->', ffmpegPath)
  else console.warn('[e2e] 未找到 ffmpeg：导出/时长探测会失败（请确认 build/ffmpeg-bin 存在）')
  if (ffprobePath) console.log('[e2e] ffprobe ->', ffprobePath)
}

/**
 * 往隔离的 userData 目录里预写 settings.json（合并 ffmpegPath），
 * 必须在 require 应用主进程之前调用。
 * 应用侧 getSettings() 每次调用都重新读文件，所以写文件即生效。
 */
function seedSettings(userDataDir) {
  if (!ffmpegPath) return null
  const file = path.join(userDataDir, 'settings.json')
  let cur = {}
  try {
    cur = JSON.parse(fs.readFileSync(file, 'utf-8'))
  } catch {
    /* 首次运行没有该文件 */
  }
  cur.ffmpegPath = ffmpegPath
  fs.mkdirSync(userDataDir, { recursive: true })
  fs.writeFileSync(file, JSON.stringify(cur, null, 2), 'utf-8')
  return file
}

/**
 * 把项目里的预置模型挂到隔离 userData 下（应用优先读 userData/models）。
 * 同样是因为源码直接跑 e2e 时 app.getAppPath() 不是项目根，
 * 应用自带的 models/ 探测不到，ASR 类脚本会报「模型未下载」。
 * 用目录联接（junction），Windows 下无需管理员权限。
 */
function ensureModelsLink(userDataDir) {
  const src = path.join(ROOT, 'models')
  const dst = path.join(userDataDir, 'models')
  try {
    if (!fs.existsSync(src) || fs.existsSync(dst)) return dst
    fs.mkdirSync(userDataDir, { recursive: true })
    fs.symlinkSync(src, dst, 'junction')
    console.log('[e2e] models  ->', dst, '→', src)
    return dst
  } catch (e) {
    console.warn('[e2e] 模型目录联接失败（ASR 脚本可能报「模型未下载」）:', e.message)
    return null
  }
}

/** 一次搞定所有前置：写 settings + 挂模型目录。需在 require 应用主进程之前调用。 */
function prepare(userDataDir) {
  const settingsFile = seedSettings(userDataDir)
  ensureModelsLink(userDataDir)
  return settingsFile
}

module.exports = {
  ROOT,
  ffmpegPath,
  ffprobePath,
  settingsPatch,
  logResolved,
  seedSettings,
  ensureModelsLink,
  prepare
}
