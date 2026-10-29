// 切片合集拼接（ffmpeg concat demuxer）的纯逻辑部分。
// 刻意不 import electron / store，方便用 Electron 宿主单独加载做真实 ffmpeg 验证。
import * as fs from 'fs'

/**
 * 生成 concat demuxer 的清单内容。
 * 路径统一转成正斜杠（避免反斜杠被 ffmpeg 当作转义符），
 * 再用单引号包裹；路径内的单引号按 ffmpeg 的规则写成 '\''。
 */
export function buildConcatList(inputs: string[]): string {
  const lines = inputs.map((p) => `file '${p.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`)
  return lines.join('\n') + '\n'
}

/** 写出清单文件（UTF-8，带中文/长路径的项目路径也能正确解析） */
export function writeConcatList(listFile: string, inputs: string[]): void {
  fs.writeFileSync(listFile, buildConcatList(inputs), 'utf-8')
}

/**
 * 拼接参数。
 * - precise=true：重编码拼接，画面对齐最稳（各切片本就同源同参数，结果一致）
 * - precise=false：优先流复制（秒级，无损），失败时降级重编码（fallback）
 */
export function buildConcatArgs(
  listFile: string,
  outFile: string,
  precise: boolean
): { primary: string[]; fallback: string[] | null } {
  const common = ['-y', '-f', 'concat', '-safe', '0', '-i', listFile]
  const encode = [
    ...common,
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '20',
    '-c:a', 'aac',
    '-b:a', '128k',
    '-movflags', '+faststart',
    outFile
  ]
  if (precise) return { primary: encode, fallback: null }
  return {
    primary: [...common, '-c', 'copy', '-movflags', '+faststart', outFile],
    fallback: encode
  }
}
