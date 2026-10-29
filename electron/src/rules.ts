import { randomUUID } from 'crypto'
import { Clip, SubtitleSegment } from '../../shared/types'

/**
 * 规则切片引擎（不依赖 LLM）
 * 用途：
 *  1) AI 分析没有产出切片时兜底，保证「有字幕就有切片」
 *  2) 未配置 LLM API Key 时也能直接切片
 * 策略：把字幕按语义边界（句末标点 / 静音停顿 / 单句字数上限）切成句子，
 *      再把相邻句子聚合成时长合适的切片（时长阈值随素材总长自适应）。
 */

export interface DurationRange {
  /** 单句/切片的最短时长（秒） */
  min: number
  /** 期望切片时长（秒） */
  target: number
  /** 切片最长时长（秒） */
  max: number
}

export interface RuleClipOptions extends Partial<DurationRange> {
  /** 切片数量上限，超出按评分取前 N */
  maxClips?: number
  /** 单句字数上限（无标点时按此断句） */
  maxCharsPerSentence?: number
  /** 相邻字幕间隔超过该秒数视为话题停顿，强制断句 */
  pauseGap?: number
}

/** 句末标点：出现即视为一个语义完整的句子 */
const SENTENCE_END = /[。！？!?…；;]$/
/** 句中断句标点：字数超限时可在此处断开 */
const CLAUSE_END = /[，,、：:）)】」』"']$/

/**
 * 按素材总时长推导切片时长区间。
 * 短视频（<30s）整体一段；长视频切片控制在 15~75 秒。
 */
export function adaptiveDurations(totalDuration: number): DurationRange {
  const total = Math.max(1, Number(totalDuration) || 0)
  const min = Math.min(10, Math.max(3, total * 0.02))
  const target = Math.min(75, Math.max(15, total * 0.08))
  const max = Math.max(target * 1.8, target + 5)
  return { min: round1(min), target: round1(target), max: round1(max) }
}

function round1(n: number): number {
  return Math.round(n * 10) / 10
}

interface Sentence {
  start: number
  end: number
  text: string
}

/** 把字幕段聚合成句子（语义边界优先，其次停顿/字数） */
export function buildSentences(
  segments: SubtitleSegment[],
  maxCharsPerSentence = 42,
  pauseGap = 1.2
): Sentence[] {
  const sorted = [...segments]
    .filter((s) => s && s.text && s.end > s.start)
    .sort((a, b) => a.start - b.start)

  const sentences: Sentence[] = []
  let buf = ''
  let start = -1
  let end = 0
  let prevEnd = -1

  const flush = (): void => {
    const text = buf.trim()
    if (text && start >= 0) sentences.push({ start, end, text })
    buf = ''
    start = -1
  }

  for (const seg of sorted) {
    const text = seg.text.trim()
    if (!text) continue
    // 停顿过长：先收尾上一句
    if (prevEnd >= 0 && seg.start - prevEnd > pauseGap) flush()
    if (start < 0) start = seg.start
    buf += text
    end = seg.end
    prevEnd = seg.end

    if (SENTENCE_END.test(text)) {
      flush()
      continue
    }
    // 无标点时按字数断句，尽量落在逗号处
    if (buf.length >= maxCharsPerSentence) {
      if (CLAUSE_END.test(text)) {
        flush()
      } else if (buf.length >= maxCharsPerSentence * 1.6) {
        flush()
      }
    }
  }
  flush()
  return sentences
}

/** 每个切片内含的句子数量没有限制，靠时长控制边界 */
function groupSentences(sentences: Sentence[], range: DurationRange): Sentence[][] {
  const groups: Sentence[][] = []
  let cur: Sentence[] = []

  const curDuration = (): number => (cur.length ? cur[cur.length - 1].end - cur[0].start : 0)

  for (const s of sentences) {
    if (cur.length === 0) {
      cur.push(s)
      continue
    }
    const nextDuration = s.end - cur[0].start
    // 已达期望时长 → 断；或超过最大时长 → 必须断
    if (curDuration() >= range.target || nextDuration > range.max) {
      groups.push(cur)
      cur = [s]
      continue
    }
    cur.push(s)
  }
  if (cur.length) groups.push(cur)
  return groups
}

/** 过短片段并入相邻片段，避免出现大量 1~2 秒的碎片 */
function mergeShort(groups: Sentence[][], range: DurationRange): Sentence[][] {
  if (groups.length <= 1) return groups
  const out: Sentence[][] = []
  for (const g of groups) {
    const dur = g[g.length - 1].end - g[0].start
    if (dur < range.min && out.length) {
      const prev = out[out.length - 1]
      const mergedDur = g[g.length - 1].end - prev[0].start
      // 合并后不超上限才合并，否则单独保留
      if (mergedDur <= range.max * 1.25) {
        out[out.length - 1] = [...prev, ...g]
        continue
      }
    }
    out.push(g)
  }
  return out
}

/** 生成标题：取自片段开头，去掉标点、截断到合适长度 */
function makeTitle(text: string): string {
  const clean = text.replace(/\s+/g, '').replace(/^[，,。.、；;：:！!？?]+/, '')
  if (clean.length <= 20) return clean || '未命名切片'
  return clean.slice(0, 18) + '…'
}

/** 规则评分：时长是否落在理想区间 + 语速信息密度，0.30~0.80 */
function makeScore(duration: number, chars: number, range: DurationRange): number {
  let score = 0.45
  if (duration >= range.min && duration <= range.max) score += 0.12
  if (duration >= range.target * 0.7 && duration <= range.target * 1.3) score += 0.1
  const density = duration > 0 ? chars / duration : 0
  if (density >= 2) score += 0.08 // 语速足够，信息密度高
  if (chars >= 30) score += 0.05
  return Math.max(0.3, Math.min(0.8, Math.round(score * 100) / 100))
}

/** 规则切片主入口 */
export function ruleBasedClips(
  segments: SubtitleSegment[],
  options: RuleClipOptions = {}
): Clip[] {
  const sentences = buildSentences(segments, options.maxCharsPerSentence, options.pauseGap)
  if (!sentences.length) return []

  const span = sentences[sentences.length - 1].end - sentences[0].start
  const auto = adaptiveDurations(span)
  const range: DurationRange = {
    min: options.min ?? auto.min,
    target: options.target ?? auto.target,
    max: options.max ?? auto.max
  }

  const groups = mergeShort(groupSentences(sentences, range), range)

  let clips: Clip[] = groups.map((g) => {
    const start = round1(g[0].start)
    const end = round1(g[g.length - 1].end)
    const text = g.map((s) => s.text).join('')
    const duration = round1(end - start)
    return {
      id: randomUUID().slice(0, 8),
      title: makeTitle(text),
      summary: text.slice(0, 80),
      start,
      end,
      score: makeScore(duration, text.length, range),
      reason: `规则切片：时长 ${duration} 秒 / ${text.length} 字，按语义边界自动聚合`,
      selected: true,
      edited: false,
      source: 'rule' as const
    }
  })

  const maxClips = options.maxClips ?? 30
  if (clips.length > maxClips) {
    const keep = new Set(
      [...clips]
        .sort((a, b) => b.score - a.score)
        .slice(0, maxClips)
        .map((c) => c.id)
    )
    clips = clips.filter((c) => keep.has(c.id))
  }

  return clips.sort((a, b) => a.start - b.start)
}
