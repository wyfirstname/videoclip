import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Button, Dropdown, Empty, Input, Space, Typography, message } from 'antd'
import { CopyOutlined, DownloadOutlined, SearchOutlined } from '@ant-design/icons'
import type { SubtitleFormat, SubtitleSegment } from '../../shared/types'
import { formatTimecode } from '../time'

const { Text } = Typography

interface Props {
  subtitles: SubtitleSegment[]
  currentTime: number
  onSeek: (t: number) => void
  onExport: (format: SubtitleFormat) => void
  exporting?: boolean
}

export default function SubtitlePanel({
  subtitles,
  currentTime,
  onSeek,
  onExport,
  exporting
}: Props): React.JSX.Element {
  const listRef = useRef<HTMLDivElement>(null)
  const [keyword, setKeyword] = useState('')

  const filtered = useMemo(() => {
    const kw = keyword.trim().toLowerCase()
    if (!kw) return subtitles.map((s, i) => ({ s, i }))
    return subtitles
      .map((s, i) => ({ s, i }))
      .filter(({ s }) => s.text.toLowerCase().includes(kw))
  }, [subtitles, keyword])

  const currentIndex = subtitles.findIndex((s) => currentTime >= s.start && currentTime < s.end)

  useEffect(() => {
    if (currentIndex < 0 || !listRef.current || keyword.trim()) return
    const row = listRef.current.querySelector<HTMLElement>(`[data-idx="${currentIndex}"]`)
    if (row) {
      const container = listRef.current
      const rowTop = row.offsetTop
      if (rowTop < container.scrollTop || rowTop > container.scrollTop + container.clientHeight - 60) {
        container.scrollTop = rowTop - container.clientHeight / 2
      }
    }
  }, [currentIndex, keyword])

  const copyAll = async (): Promise<void> => {
    if (!subtitles.length) return
    const text = subtitles.map((s) => `[${formatTimecode(s.start)}] ${s.text}`).join('\n')
    try {
      await navigator.clipboard.writeText(text)
      message.success(`已复制全部 ${subtitles.length} 条字幕`)
    } catch {
      message.error('复制失败，请手动选择文本')
    }
  }

  if (!subtitles.length) {
    return <Empty description="暂无字幕，请先完成字幕识别" style={{ marginTop: 60 }} />
  }

  return (
    <div className="subtitle-panel">
      <div className="subtitle-toolbar">
        <Space size={8}>
          <Text type="secondary" style={{ fontSize: 12 }}>
            共 {subtitles.length} 条字幕
          </Text>
          <Input
            size="small"
            allowClear
            style={{ width: 180 }}
            prefix={<SearchOutlined style={{ color: '#bbb' }} />}
            placeholder="搜索字幕内容"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
          />
          {keyword.trim() && (
            <Text type="secondary" style={{ fontSize: 12 }}>
              匹配 {filtered.length} 条
            </Text>
          )}
        </Space>
        <Space size={8}>
          <Button size="small" icon={<CopyOutlined />} onClick={copyAll}>
            复制全部
          </Button>
          <Dropdown
            trigger={['click']}
            menu={{
              items: [
                { key: 'srt', label: 'SRT 字幕（.srt）' },
                { key: 'txt', label: '带时间码文本（.txt）' },
                { key: 'json', label: 'JSON 数据（.json）' }
              ],
              onClick: ({ key }) => onExport(key as SubtitleFormat)
            }}
          >
            <Button size="small" type="primary" icon={<DownloadOutlined />} loading={exporting}>
              导出全部字幕
            </Button>
          </Dropdown>
        </Space>
      </div>
      <div ref={listRef} className="subtitle-list">
        {filtered.length === 0 && (
          <Empty description="没有匹配的字幕" image={Empty.PRESENTED_IMAGE_SIMPLE} />
        )}
        {filtered.map(({ s, i }) => (
          <div
            key={i}
            data-idx={i}
            className={`subtitle-row ${i === currentIndex ? 'current' : ''}`}
            onClick={() => onSeek(s.start)}
          >
            <span className="time">
              {formatTimecode(s.start)} - {formatTimecode(s.end)}
            </span>
            <span>{s.text}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
