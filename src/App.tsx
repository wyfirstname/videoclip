import React, { useState } from 'react'
import { ConfigProvider } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import HomePage from './pages/HomePage'
import ProjectPage from './pages/ProjectPage'
import SettingsPage from './pages/SettingsPage'

export type View =
  | { page: 'home' }
  | { page: 'project'; id: string }
  | { page: 'settings' }

export default function App(): React.JSX.Element {
  const [view, setView] = useState<View>({ page: 'home' })
  const [projectKey, setProjectKey] = useState(0)

  const openProject = (id: string): void => {
    setProjectKey((k) => k + 1)
    setView({ page: 'project', id })
  }

  return (
    <ConfigProvider
      locale={zhCN}
      theme={{
        token: {
          colorPrimary: '#e0455a',
          borderRadius: 6
        }
      }}
    >
      <div className="app-shell">
        <div className="app-topbar">
          整合包由淘宝店铺「<span className="shop">莹百游素材铺</span>」制作与维护，使用中遇到问题或定制需求可联系店主
          vx：<span className="shop">zyyzing</span>
        </div>
        <header className="app-header">
          <div className="logo" onClick={() => setView({ page: 'home' })}>
            <span className="accent">V</span>Clip
            <span style={{ fontSize: 12, color: '#999', fontWeight: 400, marginLeft: 8 }}>
              AI 视频切片工作台
            </span>
          </div>
          <div style={{ flex: 1 }} />
          <a
            style={{ fontSize: 13, color: '#666', cursor: 'pointer' }}
            onClick={() => setView({ page: 'settings' })}
          >
            ⚙️ 设置
          </a>
        </header>
        <main className="app-body">
          {view.page === 'home' && <HomePage onOpen={openProject} />}
          {view.page === 'project' && (
            <ProjectPage key={projectKey} projectId={view.id} onBack={() => setView({ page: 'home' })} />
          )}
          {view.page === 'settings' && <SettingsPage />}
        </main>
        <footer className="app-footer">
          整合包由淘宝店铺「<span className="shop">莹百游素材铺</span>」制作与维护，使用中遇到问题或定制需求可到店铺联系店主
          vx：<span className="shop">zyyzing</span>
        </footer>
      </div>
    </ConfigProvider>
  )
}
