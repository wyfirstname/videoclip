// electron-builder afterPack hook:
// 最后一道脱敏闸门 —— 直接扫描已生成的 app.asar，确认里面没有任何密钥痕迹。
// 与 beforePack 的扫描互补：beforePack 扫的是「将要入包的源文件」，
// afterPack 扫的是「真正入包后的产物」，能兜住打包过程中的任何意外注入。
//
// app.asar 是未压缩归档，字符串以明文存储，因此直接对整个文件做模式匹配即可。
const fs = require('fs')
const path = require('path')
const { PATTERNS } = require('./scan-secrets')

function mask(s) {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length <= 10 ? `${t[0]}***` : `${t.slice(0, 6)}…${t.slice(-3)}(len=${t.length})`
}

function scanAsar(asarPath) {
  const text = fs.readFileSync(asarPath).toString('utf-8')
  const hits = []
  for (const { name, re } of PATTERNS) {
    re.lastIndex = 0
    let m
    while ((m = re.exec(text)) !== null) {
      hits.push({ rule: name, sample: mask(m[0]) })
      if (hits.length > 50) return hits
    }
  }
  return hits
}

exports.default = async function (context) {
  const resourcesDir = path.join(context.appOutDir, 'resources')
  const asarPath = path.join(resourcesDir, 'app.asar')
  const size = (fs.statSync(asarPath).size / 1024 / 1024).toFixed(1)

  const hits = scanAsar(asarPath)
  if (hits.length) {
    const detail = hits.slice(0, 10).map((h) => `    [${h.rule}] ${h.sample}`).join('\n')
    throw new Error(
      `[afterPack][secret-scan] app.asar 中发现 ${hits.length} 处疑似密钥，已中断打包：\n${detail}\n` +
        '  请确认没有把密钥硬编码进源码或打进构建产物。'
    )
  }

  // 附带确认：自己的构建产物里不应出现用户数据/配置文件（API Key 只存于用户数据目录）。
  // 只检查非 node_modules 条目 —— 第三方包自带 docs/测试证书属正常。
  const forbidden = ['settings.json', '.env', 'id_rsa', '.pem']
  const listed = []
  try {
    const asar = require('@electron/asar')
    for (const f of asar.listPackage(asarPath)) listed.push(f)
  } catch (e) {
    console.warn('[afterPack][secret-scan] 无法列出 asar 内容：', e && e.message)
  }
  const own = listed.filter((f) => !f.replace(/\\/g, '/').replace(/^\//, '').startsWith('node_modules/'))
  const bad = own.filter((f) => forbidden.some((k) => f.includes(k)))
  if (bad.length) {
    throw new Error(
      `[afterPack][secret-scan] app.asar 中出现不应打包的敏感文件：\n    ${bad.join('\n    ')}`
    )
  }

  console.log(
    `[afterPack][secret-scan] app.asar 已校验脱敏（${size}MB，${listed.length} 个条目，0 处密钥）`
  )
}
