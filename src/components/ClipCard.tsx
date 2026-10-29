import React from 'react'
import { Card, Input, InputNumber, Tag, Progress, Switch, Button, Space, Typography, Popconfirm } from 'antd'
import { CaretRightOutlined, DeleteOutlined, StarFilled } from '@ant-design/icons'
import type { Clip } from '../../shared/types'
import { formatDuration } from '../time'

const { TextArea } = Input
const { Text } = Typography

interface Props {
  clip: Clip
  index: number
  selected: boolean
  onSelect: (id: string) => void
  onUpdate: (clip: Clip) => void
  onDelete: (id: string) => void
  onPlay: (start: number, end: number) => void
  maxDuration: number
}

function scoreColor(score: number): string {
  if (score >= 0.8) return '#52c41a'
  if (score >= 0.6) return '#faad14'
  return '#999'
}

const SOURCE_TAG: Record<string, { color: string; label: string }> = {
  ai: { color: 'blue', label: 'AI' },
  rule: { color: 'orange', label: '规则' },
  manual: { color: 'default', label: '手动' }
}

export default function ClipCardItem({
  clip,
  index,
  selected,
  onSelect,
  onUpdate,
  onDelete,
  onPlay,
  maxDuration
}: Props): React.JSX.Element {
  const duration = clip.end - clip.start

  return (
    <Card
      size="small"
      style={{
        borderColor: selected ? '#e0455a' : undefined,
        opacity: selected ? 1 : 0.6
      }}
      title={
        <span onClick={() => onSelect(clip.id)} style={{ cursor: 'pointer' }}>
          <span style={{ color: '#999', marginRight: 6 }}>#{index + 1}</span>
          {clip.title}
          {clip.edited && (
            <Tag color="purple" style={{ marginLeft: 8, fontSize: 11 }}>
              已调整
            </Tag>
          )}
          {clip.source && SOURCE_TAG[clip.source] && (
            <Tag color={SOURCE_TAG[clip.source].color} style={{ marginLeft: 4, fontSize: 11 }}>
              {SOURCE_TAG[clip.source].label}
            </Tag>
          )}
        </span>
      }
      extra={
        <Space size={4}>
          <Switch
            size="small"
            checked={clip.selected}
            checkedChildren="导出"
            unCheckedChildren="跳过"
            onChange={(v) => onUpdate({ ...clip, selected: v })}
          />
          <Popconfirm title="确定删除该切片？" onConfirm={() => onDelete(clip.id)}>
            <Button size="small" type="text" danger icon={<DeleteOutlined />} />
          </Popconfirm>
        </Space>
      }
    >
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8, flexWrap: 'wrap' }}>
        <InputNumber
          size="small"
          min={0}
          max={maxDuration}
          step={0.1}
          value={clip.start}
          formatter={(v) => formatDuration(Number(v))}
          parser={(v) => {
            const parts = String(v).split(':').map(Number)
            if (parts.length === 2) return parts[0] * 60 + parts[1]
            if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2]
            return Number(v) || 0
          }}
          onChange={(v) => onUpdate({ ...clip, start: Number(v) || 0, edited: true })}
          style={{ width: 100 }}
        />
        <span style={{ color: '#bbb' }}>→</span>
        <InputNumber
          size="small"
          min={0}
          max={maxDuration}
          step={0.1}
          value={clip.end}
          formatter={(v) => formatDuration(Number(v))}
          parser={(v) => {
            const parts = String(v).split(':').map(Number)
            if (parts.length === 2) return parts[0] * 60 + parts[1]
            if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2]
            return Number(v) || 0
          }}
          onChange={(v) => onUpdate({ ...clip, end: Number(v) || 0, edited: true })}
          style={{ width: 100 }}
        />
        <Tag icon={<CaretRightOutlined />} onClick={() => onPlay(clip.start, clip.end)} style={{ cursor: 'pointer' }}>
          预览
        </Tag>
        <Text type="secondary" style={{ fontSize: 12 }}>
          {formatDuration(duration)}
        </Text>
      </div>

      {clip.summary && (
        <TextArea
          value={clip.summary}
          autoSize={{ minRows: 1, maxRows: 4 }}
          style={{ marginBottom: 8, fontSize: 12 }}
          onChange={(e) => onUpdate({ ...clip, summary: e.target.value })}
        />
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <Progress
          percent={Math.round(clip.score * 100)}
          size="small"
          strokeColor={scoreColor(clip.score)}
          style={{ flex: 1, margin: 0 }}
          format={(p) => `${p}分`}
        />
        <Tag color={scoreColor(clip.score)} icon={<StarFilled />} style={{ marginRight: 0 }}>
          {(clip.score * 10).toFixed(1)}
        </Tag>
      </div>
      {clip.reason && (
        <Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 6 }}>
          {clip.reason}
        </Text>
      )}
    </Card>
  )
}
