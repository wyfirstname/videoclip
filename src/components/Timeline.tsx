import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Slider, Button, Space, Tooltip, Input, message } from 'antd'
import { DragOutlined, ExpandOutlined, AimOutlined } from '@ant-design/icons'
import type { Clip, SubtitleSegment } from '../../shared/types'
import { formatTimecode, parseTimecode } from '../time'
import ScrubVideo from './ScrubVideo'

interface TimelineProps {
  duration: number
  currentTime: number
  subtitles: SubtitleSegment[]
  clips: Clip[]
  selectedClipId: string | null
  /** 用于鼠标悬停时抽取画面帧的本地视频地址 */
  videoUrl?: string
  onSeek: (t: number) => void
  onSelectClip: (id: string) => void
  onUpdateClip: (id: string, start: number, end: number) => void
  onToggleSelected?: (id: string) => void
  /** 鼠标在时间轴上的位置发生变化（离开时为 null） */
  onHoverTime?: (t: number | null) => void
}

const THUMB_W = 208
const THUMB_H = 117

type DragState = {
  clipId: string
  mode: 'move' | 'left' | 'right'
  startX: number
  origStart: number
  origEnd: number
} | null

export default function Timeline({
  duration,
  currentTime,
  subtitles,
  clips,
  selectedClipId,
  videoUrl,
  onSeek,
  onSelectClip,
  onUpdateClip,
  onToggleSelected,
  onHoverTime
}: TimelineProps): React.JSX.Element {
  const [scale, setScale] = useState(8) // px / 秒
  const scrollRef = useRef<HTMLDivElement>(null)
  const innerRef = useRef<HTMLDivElement>(null)
  const cardRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<DragState>(null)
  const scrubRef = useRef(false)
  const [dragging, setDragging] = useState(false)
  const [scrubbing, setScrubbing] = useState(false)
  const [hover, setHover] = useState<{ t: number; x: number } | null>(null)
  const [jump, setJump] = useState('')

  const width = Math.max(duration * scale, 0)

  const tickInterval = useMemo(() => {
    // 根据缩放选择合适的刻度间隔（秒）
    const candidates = [1, 2, 5, 10, 30, 60, 120, 300, 600, 900, 1800, 3600]
    for (const c of candidates) {
      if (c * scale >= 60) return c
    }
    return 3600
  }, [scale])

  const ticks = useMemo(() => {
    const arr: number[] = []
    for (let t = 0; t <= duration; t += tickInterval) arr.push(t)
    return arr
  }, [duration, tickInterval])

  const xToTime = useCallback(
    (clientX: number): number => {
      const el = innerRef.current
      if (!el) return 0
      const rect = el.getBoundingClientRect()
      return Math.max(0, Math.min(duration, (clientX - rect.left) / scale))
    },
    [duration, scale]
  )

  // ---- 背景按下拖动擦洗（scrub）：连续定位，视频实时联动 ----
  // 用原生监听而非 React 合成事件：合成事件的 stopPropagation 无法阻止
  // 原生事件先行冒泡，而这里需要在切片块自己的拖动逻辑之前拿到指针。
  useEffect(() => {
    const el = innerRef.current
    if (!el) return
    const onDown = (e: PointerEvent): void => {
      if (e.button !== 0) return
      // 落在切片块上时交给切片拖动处理
      if ((e.target as HTMLElement | null)?.closest?.('.tl-block.clip')) return
      scrubRef.current = true
      setScrubbing(true)
      onSeek(xToTime(e.clientX))
    }
    el.addEventListener('pointerdown', onDown)
    return () => el.removeEventListener('pointerdown', onDown)
  }, [onSeek, xToTime])

  useEffect(() => {
    if (!scrubbing) return
    const onMove = (e: PointerEvent): void => {
      if (!scrubRef.current) return
      onSeek(xToTime(e.clientX))
    }
    const onUp = (): void => {
      scrubRef.current = false
      setScrubbing(false)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    // 指针被系统取消 / 窗口失焦时也要收尾，避免擦洗状态卡死
    window.addEventListener('pointercancel', onUp)
    window.addEventListener('blur', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
      window.removeEventListener('blur', onUp)
    }
  }, [scrubbing, onSeek, xToTime])

  // ---- 切片块拖动 ----
  useEffect(() => {
    const onMove = (e: PointerEvent): void => {
      const drag = dragRef.current
      if (!drag) return
      const dt = (e.clientX - drag.startX) / scale
      let start = drag.origStart
      let end = drag.origEnd
      if (drag.mode === 'move') {
        const len = drag.origEnd - drag.origStart
        start = Math.max(0, Math.min(duration - len, drag.origStart + dt))
        end = start + len
      } else if (drag.mode === 'left') {
        start = Math.max(0, Math.min(drag.origEnd - 1, drag.origStart + dt))
      } else {
        end = Math.max(drag.origStart + 1, Math.min(duration, drag.origEnd + dt))
      }
      // 实时预览（0.1s 精度）
      onUpdateClip(drag.clipId, Math.round(start * 10) / 10, Math.round(end * 10) / 10)
    }
    const onUp = (): void => {
      if (dragRef.current) {
        dragRef.current = null
        setDragging(false)
      }
    }
    if (dragging) {
      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp)
      window.addEventListener('pointercancel', onUp)
      return () => {
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
        window.removeEventListener('pointercancel', onUp)
      }
    }
  }, [dragging, scale, duration, onUpdateClip])

  const startDrag = (e: React.PointerEvent, clip: Clip, mode: 'move' | 'left' | 'right'): void => {
    e.stopPropagation()
    dragRef.current = {
      clipId: clip.id,
      mode,
      startX: e.clientX,
      origStart: clip.start,
      origEnd: clip.end
    }
    onSelectClip(clip.id)
    setDragging(true)
  }

  // ---- 播放头自动滚动 ----
  useEffect(() => {
    const el = scrollRef.current
    if (!el || dragging || scrubbing) return
    const x = currentTime * scale
    const viewLeft = el.scrollLeft
    const viewRight = viewLeft + el.clientWidth
    if (x < viewLeft + 40 || x > viewRight - 40) {
      el.scrollLeft = Math.max(0, x - el.clientWidth / 2)
    }
  }, [currentTime, scale, dragging, scrubbing])

  const fitToWindow = (): void => {
    const el = scrollRef.current
    if (el && duration > 0) {
      setScale(Math.max(0.5, el.clientWidth / duration))
    }
  }

  const setHoverAt = (clientX: number): void => {
    const t = xToTime(clientX)
    const card = cardRef.current
    const x = card ? clientX - card.getBoundingClientRect().left : 0
    setHover({ t, x })
    onHoverTime?.(t)
  }

  const clearHover = (): void => {
    setHover(null)
    onHoverTime?.(null)
  }

  const doJump = (): void => {
    const t = parseTimecode(jump)
    if (t === null) {
      message.warning('请输入时间码，例如 90 / 1:30 / 01:02:03')
      return
    }
    onSeek(Math.min(t, duration || t))
  }

  // 悬停时刻的当前字幕文本，帮助快速定位内容
  const hoverSubtitle = hover
    ? subtitles.find((s) => hover.t >= s.start && hover.t < s.end)?.text
    : undefined

  const cardWidth = cardRef.current?.clientWidth || 900
  const tooltipLeft = hover ? Math.max(THUMB_W / 2 + 4, Math.min(hover.x, cardWidth - THUMB_W / 2 - 4)) : 0

  return (
    <div className="timeline-card" ref={cardRef}>
      {/* 悬停缩略预览（跟随鼠标位置显示对应画面） */}
      {hover && videoUrl && !dragging && (
        <div className="tl-hover" style={{ left: tooltipLeft }}>
          <ScrubVideo
            src={videoUrl}
            time={hover.t}
            className="tl-hover-video"
            style={{ width: THUMB_W, height: THUMB_H }}
          />
          <div className="tl-hover-meta">
            <span className="tl-hover-tc">{formatTimecode(hover.t, true)}</span>
            {hoverSubtitle && <span className="tl-hover-text">{hoverSubtitle}</span>}
          </div>
          <div className="tl-hover-caret" />
        </div>
      )}

      <div className="timeline-toolbar">
        <Space size={8} style={{ flex: 1 }}>
          <span style={{ fontSize: 13, color: '#666' }}>
            时间轴
            <span style={{ marginLeft: 8, fontFamily: 'Menlo, Consolas, monospace', color: '#e0455a' }}>
              {formatTimecode(currentTime, true)} / {formatTimecode(duration)}
            </span>
          </span>
          <span style={{ fontSize: 12, color: '#aaa' }}>
            单击/拖动空白处定位 · 拖动切片移动 · 拖动边缘调整起止点
          </span>
        </Space>
        <Space size={6}>
          <Input
            size="small"
            style={{ width: 96 }}
            placeholder="跳转 1:30"
            value={jump}
            onChange={(e) => setJump(e.target.value)}
            onPressEnter={doJump}
            allowClear
          />
          <Tooltip title="跳转到输入的时间码">
            <Button size="small" icon={<AimOutlined />} onClick={doJump} />
          </Tooltip>
          <Tooltip title="缩放">
            <DragOutlined />
          </Tooltip>
          <Slider
            min={1}
            max={80}
            step={1}
            value={scale}
            onChange={(v) => setScale(v)}
            style={{ width: 120, margin: 0 }}
            tooltip={{ formatter: (v) => `${v}px/秒` }}
          />
          <Button size="small" icon={<ExpandOutlined />} onClick={fitToWindow}>
            适配
          </Button>
        </Space>
      </div>
      <div
        className={`timeline-scroll ${scrubbing ? 'scrubbing' : ''}`}
        ref={scrollRef}
        onPointerMove={(e) => setHoverAt(e.clientX)}
        onPointerLeave={clearHover}
      >
        <div
          className="timeline-inner"
          ref={innerRef}
          style={{ width: Math.max(width, 0) }}
        >
          {/* 刻度尺 */}
          <div className="tl-ruler">
            {ticks.map((t) => (
              <div key={t} className="tl-tick" style={{ left: t * scale }}>
                {formatTimecode(t)}
              </div>
            ))}
          </div>
          {/* 字幕轨 */}
          <div className="tl-track subtitles">
            {subtitles.map((s, i) => (
              <div
                key={i}
                className="tl-block sub"
                style={{
                  left: s.start * scale,
                  width: Math.max(2, (s.end - s.start) * scale - 1)
                }}
                title={s.text}
              />
            ))}
          </div>
          {/* 切片轨 */}
          <div className="tl-track clips">
            {clips.map((clip) => (
              <div
                key={clip.id}
                className={`tl-block clip ${clip.id === selectedClipId ? 'selected' : ''} ${
                  clip.selected ? '' : 'unselected'
                }`}
                style={{
                  left: clip.start * scale,
                  width: Math.max(4, (clip.end - clip.start) * scale - 1)
                }}
                title={`${clip.title}\n${clip.summary}\n分数: ${clip.score.toFixed(2)}`}
                onPointerDown={(e) => startDrag(e, clip, 'move')}
                onDoubleClick={(e) => {
                  e.stopPropagation()
                  onToggleSelected?.(clip.id)
                }}
              >
                <div className="handle left" onPointerDown={(e) => startDrag(e, clip, 'left')} />
                <span className="clip-name">{clip.title}</span>
                <div className="handle right" onPointerDown={(e) => startDrag(e, clip, 'right')} />
              </div>
            ))}
          </div>
          {/* 悬停时标线：与缩略图、预监画面对齐 */}
          {hover && (
            <div className="tl-hoverline" style={{ left: hover.t * scale }} />
          )}
          {/* 播放头 */}
          <div className="tl-playhead" style={{ left: currentTime * scale }} />
        </div>
      </div>
    </div>
  )
}
