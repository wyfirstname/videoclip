import React, { useEffect, useState } from 'react'
import {
  Button,
  Card,
  Form,
  Input,
  InputNumber,
  Tag,
  Progress,
  message,
  Space,
  Divider,
  Typography
} from 'antd'
import {
  ApiOutlined,
  CheckCircleOutlined,
  DownloadOutlined,
  DeleteOutlined,
  FolderOpenOutlined
} from '@ant-design/icons'
import type { AppSettings, AsrModelInfo } from '../../shared/types'
import * as api from '../api'
import type { ProgressEventPayload } from '../api'

const { Text, Paragraph } = Typography

export default function SettingsPage(): React.JSX.Element {
  const [form] = Form.useForm<AppSettings>()
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [models, setModels] = useState<AsrModelInfo[]>([])
  const [ffmpeg, setFfmpeg] = useState<{ ffmpeg: string; ffprobe: string | null; ok: boolean } | null>(null)
  const [testing, setTesting] = useState(false)
  const [modelProgress, setModelProgress] = useState<Record<string, ProgressEventPayload>>({})
  const [downloading, setDownloading] = useState<Record<string, boolean>>({})

  useEffect(() => {
    api.getSettings().then((s) => {
      setSettings(s)
      form.setFieldsValue(s)
    })
    refreshModels()
    api.checkFfmpeg().then(setFfmpeg)

    const off = api.api.onProgress((e) => {
      if (e.channel === 'models:progress') {
        setModelProgress((prev) => ({ ...prev, [e.modelId || '']: e }))
        if (e.done) {
          setDownloading((prev) => ({ ...prev, [e.modelId || '']: false }))
          if (!e.error) {
            message.success(`模型下载完成`)
            refreshModels()
          } else {
            message.error(`模型下载失败: ${e.error}`)
          }
        }
      }
    })
    return off
  }, [])

  const refreshModels = (): void => {
    api.listModels().then(setModels)
  }

  const handleSave = async (): Promise<void> => {
    const values = await form.validateFields()
    const saved = await api.setSettings(values)
    setSettings(saved)
    message.success('设置已保存')
  }

  const handleTest = async (): Promise<void> => {
    setTesting(true)
    try {
      const values = form.getFieldsValue()
      const res = await api.testLlm(values.llm)
      if (res.ok) message.success(res.message)
      else message.error(res.message)
    } finally {
      setTesting(false)
    }
  }

  const handleDownload = async (id: string): Promise<void> => {
    setDownloading((prev) => ({ ...prev, [id]: true }))
    setModelProgress((prev) => ({ ...prev, [id]: { channel: 'models:progress', modelId: id, percent: 0, stage: '开始下载...' } }))
    try {
      await api.downloadModel(id)
    } catch (err) {
      setDownloading((prev) => ({ ...prev, [id]: false }))
      message.error(`下载失败: ${api.errText(err)}`)
    }
  }

  const handleDeleteModel = async (id: string): Promise<void> => {
    await api.deleteModel(id)
    refreshModels()
    message.success('已删除模型')
  }

  if (!settings) return <div style={{ padding: 40 }}>加载中...</div>

  return (
    <Form form={form} layout="vertical" className="settings-page">
      <h2>设置</h2>

      {/* AI 设置 */}
      <Card title={<><RobotIcon /> AI 大模型（OpenAI 兼容接口）</>} style={{ marginBottom: 16 }}>
        <Paragraph type="secondary" style={{ marginTop: 0 }}>
          支持任何 OpenAI 兼容 API：DeepSeek、通义千问、硅基流动、OpenAI、本地 Ollama 等。用于分析字幕并生成切片建议。
        </Paragraph>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 16px' }}>
          <Form.Item name={['llm', 'baseUrl']} label="API 地址 (Base URL)" rules={[{ required: true }]}>
            <Input placeholder="https://api.deepseek.com/v1" />
          </Form.Item>
          <Form.Item name={['llm', 'model']} label="模型名称" rules={[{ required: true }]}>
            <Input placeholder="deepseek-chat" />
          </Form.Item>
        </div>
        <Form.Item name={['llm', 'apiKey']} label="API Key" rules={[{ required: true }]}>
          <Input.Password placeholder="sk-..." />
        </Form.Item>
        <Form.Item name={['llm', 'temperature']} label="Temperature">
          <InputNumber min={0} max={2} step={0.1} />
        </Form.Item>
        <Space>
          <Button icon={<ApiOutlined />} loading={testing} onClick={handleTest}>
            测试连接
          </Button>
        </Space>
      </Card>

      {/* 语音识别模型 */}
      <Card
        title={<><RobotIcon /> 本地语音识别模型（FunASR 系列）</>}
        extra={
          <Button
            size="small"
            icon={<FolderOpenOutlined />}
            onClick={() =>
              api.api
                .invoke('app:modelsDir')
                .then((p) => api.openPath(p as string))
            }
          >
            模型目录
          </Button>
        }
        style={{ marginBottom: 16 }}
      >
        <Paragraph type="secondary" style={{ marginTop: 0 }}>
          模型完全在本地运行，不上传任何数据。首次使用需下载一次模型。
        </Paragraph>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {models.map((m) => {
            const prog = modelProgress[m.id]
            const isDownloading = downloading[m.id]
            return (
              <div key={m.id} style={{ border: '1px solid #f0f0f0', borderRadius: 8, padding: 12 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <Text strong>{m.name}</Text>
                  <Tag>{m.sizeHint}</Tag>
                  {m.downloaded && (
                    <Tag color="green" icon={<CheckCircleOutlined />}>
                      已下载
                    </Tag>
                  )}
                  <div style={{ flex: 1 }} />
                  {m.downloaded ? (
                    <Button size="small" danger icon={<DeleteOutlined />} onClick={() => handleDeleteModel(m.id)}>
                      删除
                    </Button>
                  ) : (
                    <Button
                      size="small"
                      type="primary"
                      icon={<DownloadOutlined />}
                      loading={isDownloading}
                      onClick={() => handleDownload(m.id)}
                    >
                      下载
                    </Button>
                  )}
                </div>
                <Paragraph type="secondary" style={{ margin: '6px 0 0', fontSize: 12 }}>
                  {m.description}
                </Paragraph>
                {isDownloading && prog && (
                  <div style={{ marginTop: 8 }}>
                    <Progress percent={prog.percent} size="small" format={() => prog.stage} />
                    {prog.detail && (
                      <Text type="secondary" style={{ fontSize: 11 }}>
                        {prog.detail}
                      </Text>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
        <Divider />
        <div style={{ display: 'flex', gap: 24, alignItems: 'center' }}>
          <Form.Item name={['asr', 'modelId']} label="当前使用的模型" style={{ marginBottom: 0 }}>
            <select
              style={{ padding: '4px 8px', borderRadius: 6, border: '1px solid #d9d9d9' }}
            >
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                  {m.downloaded ? '' : '（未下载）'}
                </option>
              ))}
            </select>
          </Form.Item>
          <Form.Item name={['asr', 'numThreads']} label="识别线程数" style={{ marginBottom: 0 }}>
            <InputNumber min={1} max={16} />
          </Form.Item>
        </div>
      </Card>

      {/* 视频处理 */}
      <Card title={<><RobotIcon /> 视频处理</>} style={{ marginBottom: 16 }}>
          <Form.Item name="ffmpegPath" label="FFmpeg 路径（留空自动检测）">
            <Input placeholder="例如 D:\\ffmpeg\\bin\\ffmpeg.exe" />
          </Form.Item>
          <Form.Item name="outputDir" label="默认输出目录（留空则导出到系统视频目录）">
            <Input
              placeholder="例如 E:\\output"
              addonAfter={
                <Button
                  size="small"
                  type="text"
                  onClick={async () => {
                    const dir = await api.pickDirectory()
                    if (dir) form.setFieldsValue({ outputDir: dir })
                  }}
                >
                  选择
                </Button>
              }
            />
          </Form.Item>
          <Form.Item name="downloadMirror" label="模型下载镜像前缀（可选，GitHub 加速，如 https://ghfast.top）">
            <Input placeholder="留空使用官方源" />
          </Form.Item>
        <div>
          <Text strong>FFmpeg 状态：</Text>
          {ffmpeg?.ok ? (
            <Tag color="green" icon={<CheckCircleOutlined />}>
              可用 {ffmpeg.ffmpeg}
            </Tag>
          ) : (
            <Tag color="red">未检测到，请安装 FFmpeg 或在上面指定路径</Tag>
          )}
        </div>
      </Card>

      <Button type="primary" size="large" onClick={handleSave} style={{ width: 200 }}>
        保存设置
      </Button>
    </Form>
  )
}

function RobotIcon(): React.JSX.Element {
  return <span style={{ marginRight: 6 }}>⚙️</span>
}
