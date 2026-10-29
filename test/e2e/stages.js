/**
 * 后续环节自测：设置页、切片保存、导出、AI 分析错误提示
 */
const path = require('path')
const fs = require('fs')
const { app, BrowserWindow } = require('electron')
const prereq = require('./_prereq')

const UD = process.env.VCLIP_USERDATA || path.join(__dirname, 'userdata')
app.setPath('userData', UD)
prereq.prepare(UD) // 预写 ffmpegPath（源码运行时应用自带的 ffmpeg 查不到）

const logs = []
process.on('uncaughtException', (e) => logs.push('main uncaught: ' + (e && e.stack)))
process.on('unhandledRejection', (e) => logs.push('main unhandled: ' + (e && e.stack)))

require(path.join(__dirname, '../../out/main/index.js'))

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  await app.whenReady()
  await sleep(3000)
  const win = BrowserWindow.getAllWindows()[0]
  const report = { steps: [] }
  const step = async (name, js, wait) => {
    try {
      const p = win.webContents.executeJavaScript(js, true)
      const value = wait ? await Promise.race([p, sleep(wait).then(() => '__TIMEOUT__')]) : await p
      report.steps.push({ name, ok: true, value })
    } catch (err) {
      report.steps.push({ name, ok: false, error: String((err && err.message) || err) })
    }
  }

  // --- 设置页 ---
  await step(
    '打开设置页',
    `(() => { const a=[...document.querySelectorAll('a')].find(x=>x.textContent.includes('设置')); if(!a) return 'no link'; a.click(); return 'clicked' })()`
  )
  await sleep(2500)
  await step('设置页渲染', `document.querySelector('.settings-page') ? 'ok' : document.body.innerText.slice(0,120)`)
  await step(
    '点击「模型目录」按钮',
    `(async () => {
       const b=[...document.querySelectorAll('button')].find(x=>x.textContent.includes('模型目录'));
       if(!b) return 'no button';
       b.click();
       await new Promise(r=>setTimeout(r,1200));
       const err=[...document.querySelectorAll('.ant-message-error')].map(e=>e.textContent.trim()).join(' | ');
       return err ? 'ERR ' + err : 'ok';
     })()`,
    15000
  )
  await step('模型列表渲染', `[...document.querySelectorAll('.ant-card')].length`)

  // --- 导出流程 ---
  const pid = await win.webContents.executeJavaScript(
    `window.vclip.invoke('project:list').then(l=>l[0]?l[0].id:'')`,
    true
  )
  report.projectId = pid

  await step(
    '保存一个切片',
    `window.vclip.invoke('project:saveClips', ${JSON.stringify(pid)}, [{
        id:'c1', title:'测试切片', summary:'自测用切片', reason:'验证导出',
        start:1.0, end:4.0, score:90, selected:true, edited:false
      }]).then(()=> 'ok').catch(e=>'ERR '+(e&&e.message))`
  )

  await step(
    '导出切片（精确模式）',
    `window.vclip.invoke('export:clips', ${JSON.stringify(pid)}, {precise:true, includeSrt:true, includeJson:true})
       .then(r=>JSON.stringify({outputDir:r.outputDir, files:r.files.length, failed:r.failed}))
       .catch(e=>'ERR '+(e&&e.message))`,
    120000
  )

  await step(
    'AI 分析（未配置 API Key，预期明确报错）',
    `window.vclip.invoke('analyze:start', ${JSON.stringify(pid)}).then(r=>'OK '+r.length).catch(e=>'ERR '+(e&&e.message))`,
    90000
  )

  report.mainLogs = logs
  fs.writeFileSync(path.join(__dirname, 'stages-result.json'), JSON.stringify(report, null, 2), 'utf-8')
  console.log('===STAGES_START===')
  console.log(JSON.stringify(report, null, 2))
  console.log('===STAGES_END===')
  app.exit(0)
}

main().catch((e) => {
  console.log('===STAGES_FATAL===' + ((e && e.stack) || e))
  app.exit(1)
})
