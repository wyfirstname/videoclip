// ASR worker 测试夹具：用 stub 的 parentPort 直接驱动构建产物 out/main/asr-worker.js
const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '../..')
const APPDATA = process.env.APPDATA || path.join(process.env.USERPROFILE || '', 'AppData', 'Roaming')

/** 模型目录：优先用户数据目录（应用真实取值顺序），退到项目内预置模型 */
function resolveModelsDir() {
  for (const d of [
    path.join(APPDATA, 'vclip', 'models'),
    path.join(APPDATA, 'VClip', 'models'),
    path.join(ROOT, 'models')
  ]) {
    if (fs.existsSync(path.join(d, 'paraformer-zh-small', 'model.int8.onnx'))) return d
  }
  throw new Error(
    '未找到可用模型（需要 paraformer-zh-small/model.int8.onnx）。请先下载模型，或确认项目 models/ 目录完整。'
  )
}

const APP_MODELS = resolveModelsDir()
const WORKER = path.join(ROOT, 'out', 'main', 'asr-worker.js')
if (!fs.existsSync(WORKER)) {
  throw new Error(`构建产物不存在: ${WORKER}（请先 npm run build）`)
}

const payload = {
  wavPath: path.join(__dirname, 'sample.wav'),
  modelPath: path.join(APP_MODELS, 'paraformer-zh-small', 'model.int8.onnx'),
  tokensPath: path.join(APP_MODELS, 'paraformer-zh-small', 'tokens.txt'),
  type: 'paraformer',
  numThreads: 4,
  vadPath: path.join(APP_MODELS, 'silero_vad.onnx') // 启用 VAD 分段（应用默认路径）
}

const messages = []
let handler = null

process.parentPort = {
  on: (_evt, cb) => {
    handler = cb
  },
  postMessage: (m) => {
    messages.push(m)
    if (m.type === 'progress') {
      process.stdout.write(`\r进度 ${m.percent}% ${m.stage} ${m.detail || ''}          `)
    } else if (m.type === 'done') {
      process.stdout.write('\n')
      console.log(`\n=== 识别完成，共 ${m.segments.length} 条字幕 ===`)
      m.segments.slice(0, 12).forEach((s) =>
        console.log(`[${s.start.toFixed(2)}s - ${s.end.toFixed(2)}s] ${s.text}`)
      )
      console.log(`\n首条: ${JSON.stringify(m.segments[0])}`)
      process.exit(0)
    } else if (m.type === 'error') {
      console.error('\n识别失败:', m.message)
      process.exit(1)
    }
  }
}

require(WORKER)

setTimeout(() => handler({ data: payload }), 50)
setTimeout(() => {
  console.error('超时未返回结果')
  process.exit(1)
}, 600000)
