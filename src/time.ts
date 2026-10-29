/** 时间格式化（渲染进程用） */
export function formatDuration(sec: number): string {
  const s = Math.max(0, Math.floor(sec))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = s % 60
  const p = (n: number): string => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${p(m)}:${p(ss)}` : `${m}:${p(ss)}`
}

/** 时间码：默认 mm:ss，超过 1 小时自动带小时；withMs 时输出 mm:ss.mmm */
export function formatTimecode(sec: number, withMs = false): string {
  const t = Math.max(0, sec)
  const h = Math.floor(t / 3600)
  const m = Math.floor((t % 3600) / 60)
  const s = Math.floor(t % 60)
  const p = (n: number): string => String(n).padStart(2, '0')
  const base = h > 0 ? `${h}:${p(m)}:${p(s)}` : `${p(m)}:${p(s)}`
  if (!withMs) return base
  return `${base}.${String(Math.floor((t % 1) * 1000)).padStart(3, '0')}`
}

/**
 * 解析用户输入的时间码，支持 "90" / "1:30" / "01:02:03" / "1:30.5"。
 * 无法解析时返回 null。
 */
export function parseTimecode(input: string): number | null {
  const str = String(input || '').trim().replace('：', ':')
  if (!str) return null
  const parts = str.split(':')
  if (parts.length > 3) return null
  let total = 0
  for (const part of parts) {
    if (part !== '' && !/^\d*\.?\d*$/.test(part)) return null
    total = total * 60 + (part === '' ? 0 : parseFloat(part))
  }
  return Number.isFinite(total) ? Math.max(0, total) : null
}

export function formatDateTime(ts: number): string {
  const d = new Date(ts)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}
