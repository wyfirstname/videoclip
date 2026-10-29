import React, { useEffect, useState } from 'react'
import { Button, Card, Empty, Popconfirm, Tag, message, Input, Modal, Space } from 'antd'
import { PlusOutlined, VideoCameraOutlined, ScissorOutlined } from '@ant-design/icons'
import type { ProjectMeta } from '../../shared/types'
import * as api from '../api'
import { formatDuration, formatDateTime } from '../time'
import type { View } from '../App'

export default function HomePage({ onOpen }: { onOpen: (id: string) => void }): React.JSX.Element {
  const [projects, setProjects] = useState<ProjectMeta[]>([])
  const [creating, setCreating] = useState(false)
  const [manualOpen, setManualOpen] = useState(false)
  const [manualName, setManualName] = useState('')
  const [manualPath, setManualPath] = useState('')

  const refresh = (): void => {
    api.listProjects().then(setProjects).catch(() => undefined)
  }

  useEffect(refresh, [])

  const handleCreate = async (): Promise<void> => {
    const videoPath = await api.pickVideo()
    if (!videoPath) return
    setCreating(true)
    try {
      const project = await api.createProject(videoPath)
      message.success(`项目「${project.name}」已创建`)
      onOpen(project.id)
    } catch (err) {
      message.error(`创建失败: ${api.errText(err)}`)
    } finally {
      setCreating(false)
    }
  }

  const handleManualCreate = async (): Promise<void> => {
    if (!manualPath.trim()) {
      message.warning('请输入视频文件路径')
      return
    }
    setCreating(true)
    try {
      const project = await api.createProject(manualPath.trim())
      message.success(`项目「${project.name}」已创建`)
      setManualOpen(false)
      setManualPath('')
      setManualName('')
      onOpen(project.id)
    } catch (err) {
      message.error(`创建失败: ${api.errText(err)}`)
    } finally {
      setCreating(false)
    }
  }

  const handleDelete = async (id: string): Promise<void> => {
    await api.deleteProject(id)
    refresh()
  }

  return (
    <div className="home-page">
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 16 }}>
        <h2 style={{ margin: 0, flex: 1 }}>
          <VideoCameraOutlined style={{ marginRight: 8, color: '#e0455a' }} />
          我的项目
        </h2>
        <Space>
          <Button onClick={() => setManualOpen(true)}>手动输入路径</Button>
          <Button type="primary" icon={<PlusOutlined />} loading={creating} onClick={handleCreate}>
            新建项目（选择视频）
          </Button>
        </Space>
      </div>

      {projects.length === 0 ? (
        <div className="empty-hint" style={{ paddingTop: 100 }}>
          <ScissorOutlined style={{ fontSize: 48, color: '#ddd' }} />
          <div style={{ fontSize: 16 }}>还没有项目，点击右上角「新建项目」导入一个视频开始吧</div>
          <div style={{ fontSize: 13, color: '#bbb' }}>
            工作流程：导入视频 → 本地 AI 识别字幕 → AI 总结切片 → 时间轴调整 → 一键导出
          </div>
        </div>
      ) : (
        <div className="project-card-grid">
          {projects.map((p) => (
            <Card
              key={p.id}
              hoverable
              onClick={() => onOpen(p.id)}
              title={<span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{p.name}</span>}
              extra={
                <Popconfirm
                  title="删除项目"
                  description="项目数据（字幕/切片）将被删除，视频文件不受影响"
                  onConfirm={(e) => {
                    e?.stopPropagation()
                    handleDelete(p.id)
                  }}
                  onCancel={(e) => e?.stopPropagation()}
                >
                  <Button
                    size="small"
                    type="text"
                    danger
                    onClick={(e) => e.stopPropagation()}
                  >
                    删除
                  </Button>
                </Popconfirm>
              }
            >
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
                {p.hasSubtitles ? <Tag color="green">已识别字幕</Tag> : <Tag>未识别</Tag>}
                {p.hasClips ? <Tag color="red">{p.clipCount} 个切片</Tag> : <Tag>未分析</Tag>}
              </div>
              <div style={{ color: '#888', fontSize: 12, lineHeight: 1.8 }}>
                <div>时长: {p.duration ? formatDuration(p.duration) : '未知'}</div>
                <div>创建: {formatDateTime(p.createdAt)}</div>
              </div>
            </Card>
          ))}
        </div>
      )}

      <Modal
        title="手动输入视频路径"
        open={manualOpen}
        onOk={handleManualCreate}
        onCancel={() => setManualOpen(false)}
        okText="创建项目"
        confirmLoading={creating}
      >
        <Input
          placeholder="例如 E:\\videos\\我的视频.mp4"
          value={manualPath}
          onChange={(e) => setManualPath(e.target.value)}
        />
      </Modal>
    </div>
  )
}
