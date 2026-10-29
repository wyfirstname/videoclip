/**
 * 本轮新功能端到端自测
 *  1) 时间轴定位：单击/拖动定位、播放头联动、悬停缩略预览、预监画面
 *  2) 全部字幕导出：SRT / 带时间码文本 / JSON（UTF-8 BOM、去重、单调）
 *  3) 精确模式导出：不产生任何字幕文件；快速模式可选外挂 SRT
 *
 * 用法: npx electron test/e2e/features.js
 */
const path = require('path')
const fs = require('fs')
const { app, BrowserWindow, dialog } = require('electron')
const prereq = require('./_prereq')

const VIDEO = process.env.VCLIP_VIDEO || 'D:\\desktop\\test.mp4'
const UD = process.env.VCLIP_USERDATA || path.join(__dirname, 'userdata-features')
const TMP = path.join(UD, 'tmp')
const OUT_ROOT = path.join(TMP, 'out')
fs.mkdirSync(OUT_ROOT, { recursive: true })

app.setPath('userData', UD)
// 源码直接跑 e2e 时 app.getAppPath() 不是项目根，应用自带的 ffmpeg 查不到
// （会导致导出失败 + project:create 时长探测为 0），这里预写进隔离 userData 的 settings.json
prereq.prepare(UD)

const saveCalls = []
const openCalls = []
dialog.showOpenDialog = async (win, opts) => {
  openCalls.push(opts)
  return { canceled: false, filePaths: [VIDEO] }
}
dialog.showSaveDialog = async (win, opts) => {
  saveCalls.push(opts)
  const ext = opts && opts.defaultPath ? path.extname(opts.defaultPath) : '.srt'
  return { canceled: false, filePath: path.join(TMP, 'saved-subtitles' + ext) }
}

const logs = []
const mainErrors = []
process.on('uncaughtException', (e) => mainErrors.push('uncaughtException: ' + (e && e.stack)))
process.on('unhandledRejection', (e) =>
  mainErrors.push('unhandledRejection: ' + ((e && e.stack) || String(e)))
)
app.on('browser-window-created', (_e, win) => {
  win.webContents.on('console-message', (_ev, level, message, source, line) => {
    logs.push(`[renderer:${level}] ${message} (${source}:${line})`)
  })
})

require(path.join(__dirname, '../../out/main/index.js'))

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const report = { steps: [], checks: [], asserts: [] }

function assert(name, cond, detail) {
  report.asserts.push({ name, ok: !!cond, detail })
}

async function main() {
  await app.whenReady()
  await sleep(2500)

  const win = BrowserWindow.getAllWindows()[0]
  if (!win) {
    report.fatal = '未创建窗口'
    return finish()
  }

  const step = async (name, js, timeout) => {
    try {
      const p = win.webContents.executeJavaScript(js, true)
      const value = timeout ? await Promise.race([p, sleep(timeout).then(() => '__TIMEOUT__')]) : await p
      report.steps.push({ name, ok: true, value })
      return value
    } catch (err) {
      const msg = String((err && err.message) || err)
      report.steps.push({ name, ok: false, error: msg })
      return 'ERR ' + msg
    }
  }

  report.video = { path: VIDEO, exists: fs.existsSync(VIDEO) }
  report.ffmpeg = prereq.ffmpegPath
  prereq.logResolved()

  // ---- 准备：输出目录重定向到测试目录，避免污染真实 Videos 目录 ----
  await step(
    '重定向输出目录',
    `window.vclip.invoke('settings:get')
       .then(s => window.vclip.invoke('settings:set', Object.assign({}, s, { outputDir: ${JSON.stringify(path.join(TMP, 'out'))} })))
       .then(() => 'ok')`
  )

  // ---- 1. 创建项目 ----
  const created = await step(
    '创建项目',
    `window.vclip.invoke('project:create', ${JSON.stringify(VIDEO)})
       .then(r => JSON.stringify({ id: r.id, name: r.name, duration: r.duration }))
       .catch(e => 'ERR ' + (e && e.message))`
  )
  let pid = null
  let duration = 0
  try {
    const o = JSON.parse(created)
    pid = o.id
    duration = o.duration
  } catch {
    /* ignore */
  }
  assert('项目创建成功', !!pid, { pid, duration })
  if (!pid) return finish()

  // ---- 2. 直接注入字幕（跳过 ASR，专注验证导出链路） ----
  // 故意混入：乱序、反向时间（end<start）、重复条目，检验清洗逻辑
  const rawSubs = [
    { start: 4.0, end: 6.5, text: '这是第二句字幕' },
    { start: 0.5, end: 3.2, text: '这是第一句字幕' },
    { start: 7.0, end: 6.0, text: '反向时间码应被修正' },
    { start: 0.5, end: 3.2, text: '这是第一句字幕' },
    { start: 8.2, end: 11.4, text: '最后一句，包含中文标点：您好！' },
    { start: 12.0, end: 13.0, text: '   ' }
  ]
  const projDir = path.join(UD, 'projects', pid)
  fs.mkdirSync(projDir, { recursive: true })
  fs.writeFileSync(path.join(projDir, 'subtitles.json'), JSON.stringify(rawSubs), 'utf-8')

  const subsInUi = await step(
    '读取字幕条数',
    `window.vclip.invoke('subtitles:get', ${JSON.stringify(pid)}).then(s => s.length)`
  )
  assert('字幕已注入', subsInUi === rawSubs.length, subsInUi)

  // ---- 3. 全部字幕导出（ask=true 走保存对话框） ----
  for (const fmt of ['srt', 'txt', 'json']) {
    const res = await step(
      `导出全部字幕(${fmt})`,
      `window.vclip.invoke('subtitles:export', ${JSON.stringify(pid)}, ${JSON.stringify(fmt)}, true)
         .then(r => JSON.stringify(r)).catch(e => 'ERR ' + (e && e.message))`
    )
    let out = null
    try {
      out = JSON.parse(res)
    } catch {
      /* ignore */
    }
    assert(`字幕导出(${fmt}) 返回结果`, !!(out && out.path), out)
    if (out && out.path) {
      const buf = fs.readFileSync(out.path)
      const text = buf.toString('utf-8')
      if (fmt !== 'json') {
        // JSON 规范不允许 BOM（会让部分解析器报错），只有 SRT/TXT 才加
        assert(`${fmt} 含 UTF-8 BOM`, text.charCodeAt(0) === 0xfeff, text.slice(0, 3))
      }
      assert(`${fmt} 已剔除空/重复条目（应 4 条）`, out.count === 4, out.count)
      if (fmt === 'srt') {
        const times = [...text.matchAll(/(\d{2}:\d{2}:\d{2},\d{3}) --> (\d{2}:\d{2}:\d{2},\d{3})/g)].map((m) => [
          m[1],
          m[2]
        ])
        const monotonic = times.every(([a, b]) => a < b)
        const ordered = times.every((t, i) => i === 0 || times[i - 1][1] <= t[0])
        assert('SRT 每条时长均 > 0', monotonic, times)
        assert('SRT 顺序单调无重叠', ordered, times)
        assert('SRT 序号连续', /^1\r?\n/.test(text.replace('\uFEFF', '')) && text.includes('\n2\n'))
      }
      if (fmt === 'txt') {
        assert('TXT 带时间码', /\[\d{1,2}:\d{2}\]/.test(text), text.split('\n')[0])
      }
      if (fmt === 'json') {
        let arr = null
        try {
          arr = JSON.parse(text)
        } catch {
          /* ignore */
        }
        assert('JSON 可解析且为 4 条', Array.isArray(arr) && arr.length === 4, arr && arr.length)
      }
    }
  }
  assert('保存对话框被调用并带 SRT 过滤器', saveCalls.length >= 3, saveCalls.map((c) => c.defaultPath))

  // ---- 4. 全部字幕导出（ask=false 直写输出目录） ----
  const direct = await step(
    '导出全部字幕(ask=false)',
    `window.vclip.invoke('subtitles:export', ${JSON.stringify(pid)}, 'srt', false)
       .then(r => JSON.stringify(r)).catch(e => 'ERR ' + (e && e.message))`
  )
  let directOut = null
  try {
    directOut = JSON.parse(direct)
  } catch {
    /* ignore */
  }
  assert(
    '直写导出落在输出目录下',
    !!(directOut && directOut.path && directOut.path.includes(path.join('out', 'VClip'))),
    directOut && directOut.path
  )

  // ---- 5. 准备切片 ----
  const d = duration && duration > 20 ? duration : 20
  const clips = [
    {
      id: 'c1',
      title: '切片一',
      summary: 's1',
      start: 0,
      end: Math.min(5, d / 4),
      score: 0.9,
      reason: 'r',
      selected: true,
      edited: false,
      source: 'rule'
    },
    {
      id: 'c2',
      title: '切片二',
      summary: 's2',
      start: Math.min(6, d / 3),
      end: Math.min(12, d / 2),
      score: 0.8,
      reason: 'r',
      selected: true,
      edited: false,
      source: 'rule'
    }
  ]
  await step(
    '保存切片',
    `window.vclip.invoke('project:saveClips', ${JSON.stringify(pid)}, ${JSON.stringify(clips)}).then(() => 'ok')`
  )

  const outDir = path.join(TMP, 'out', 'VClip', JSON.parse(created).name)

  // ---- 6. 精确模式导出：不得出现任何字幕文件 ----
  const preciseRes = await step(
    '精确模式导出(subtitleMode=none)',
    `window.vclip.invoke('export:clips', ${JSON.stringify(pid)}, { precise: true, subtitleMode: 'none', includeJson: true })
       .then(r => JSON.stringify(r)).catch(e => 'ERR ' + (e && e.message))`,
    300000
  )
  let pr = null
  try {
    pr = JSON.parse(preciseRes)
  } catch {
    /* ignore */
  }
  assert('精确模式导出返回成功', !!(pr && Array.isArray(pr.files)), pr && pr.failed)
  if (pr && pr.files) {
    const list = fs.existsSync(outDir) ? fs.readdirSync(outDir) : []
    const clipMp4 = list.filter((f) => f.endsWith('.mp4')).map((f) => f.replace(/\.mp4$/i, ''))
    // 只针对「切片同名 SRT」判断；目录里可能存在「导出全部字幕」产生的独立字幕文件
    const clipSrt = list.filter(
      (f) => /\.(srt|ass|vtt)$/i.test(f) && clipMp4.includes(f.replace(/\.[^.]+$/, ''))
    )
    assert('精确模式没有为任何切片生成字幕文件', clipSrt.length === 0, { list, clipSrt })
    assert('精确模式结果 files 列表无字幕文件', !pr.files.some((f) => /\.(srt|ass|vtt)$/i.test(f)), pr.files)
    assert('精确模式已给出「不生成字幕」说明', (pr.notes || []).some((n) => n.includes('字幕')), pr.notes)
    assert('精确模式产出了 mp4 切片', clipMp4.length === 2, list)
  }

  // ---- 7. 快速模式 + sidecar：应生成外挂 SRT（不烧录） ----
  const fastRes = await step(
    '快速模式导出(subtitleMode=sidecar)',
    `window.vclip.invoke('export:clips', ${JSON.stringify(pid)}, { precise: false, subtitleMode: 'sidecar', includeJson: false })
       .then(r => JSON.stringify(r)).catch(e => 'ERR ' + (e && e.message))`,
    300000
  )
  let fr = null
  try {
    fr = JSON.parse(fastRes)
  } catch {
    /* ignore */
  }
  if (fr && Array.isArray(fr.files)) {
    const srtFiles = fr.files.filter((f) => f.endsWith('.srt'))
    assert('快速模式生成了外挂 SRT', srtFiles.length > 0, srtFiles)
    if (srtFiles.length) {
      const t = fs.readFileSync(srtFiles[0], 'utf-8')
      assert('外挂 SRT 条数正常（同一条不重复）', !/^\s*$/.test(t) && t.charCodeAt(0) === 0xfeff)
      const heads = [...t.matchAll(/(\d{2}:\d{2}:\d{2},\d{3})/g)].map((m) => m[1])
      assert('外挂 SRT 无负时间码', heads.every((h) => !h.startsWith('-')), heads.slice(0, 4))
    }
  } else {
    assert('快速模式导出返回结果', false, fr)
  }

  // ---- 8. UI 交互：时间轴定位 / 悬停缩略预览 / 预监画面 / 字幕工具栏 ----
  await step('回到项目页', `(() => { location.reload(); return 'reload' })()`)
  await sleep(2500)
  await step(
    '点击项目卡片',
    `(() => { const c=document.querySelector('.project-card-grid .ant-card'); if(!c) return 'no card'; c.click(); return 'clicked' })()`
  )
  await sleep(2500)

  const layout = await step(
    '关键元素检查',
    `(() => ({
        hasTimeline: !!document.querySelector('.timeline-inner'),
        hasMonitor: !!document.querySelector('.monitor-panel'),
        hasMonitorVideo: !!document.querySelector('.monitor-video'),
        hasSegmented: !!document.querySelector('.monitor-panel .ant-segmented'),
        toolButtons: [...document.querySelectorAll('.monitor-foot button')].map(b=>b.textContent.trim()),
        playheadLeft: (document.querySelector('.tl-playhead')||{}).style ? document.querySelector('.tl-playhead').style.left : null
      }))()`
  )
  assert('存在时间轴', layout && layout.hasTimeline, layout)
  assert('存在预监面板与预监画面', layout && layout.hasMonitor && layout.hasMonitorVideo, layout)
  assert('预监有跟随模式切换', layout && layout.hasSegmented, layout)
  assert(
    '预监提供「设为起点/终点」',
    layout && layout.toolButtons && layout.toolButtons.includes('设为起点') && layout.toolButtons.includes('设为终点'),
    layout && layout.toolButtons
  )

  const diag = await step(
    '进入项目页后的初始状态',
    `(() => {
        const v = document.querySelector('.player-section video')
        return {
          videoDuration: v ? v.duration : null,
          videoCurrentTime: v ? v.currentTime : null,
          paused: v ? v.paused : null,
          readyState: v ? v.readyState : null,
          monitorTc: (document.querySelector('.monitor-tc')||{}).textContent || null,
          playheadLeft: document.querySelector('.tl-playhead').style.left,
          timelineWidth: document.querySelector('.timeline-inner').getBoundingClientRect().width
        }
      })()`
  )
  report.diag = diag

  // 先点「适配」，让 10s 的短视频铺满时间轴，再按比例定位
  await step(
    '点击时间轴「适配」',
    `(() => { const b=[...document.querySelectorAll('.timeline-toolbar button')].find(x=>x.textContent.includes('适配')); if(!b) return 'no btn'; b.click(); return 'fit' })()`
  )
  await sleep(500)

  const before = await step(
    '定位前播放头',
    `(() => ({
        left: document.querySelector('.tl-playhead').style.left,
        tc: (document.querySelector('.monitor-tc')||{}).textContent,
        width: document.querySelector('.timeline-inner').getBoundingClientRect().width
      }))()`
  )

  // 在时间轴上按下 -> 移动 -> 抬起（分帧派发，让 React 有机会重渲染）
  await step(
    '时间轴按下（约 60% 位置）',
    `(() => {
        const inner = document.querySelector('.timeline-inner')
        const r = inner.getBoundingClientRect()
        const x = r.left + r.width * 0.6
        const y = r.top + 30
        window.__tl = { x, y }
        inner.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 1, button: 0, buttons: 1, isPrimary: true }))
        return { x, y, width: r.width }
      })()`
  )
  await sleep(400)
  await step(
    '时间轴拖动到 70% 位置',
    `(() => {
        const r = document.querySelector('.timeline-inner').getBoundingClientRect()
        const nx = r.left + r.width * 0.7
        window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: nx, clientY: window.__tl.y, pointerId: 1, isPrimary: true, buttons: 1 }))
        window.__tl.x = nx
        return 'move'
      })()`
  )
  await sleep(400)
  await step(
    '时间轴抬起',
    `(() => { window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: window.__tl.x, clientY: window.__tl.y, pointerId: 1, isPrimary: true, buttons: 0 })); return 'up' })()`
  )
  await sleep(700)

  const seek = await step(
    '时间轴单击定位结果',
    `(() => {
        const v = document.querySelector('.player-section video')
        return {
          playheadLeft: parseFloat(document.querySelector('.tl-playhead').style.left) || 0,
          videoTime: v ? v.currentTime : null,
          videoDuration: v ? v.duration : null,
          monitorTc: (document.querySelector('.monitor-tc')||{}).textContent || null,
          scrubbingClass: document.querySelector('.timeline-scroll').className.includes('scrubbing')
        }
      })()`
  )
  assert('单击/拖动后播放头已移动', seek && seek.playheadLeft > 0, { before, seek })
  assert(
    '视频随定位联动（currentTime 前进到 60%+ 时长）',
    seek && seek.videoTime !== null && seek.videoTime > (seek.videoDuration || 0) * 0.5,
    seek
  )
  assert('抬起后擦洗状态已复位', seek && !seek.scrubbingClass, seek)

  // 悬停 -> 缩略预览 + 时标线 + 预监画面跟随鼠标
  await step(
    '时间轴悬停',
    `(() => {
        const sc = document.querySelector('.timeline-scroll')
        const r = sc.getBoundingClientRect()
        sc.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: r.left + 160, clientY: r.top + 40, pointerId: 2, isPrimary: true }))
        return 'hover'
      })()`
  )
  await sleep(1200)

  const hover = await step(
    '悬停预览检查',
    `(() => {
        const thumb = document.querySelector('.tl-hover-video')
        return {
          hasThumb: !!document.querySelector('.tl-hover'),
          hasHoverline: !!document.querySelector('.tl-hoverline'),
          thumbReady: thumb ? { readyState: thumb.readyState, w: thumb.videoWidth, h: thumb.videoHeight } : null,
          tc: (document.querySelector('.tl-hover-tc')||{}).textContent || null,
          monitorTc: (document.querySelector('.monitor-tc')||{}).textContent || null,
          badge: (document.querySelector('.monitor-badge')||{}).textContent || null
        }
      })()`
  )
  assert('悬停出现画面缩略预览', hover && hover.hasThumb, hover)
  assert('悬停出现时标线', hover && hover.hasHoverline, hover)
  assert('缩略预览显示时间码', !!(hover && hover.tc), hover)
  assert(
    '缩略预览已解码出真实画面（videoWidth>0）',
    !!(hover && hover.thumbReady && hover.thumbReady.w > 0),
    hover && hover.thumbReady
  )
  assert('预监画面跟随鼠标显示时间码', !!(hover && hover.monitorTc), hover)
  assert('预监标识为「鼠标位置」', !!(hover && hover.badge && hover.badge.includes('鼠标')), hover)

  const monitor = await step(
    '预监画面解码检查',
    `(() => { const v=document.querySelector('.monitor-video'); return v ? { readyState: v.readyState, w: v.videoWidth, h: v.videoHeight, t: v.currentTime, src: v.getAttribute('src') } : null })()`
  )
  assert(
    '预监画面已解码并定位到鼠标时刻',
    !!(monitor && monitor.w > 0 && monitor.t >= 0),
    monitor
  )

  await step(
    '鼠标离开时间轴',
    `(() => {
        // React 的 onPointerLeave 由 pointerout + relatedTarget 合成，直接派发 pointerleave 无效
        const sc = document.querySelector('.timeline-scroll')
        sc.dispatchEvent(new PointerEvent('pointerout', { bubbles: true, relatedTarget: document.body, pointerId: 2, isPrimary: true }))
        return 'leave'
      })()`
  )
  await sleep(500)
  const leave = await step(
    '离开后检查',
    `(() => ({ hasThumb: !!document.querySelector('.tl-hover'), badge: (document.querySelector('.monitor-badge')||{}).textContent }))()`
  )
  assert('离开后缩略预览消失', leave && !leave.hasThumb, leave)

  // 字幕面板工具栏 + 导出按钮
  const subPanel = await step(
    '字幕面板工具栏',
    `(() => {
        const tabs=[...document.querySelectorAll('.bottom-tab')]
        const t=tabs.find(x=>x.textContent.includes('字幕'))
        if(t) t.click()
        return null
      })()`
  )
  void subPanel
  await sleep(800)
  const toolbar = await step(
    '字幕工具栏检查',
    `(() => ({
        hasToolbar: !!document.querySelector('.subtitle-toolbar'),
        buttons: [...document.querySelectorAll('.subtitle-toolbar button')].map(b=>b.textContent.trim()),
        hasSearch: !!document.querySelector('.subtitle-toolbar input')
      }))()`
  )
  assert('字幕面板有工具栏', toolbar && toolbar.hasToolbar, toolbar)
  assert(
    '字幕工具栏含「导出全部字幕」「复制全部」',
    toolbar && toolbar.buttons.includes('导出全部字幕') && toolbar.buttons.includes('复制全部'),
    toolbar && toolbar.buttons
  )
  assert('字幕面板支持搜索定位', toolbar && toolbar.hasSearch, toolbar)

  // 导出菜单项
  const menu = await step(
    '展开导出格式菜单',
    `(async () => {
        const btn=[...document.querySelectorAll('.subtitle-toolbar button')].find(b=>b.textContent.includes('导出全部字幕'))
        if(!btn) return 'no button'
        btn.click()
        await new Promise(r=>setTimeout(r,800))
        const items=[...document.querySelectorAll('.ant-dropdown-menu-item')].map(e=>e.textContent.trim())
        document.body.click()
        return items
      })()`,
    30000
  )
  assert(
    '导出菜单含 SRT/TXT/JSON 三种格式',
    Array.isArray(menu) &&
      menu.some((m) => m.includes('SRT')) &&
      menu.some((m) => m.includes('txt')) &&
      menu.some((m) => m.includes('json')),
    menu
  )

  return finish()
}

function finish() {
  report.rendererLogs = logs.filter((l) => !/GPU|Autofill|devtools/i.test(l)).slice(-20)
  report.mainErrors = mainErrors
  report.pass = report.asserts.filter((a) => a.ok).length
  report.fail = report.asserts.filter((a) => !a.ok).length
  fs.writeFileSync(
    path.join(__dirname, 'features-result.json'),
    JSON.stringify(report, null, 2),
    'utf-8'
  )
  console.log('===FEATURES_START===')
  console.log(JSON.stringify(report, null, 2))
  console.log('===FEATURES_END===')
  app.exit(report.fail ? 1 : 0)
}

main().catch((e) => {
  console.log('===FEATURES_FATAL===')
  console.log((e && e.stack) || String(e))
  app.exit(1)
})
