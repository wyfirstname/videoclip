import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Button,
  Steps,
  Progress,
  message,
  Space,
  Tag,
  Checkbox,
  Radio,
  Tooltip,
  Typography,
  Segmented,
  Divider
} from 'antd'
import {
  AudioOutlined,
  RobotOutlined,
  DownloadOutlined,
  ArrowLeftOutlined,
  FolderOpenOutlined,
  ReloadOutlined,
  ThunderboltOutlined,
  CaretRightOutlined,
  PlayCircleOutlined,
  PauseOutlined,
  StepBackwardOutlined,
  StepForwardOutlined,
  VerticalLeftOutlined,
  VerticalRightOutlined
} from '@ant-design/icons'
import type {
  Clip,
  ClipSubtitleMode,
  ProjectData,
  SubtitleSegment,
  SubtitleFormat,
  ExportResult
} from '../../shared/types'
import * as api from '../api'
import Timeline from '../components/Timeline'
import SubtitlePanel from '../components/SubtitlePanel'
import ClipCardItem from '../components/ClipCard'
import ScrubVideo from '../components/ScrubVideo'
import type { ProgressEventPayload } from '../api'
import { formatDuration, formatTimecode } from '../time'

const { Text } = Typography

interface Props {
  projectId: string
  onBack: () => void
}

type TabKey = 'subtitles' | 'clips' | 'export'
type FollowMode = 'hover' | 'playhead'

export default function ProjectPage({ projectId, onBack }: Props): React.JSX.Element {
  const [project, setProject] = useState<ProjectData | null>(null)
  const [subtitles, setSubtitles] = useState<SubtitleSegment[]>([])
  const [clips, setClips] = useState<Clip[]>([])
  const [currentTime, setCurrentTime] = useState(0)
  const [hoverTime, setHoverTime] = useState<number | null>(null)
  const [followMode, setFollowMode] = useState<FollowMode>('hover')
  const [playing, setPlaying] = useState(false)
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null)
  const [tab, setTab] = useState<TabKey>('subtitles')
  const [busy, setBusy] = useState<'transcribe' | 'analyze' | 'rules' | 'export' | null>(null)
  const [subtitleExporting, setSubtitleExporting] = useState(false)
  const [progress, setProgress] = useState<ProgressEventPayload | null>(null)
  const [exportOptions, setExportOptions] = useState<{
    precise: boolean
    subtitleMode: ClipSubtitleMode
    includeJson: boolean
    individualClips: boolean
    mergeCollection: boolean
  }>({
    precise: true,
    subtitleMode: 'none',
    includeJson: true,
    individualClips: true,
    mergeCollection: false
  })
  const [exportResult, setExportResult] = useState<ExportResult | null>(null)

  const videoRef = useRef<HTMLVideoElement>(null)
  const previewEndRef = useRef<number | null>(null)
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // ---- 加载项目 ----
  useEffect(() => {
    Promise.all([api.getProject(projectId), api.getSubtitles(projectId)]).then(([p, subs]) => {
      if (p) {
        setProject(p)
        setClips(p.clips || [])
      }
      setSubtitles(subs || [])
    })
  }, [projectId])

  // ---- 进度事件 ----
  useEffect(() => {
    const relevant = ['transcribe:progress', 'analyze:progress', 'export:progress']
    const off = api.api.onProgress((e) => {
      if (!relevant.includes(e.channel)) return
      if (e.projectId && e.projectId !== projectId) return
      setProgress(e)
    })
    return off
  }, [projectId])

  // ---- 保存切片（防抖） ----
  const persistClips = useCallback(
    (next: Clip[]) => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
      saveTimerRef.current = setTimeout(() => {
        api.saveClips(projectId, next).catch(() => undefined)
      }, 600)
    },
    [projectId]
  )

  const updateClip = useCallback(
    (clip: Clip) => {
      setClips((prev) => {
        const next = prev.map((c) => (c.id === clip.id ? clip : c))
        persistClips(next)
        return next
      })
    },
    [persistClips]
  )

  const updateClipTime = useCallback(
    (id: string, start: number, end: number) => {
      setClips((prev) => {
        const next = prev.map((c) => (c.id === id ? { ...c, start, end, edited: true } : c))
        persistClips(next)
        return next
      })
    },
    [persistClips]
  )

  const deleteClip = useCallback(
    (id: string) => {
      setClips((prev) => {
        const next = prev.filter((c) => c.id !== id)
        persistClips(next)
        return next
      })
    },
    [persistClips]
  )

  // ---- 播放控制 ----
  const seek = useCallback((t: number) => {
    if (videoRef.current) {
      videoRef.current.currentTime = Math.max(0, t)
      setCurrentTime(Math.max(0, t))
    }
  }, [])

  const togglePlay = useCallback((): void => {
    const v = videoRef.current
    if (!v) return
    if (v.paused) void v.play()
    else v.pause()
  }, [])

  const nudge = useCallback(
    (delta: number) => {
      const v = videoRef.current
      if (!v) return
      seek(v.currentTime + delta)
    },
    [seek]
  )

  const previewClip = (start: number, end: number): void => {
    seek(start)
    previewEndRef.current = end
    videoRef.current?.play()
  }

  const onVideoTimeUpdate = (): void => {
    if (!videoRef.current) return
    const t = videoRef.current.currentTime
    setCurrentTime(t)
    if (previewEndRef.current !== null && t >= previewEndRef.current) {
      videoRef.current.pause()
      previewEndRef.current = null
    }
  }

  // ---- 键盘快捷键：空格播放/暂停，←/→ ±1s（Shift ±5s），,/. 逐帧 ----
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const el = e.target as HTMLElement | null
      const tag = el?.tagName?.toLowerCase()
      if (tag === 'input' || tag === 'textarea' || el?.isContentEditable) return
      if (e.metaKey || e.ctrlKey || e.altKey) return
      switch (e.key) {
        case ' ':
          e.preventDefault()
          togglePlay()
          break
        case 'ArrowLeft':
          e.preventDefault()
          nudge(e.shiftKey ? -5 : -1)
          break
        case 'ArrowRight':
          e.preventDefault()
          nudge(e.shiftKey ? 5 : 1)
          break
        case ',':
          e.preventDefault()
          nudge(-1 / 30)
          break
        case '.':
          e.preventDefault()
          nudge(1 / 30)
          break
        default:
          break
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [togglePlay, nudge])

  // ---- 语音识别 ----
  const handleTranscribe = async (): Promise<void> => {
    setBusy('transcribe')
    setProgress({ channel: 'transcribe:progress', percent: 0, stage: '准备中...' })
    try {
      const res = await api.transcribe(projectId)
      const subs = await api.getSubtitles(projectId)
      setSubtitles(subs)
      message.success(`字幕识别完成，共 ${res.count} 条`)
    } catch (err) {
      message.error(`识别失败: ${api.errText(err)}`)
    } finally {
      setBusy(null)
    }
  }

  // ---- AI 分析 ----
  const handleAnalyze = async (): Promise<void> => {
    setBusy('analyze')
    setProgress({ channel: 'analyze:progress', percent: 0, stage: '准备中...' })
    try {
      const result = await api.analyze(projectId)
      setClips(result.clips)
      setTab('clips')
      api.getProject(projectId).then((p) => p && setProject(p))
      if (result.clips.length === 0) {
        message.warning('未生成切片：字幕内容过少，可试试「规则切片」或手动添加')
      } else if (result.usedRuleFallback) {
        message.info(result.message)
      } else {
        message.success(`AI 分析完成，共 ${result.clips.length} 个切片，可在时间轴上调整`)
      }
    } catch (err) {
      message.error(`分析失败: ${api.errText(err)}`)
    } finally {
      setBusy(null)
    }
  }

  // ---- 规则切片（不调用 AI，按语义边界聚合） ----
  const handleRuleSlice = async (): Promise<void> => {
    setBusy('rules')
    setProgress({ channel: 'analyze:progress', percent: 0, stage: '规则切片中...' })
    try {
      const result = await api.analyzeRules(projectId)
      setClips(result.clips)
      setTab('clips')
      api.getProject(projectId).then((p) => p && setProject(p))
      if (result.clips.length === 0) {
        message.warning('未生成切片：字幕为空，请先识别字幕')
      } else {
        message.success(`规则切片完成，共 ${result.clips.length} 个切片`)
      }
    } catch (err) {
      message.error(`规则切片失败: ${api.errText(err)}`)
    } finally {
      setBusy(null)
    }
  }

  // ---- 导出全部字幕 ----
  const handleSubtitleExport = async (format: SubtitleFormat): Promise<void> => {
    if (!subtitles.length) {
      message.warning('还没有字幕可导出，请先识别字幕')
      return
    }
    setSubtitleExporting(true)
    try {
      const res = await api.exportSubtitles(projectId, format, true)
      if (!res) return
      message.success(`已导出 ${res.count} 条字幕`)
      api.showItemInFolder(res.path).catch(() => undefined)
    } catch (err) {
      message.error(`字幕导出失败: ${api.errText(err)}`)
    } finally {
      setSubtitleExporting(false)
    }
  }

  // ---- 导出切片 ----
  const handleExport = async (): Promise<void> => {
    setBusy('export')
    setProgress({ channel: 'export:progress', percent: 0, stage: '准备中...' })
    try {
      // 先保存当前编辑
      await api.saveClips(projectId, clips)
      const payload = {
        precise: exportOptions.precise,
        // 精确模式强制不生成任何字幕，避免时间基准偏移导致字幕错位
        subtitleMode: (exportOptions.precise ? 'none' : exportOptions.subtitleMode) as ClipSubtitleMode,
        includeJson: exportOptions.includeJson,
        individualClips: exportOptions.individualClips,
        mergeCollection: exportOptions.mergeCollection
      }
      const result = await api.exportClips(projectId, payload)
      setExportResult(result)
      if (result.failed.length) {
        message.warning(`导出完成，${result.failed.length} 个失败`)
      } else {
        // files 里的 mp4 含合集本身，统计「单独切片数」时要扣掉
        const clipOnly = exportOptions.individualClips
          ? result.files.filter((f) => f.endsWith('.mp4')).length - (result.collection ? 1 : 0)
          : 0
        const parts: string[] = []
        if (clipOnly > 0) parts.push(`${clipOnly} 个切片`)
        if (result.collection) {
          parts.push(
            `合集（${result.collection.clipCount} 段 / ${formatDuration(result.collection.duration)}）`
          )
        }
        message.success(`导出完成：${parts.join(' + ') || '无产出'}`)
      }
    } catch (err) {
      message.error(`导出失败: ${api.errText(err)}`)
    } finally {
      setBusy(null)
    }
  }

  // ---- 把时间轴当前位置设为选中切片的起点/终点 ----
  const setClipBoundary = (edge: 'start' | 'end'): void => {
    const clip = clips.find((c) => c.id === selectedClipId)
    if (!clip) {
      message.info('请先在时间轴或切片列表里选中一个切片')
      return
    }
    const t = Math.round((hoverTime ?? currentTime) * 10) / 10
    if (edge === 'start') {
      if (t >= clip.end - 0.5) {
        message.warning('起点必须早于终点')
        return
      }
      updateClipTime(clip.id, t, clip.end)
    } else {
      if (t <= clip.start + 0.5) {
        message.warning('终点必须晚于起点')
        return
      }
      updateClipTime(clip.id, clip.start, t)
    }
    message.success(`已把 ${formatTimecode(t)} 设为「${clip.title}」的${edge === 'start' ? '起点' : '终点'}`)
  }

  const videoUrl = useMemo(() => {
    if (!project) return ''
    // 必须带 host（media://file/...）：空 host 会被浏览器 URL 安全检查拒绝
    return (
      'media://file' +
      (project.videoPath.startsWith('/') ? '' : '/') +
      project.videoPath
        .replace(/\\/g, '/')
        .split('/')
        .map(encodeURIComponent)
        .join('/')
    )
  }, [project])

  const stepIndex = !project?.hasSubtitles ? 0 : !project?.hasClips ? 1 : 2
  const selectedClipsCount = clips.filter((c) => c.selected).length
  const currentProgress = busy ? progress : null

  const previewTime = followMode === 'hover' ? (hoverTime ?? currentTime) : currentTime
  const previewFollowingHover = followMode === 'hover' && hoverTime !== null
  const selectedClip = clips.find((c) => c.id === selectedClipId) || null

  if (!project) {
    return (
      <div className="empty-hint" style={{ paddingTop: 100 }}>
        加载中...
      </div>
    )
  }

  return (
    <div className="project-page">
      {/* 头部 */}
      <div className="project-header">
        <Button icon={<ArrowLeftOutlined />} onClick={onBack} size="small" />
        <h3 style={{ margin: 0, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {project.name}
        </h3>
        <Text type="secondary" style={{ fontSize: 12 }}>
          {project.duration ? formatDuration(project.duration) : ''}
        </Text>
        <Steps
          size="small"
          current={stepIndex}
          items={[{ title: '字幕识别' }, { title: 'AI 分析' }, { title: '调整与导出' }]}
          style={{ width: 380 }}
        />
        <Space size={8}>
          <Tooltip title="本地语音识别（FunASR 系模型）">
            <Button
              icon={<AudioOutlined />}
              loading={busy === 'transcribe'}
              onClick={handleTranscribe}
            >
              {project.hasSubtitles ? '重新识别字幕' : '识别字幕'}
            </Button>
          </Tooltip>
          <Tooltip title="基于字幕进行 AI 总结切片">
            <Button
              type="primary"
              icon={<RobotOutlined />}
              loading={busy === 'analyze'}
              disabled={!subtitles.length}
              onClick={handleAnalyze}
            >
              AI 分析切片
            </Button>
          </Tooltip>
          <Tooltip title="不调用 AI，按字幕语义边界自动聚合切片（无需配置 API Key）">
            <Button
              icon={<ThunderboltOutlined />}
              loading={busy === 'rules'}
              disabled={!subtitles.length}
              onClick={handleRuleSlice}
            >
              规则切片
            </Button>
          </Tooltip>
        </Space>
      </div>

      {/* 进度条 */}
      {currentProgress && !currentProgress.done && (
        <div style={{ flexShrink: 0 }}>
          <Progress
            percent={currentProgress.percent}
            size="small"
            status="active"
            format={() => currentProgress.stage}
          />
          {currentProgress.detail && (
            <Text type="secondary" style={{ fontSize: 12 }}>
              {currentProgress.detail}
            </Text>
          )}
        </div>
      )}

      {/* 播放器 + 与时间轴对齐的预监画面 */}
      <div className="stage-row">
        <div className="player-section">
          <video
            ref={videoRef}
            src={videoUrl}
            controls
            onTimeUpdate={onVideoTimeUpdate}
            onPlay={() => setPlaying(true)}
            onPause={() => setPlaying(false)}
            preload="auto"
          />
        </div>

        <div className="monitor-panel">
          <div className="monitor-head">
            <span className="monitor-title">预监画面</span>
            <Segmented
              size="small"
              value={followMode}
              onChange={(v) => setFollowMode(v as FollowMode)}
              options={[
                { label: '跟随鼠标', value: 'hover' },
                { label: '跟随播放头', value: 'playhead' }
              ]}
            />
          </div>
          <div
            className="monitor-body"
            title="单击可把主播放器跳到此时间点"
            onClick={() => seek(previewTime)}
          >
            <ScrubVideo src={videoUrl} time={previewTime} className="monitor-video" />
            <div className="monitor-tc">{formatTimecode(previewTime, true)}</div>
            <div className={`monitor-badge ${previewFollowingHover ? 'on' : ''}`}>
              {previewFollowingHover ? '鼠标位置' : '播放头'}
            </div>
          </div>
          <div className="monitor-foot">
            <Space size={4} wrap={false}>
              <Tooltip title="后退 1 秒（Shift 为 5 秒）">
                <Button size="small" icon={<StepBackwardOutlined />} onClick={() => nudge(-1)} />
              </Tooltip>
              <Tooltip title="播放 / 暂停（空格）">
                <Button
                  size="small"
                  icon={playing ? <PauseOutlined /> : <CaretRightOutlined />}
                  onClick={togglePlay}
                />
              </Tooltip>
              <Tooltip title="前进 1 秒（Shift 为 5 秒）">
                <Button size="small" icon={<StepForwardOutlined />} onClick={() => nudge(1)} />
              </Tooltip>
              <Divider type="vertical" style={{ margin: '0 2px' }} />
              <Tooltip title={selectedClip ? `把当前时间点设为「${selectedClip.title}」的起点` : '先选中一个切片'}>
                <Button
                  size="small"
                  icon={<VerticalRightOutlined />}
                  disabled={!selectedClip}
                  onClick={() => setClipBoundary('start')}
                >
                  设为起点
                </Button>
              </Tooltip>
              <Tooltip title={selectedClip ? `把当前时间点设为「${selectedClip.title}」的终点` : '先选中一个切片'}>
                <Button
                  size="small"
                  icon={<VerticalLeftOutlined />}
                  disabled={!selectedClip}
                  onClick={() => setClipBoundary('end')}
                >
                  设为终点
                </Button>
              </Tooltip>
            </Space>
          </div>
        </div>
      </div>

      {/* 时间轴 */}
      <Timeline
        duration={project.duration || 0}
        currentTime={currentTime}
        subtitles={subtitles}
        clips={clips}
        selectedClipId={selectedClipId}
        videoUrl={videoUrl}
        onSeek={seek}
        onHoverTime={setHoverTime}
        onSelectClip={(id) => {
          setSelectedClipId(id)
          setTab('clips')
        }}
        onUpdateClip={updateClipTime}
        onToggleSelected={(id) => {
          setClips((prev) => {
            const next = prev.map((c) => (c.id === id ? { ...c, selected: !c.selected } : c))
            persistClips(next)
            return next
          })
        }}
      />

      {/* 底部面板 */}
      <div className="project-bottom">
        <div className="bottom-tabs">
          <div
            className={`bottom-tab ${tab === 'subtitles' ? 'active' : ''}`}
            onClick={() => setTab('subtitles')}
          >
            字幕 ({subtitles.length})
          </div>
          <div className={`bottom-tab ${tab === 'clips' ? 'active' : ''}`} onClick={() => setTab('clips')}>
            切片 ({clips.length})
          </div>
          <div className={`bottom-tab ${tab === 'export' ? 'active' : ''}`} onClick={() => setTab('export')}>
            导出
          </div>
        </div>
        <div className="bottom-content">
          {tab === 'subtitles' && (
            <SubtitlePanel
              subtitles={subtitles}
              currentTime={currentTime}
              onSeek={seek}
              onExport={handleSubtitleExport}
              exporting={subtitleExporting}
            />
          )}

          {tab === 'clips' && (
            <div className="bottom-scroll">
              {clips.length === 0 ? (
                <div className="empty-hint">
                  <RobotOutlined style={{ fontSize: 40, color: '#ddd' }} />
                  <div>还没有切片</div>
                  <div style={{ fontSize: 12, color: '#999', marginTop: 4 }}>
                    {subtitles.length === 0
                      ? '请先点击右上角「识别字幕」'
                      : '点击「AI 分析切片」做智能切片；若内容较短或未配置 API Key，可直接用「规则切片」'}
                  </div>
                  {subtitles.length > 0 && (
                    <Space style={{ marginTop: 12 }}>
                      <Button
                        type="primary"
                        icon={<RobotOutlined />}
                        loading={busy === 'analyze'}
                        onClick={handleAnalyze}
                      >
                        AI 分析切片
                      </Button>
                      <Button
                        icon={<ThunderboltOutlined />}
                        loading={busy === 'rules'}
                        onClick={handleRuleSlice}
                      >
                        规则切片
                      </Button>
                    </Space>
                  )}
                </div>
              ) : (
                <>
                  <div style={{ marginBottom: 10, display: 'flex', alignItems: 'center', gap: 10 }}>
                    <Text type="secondary">
                      已勾选 {selectedClipsCount}/{clips.length} 个切片 · 在时间轴上拖动可调整时间范围
                    </Text>
                    <Button
                      size="small"
                      icon={<ReloadOutlined />}
                      onClick={() => {
                        api.getSubtitles(projectId).then(setSubtitles)
                        api.getProject(projectId).then((p) => {
                          if (p) {
                            setProject(p)
                            setClips(p.clips || [])
                          }
                        })
                        message.success('已刷新')
                      }}
                    >
                      刷新
                    </Button>
                  </div>
                  <div className="clip-grid">
                    {clips.map((clip, i) => (
                      <ClipCardItem
                        key={clip.id}
                        clip={clip}
                        index={i}
                        selected={clip.id === selectedClipId}
                        maxDuration={project.duration || 36000}
                        onSelect={(id) => {
                          setSelectedClipId(id)
                          const c = clips.find((x) => x.id === id)
                          if (c) seek(c.start)
                        }}
                        onUpdate={updateClip}
                        onDelete={deleteClip}
                        onPlay={previewClip}
                      />
                    ))}
                  </div>
                </>
              )}
            </div>
          )}

          {tab === 'export' && (
            <div className="bottom-scroll">
            <div style={{ maxWidth: 680 }}>
              <h4>导出设置</h4>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                <div>
                  <div style={{ marginBottom: 6 }}>
                    <Text strong>导出模式</Text>
                  </div>
                  <Radio.Group
                    value={exportOptions.precise}
                    onChange={(e) => setExportOptions({ ...exportOptions, precise: e.target.value })}
                    options={[
                      { label: '精确模式（重新编码，画面精准对齐，速度较慢）', value: true },
                      { label: '快速模式（流复制，秒级导出，起止点可能略偏）', value: false }
                    ]}
                    optionType="button"
                    buttonStyle="solid"
                  />
                </div>

                <div>
                  <div style={{ marginBottom: 6 }}>
                    <Text strong>切片字幕</Text>
                  </div>
                  <Radio.Group
                    size="small"
                    disabled={exportOptions.precise}
                    value={exportOptions.precise ? 'none' : exportOptions.subtitleMode}
                    onChange={(e) =>
                      setExportOptions({ ...exportOptions, subtitleMode: e.target.value as ClipSubtitleMode })
                    }
                    options={[
                      { label: '不生成任何字幕', value: 'none' },
                      { label: '额外生成外挂 SRT（不烧录进画面）', value: 'sidecar' }
                    ]}
                    optionType="button"
                    buttonStyle="solid"
                  />
                  <div style={{ marginTop: 6, fontSize: 12, color: '#999', lineHeight: 1.6 }}>
                    {exportOptions.precise
                      ? '精确模式（重新编码）一律不生成任何字幕，也不会把字幕烧录进画面：重编码后的时间基准与原字幕不完全一致，外挂字幕容易出现整体偏移/错位。'
                      : '快速模式为无损流复制，会保留原始时间戳，如需字幕可额外生成外挂 SRT（仍是独立文件，不烧录）。'}
                    <br />
                    需要完整字幕文件时，请到「字幕」标签页使用「导出全部字幕」。
                  </div>
                </div>

                <div>
                  <div style={{ marginBottom: 6 }}>
                    <Text strong>导出内容</Text>
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                    <div>
                      <Checkbox
                        checked={exportOptions.individualClips}
                        onChange={(e) =>
                          setExportOptions({ ...exportOptions, individualClips: e.target.checked })
                        }
                      >
                        单个切片（逐个导出成独立 MP4，共 {selectedClipsCount} 个）
                      </Checkbox>
                    </div>
                    <div>
                      <Checkbox
                        checked={exportOptions.mergeCollection}
                        onChange={(e) =>
                          setExportOptions({ ...exportOptions, mergeCollection: e.target.checked })
                        }
                      >
                        切片合集（把 {selectedClipsCount} 个切片按顺序拼接成一个 MP4）
                      </Checkbox>
                      <div style={{ marginTop: 6, fontSize: 12, color: '#999', lineHeight: 1.6 }}>
                        {exportOptions.mergeCollection
                          ? `合集保存为 00_切片合集.mp4；${exportOptions.precise ? '精确模式下重编码拼接，画面与各切片完全一致。' : '快速模式优先流复制拼接（秒级、无损），失败时自动降级为重新编码。'}`
                          : '把所有切片首尾相接成一个完整视频，适合直接整段发布。'}
                      </div>
                    </div>
                  </div>
                  <div style={{ marginTop: 6, fontSize: 12, color: '#999', lineHeight: 1.6 }}>
                    {exportOptions.individualClips && exportOptions.mergeCollection
                      ? '两者都会导出：既保留逐个切片，也额外拼成合集（同一目录）。'
                      : !exportOptions.individualClips && exportOptions.mergeCollection
                        ? '只导出合集：切片仅作为拼接中间产物，输出目录里只留一个 00_切片合集.mp4。'
                        : exportOptions.individualClips
                          ? '只导出单个切片。'
                          : '请至少勾选一项。'}
                  </div>
                </div>

                <div>
                  <Checkbox
                    checked={exportOptions.includeJson}
                    onChange={(e) => setExportOptions({ ...exportOptions, includeJson: e.target.checked })}
                  >
                    同时导出切片信息 JSON（标题/摘要/推荐理由）
                  </Checkbox>
                </div>

                <div>
                  <Button
                    type="primary"
                    icon={<DownloadOutlined />}
                    loading={busy === 'export'}
                    disabled={
                      selectedClipsCount === 0 ||
                      (!exportOptions.individualClips && !exportOptions.mergeCollection)
                    }
                    onClick={handleExport}
                  >
                    {exportOptions.individualClips && exportOptions.mergeCollection
                      ? `导出 ${selectedClipsCount} 个切片 + 合集`
                      : exportOptions.mergeCollection
                        ? `导出切片合集（${selectedClipsCount} 段）`
                        : `导出 ${selectedClipsCount} 个切片`}
                  </Button>
                </div>

                {busy === 'export' && currentProgress && (
                  <Progress
                    percent={currentProgress.percent}
                    status="active"
                    format={() => currentProgress.stage}
                  />
                )}

                {exportResult && (
                  <div style={{ background: '#fafafa', padding: 12, borderRadius: 6 }}>
                    <Space>
                      <Text strong>输出目录:</Text>
                      <Text copyable style={{ fontSize: 12 }}>
                        {exportResult.outputDir}
                      </Text>
                      <Button
                        size="small"
                        icon={<FolderOpenOutlined />}
                        onClick={() => api.openPath(exportResult.outputDir)}
                      >
                        打开目录
                      </Button>
                    </Space>
                    {exportResult.collection && (
                      <div style={{ marginTop: 8 }}>
                        <Space>
                          <Text strong>切片合集:</Text>
                          <Text style={{ fontSize: 12 }}>
                            {exportResult.collection.clipCount} 段 ·{' '}
                            {formatDuration(exportResult.collection.duration)}
                          </Text>
                          <Button
                            size="small"
                            type="primary"
                            ghost
                            icon={<PlayCircleOutlined />}
                            onClick={() => api.openPath(exportResult.collection!.path)}
                          >
                            播放合集
                          </Button>
                          <Button
                            size="small"
                            icon={<FolderOpenOutlined />}
                            onClick={() => api.showItemInFolder(exportResult.collection!.path)}
                          >
                            在文件夹中显示
                          </Button>
                        </Space>
                      </div>
                    )}
                    {exportResult.notes?.length ? (
                      <div style={{ marginTop: 8 }}>
                        {exportResult.notes.map((n, i) => (
                          <Tag color="blue" key={i} style={{ marginBottom: 4 }}>
                            {n}
                          </Tag>
                        ))}
                      </div>
                    ) : null}
                    {exportResult.failed.length > 0 && (
                      <div style={{ marginTop: 8 }}>
                        {exportResult.failed.map((f) => (
                          <Tag color="red" key={f.id}>
                            {f.title}: {f.error}
                          </Tag>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
