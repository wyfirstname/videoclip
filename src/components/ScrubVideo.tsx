import React, { useEffect, useRef } from 'react'

interface Props {
  src: string
  /** 要显示的时刻（秒） */
  time: number
  className?: string
  style?: React.CSSProperties
  /** 首帧就绪回调 */
  onReady?: (duration: number) => void
}

/**
 * 只负责「显示某一时刻画面」的静音预览 video（不做播放）。
 *
 * 为什么不用 canvas 截图：视频走自定义 media:// 协议，canvas 抓帧会被跨源污染，
 * toDataURL 直接抛 SecurityError。直接用 <video> 定位到目标时间点最稳。
 *
 * 高频拖动时的策略：单飞 + rAF 合并。
 * 同一时刻只允许一个 seek 在途，期间新到的目标时间只覆盖 targetRef，
 * seeked 之后再由 rAF 取最新目标 → 天然去抖，不会堆积 seek 请求。
 */
export default function ScrubVideo({
  src,
  time,
  className,
  style,
  onReady
}: Props): React.JSX.Element {
  const ref = useRef<HTMLVideoElement>(null)
  const targetRef = useRef(time)
  const busyRef = useRef(false)
  const guardRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const readyRef = useRef(false)

  targetRef.current = time

  // 换源时重置状态
  useEffect(() => {
    busyRef.current = false
    readyRef.current = false
    return () => {
      if (guardRef.current) clearTimeout(guardRef.current)
      guardRef.current = null
    }
  }, [src])

  // 单飞 seek 循环
  useEffect(() => {
    let raf = 0
    let alive = true

    const release = (): void => {
      busyRef.current = false
      if (guardRef.current) {
        clearTimeout(guardRef.current)
        guardRef.current = null
      }
    }

    const tick = (): void => {
      if (!alive) return
      const v = ref.current
      if (v && v.readyState >= 1 && !busyRef.current) {
        const dur = v.duration && Number.isFinite(v.duration) ? v.duration : targetRef.current
        // 注意：seek 到「正好等于 duration」这个点上，部分解码器会停在原地不触发 seeked，
        // 画面永远出不来。留 50ms 余量，视觉上无差别。
        const t = Math.max(0, Math.min(targetRef.current, Math.max(0, dur - 0.05)))
        if (Math.abs(v.currentTime - t) > 0.04) {
          busyRef.current = true
          // 兜底：个别情况下 seeked 不触发（如目标点与当前点落在同一帧），
          // 用超时解锁，避免预览永久卡死
          guardRef.current = setTimeout(release, 600)
          try {
            v.currentTime = t
          } catch {
            release()
          }
        }
      }
      raf = requestAnimationFrame(tick)
    }

    raf = requestAnimationFrame(tick)
    return () => {
      alive = false
      cancelAnimationFrame(raf)
    }
  }, [src])

  return (
    <video
      ref={ref}
      src={src}
      className={className}
      style={style}
      muted
      playsInline
      preload="auto"
      controls={false}
      disablePictureInPicture
      disableRemotePlayback
      onLoadedMetadata={(e) => {
        if (readyRef.current) return
        readyRef.current = true
        const v = e.currentTarget
        onReady?.(v.duration && Number.isFinite(v.duration) ? v.duration : 0)
      }}
      onSeeked={() => {
        busyRef.current = false
        if (guardRef.current) {
          clearTimeout(guardRef.current)
          guardRef.current = null
        }
      }}
    />
  )
}
