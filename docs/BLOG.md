# 用 Electron 做一个纯本地的 AI 视频切片工作台：VClip 的技术选型与踩坑实录

> 一句话概括：把一段 1 小时的视频丢进去，它在**本机**跑完语音识别，把带时间戳的字幕交给大模型挑出值得发的片段，
> 你在时间轴上拖两下，一键导出十几条能直接发的切片 —— 全程不传视频、不上传音频。

![VClip 主界面](images/02-project.png)

*↑ 真实运行截图：左侧播放器、右侧「预监画面」、中间时间轴（字幕轨 + 切片轨）、底部字幕/切片/导出面板。
素材是一段 9 分 59 秒的访谈，AI 已经切出 7 个候选片段。*

项目已开源：<https://github.com/wyfirstname/videoclip>（MIT，仓库只放源码，成品包自行构建）

> 本文所有截图都来自 v0.3.4 的真实运行（真实项目、真实识别结果、真实导出），没有做任何合成或修图。

---

## 一、为什么做这个

做内容的人大概都经历过这套流程：一场直播回放 / 一次访谈录屏 / 一节课的录课，剪成 10 条短视频要花掉一整天。
真正耗时的不是剪辑软件的操作，而是**来回拖进度条找"哪句话值得单独剪出来"**。

这件事拆开看其实很机械：

1. 把语音转成带时间戳的字幕（谁在什么时候说了什么）
2. 读字幕，判断哪几段自成一体、有信息量、开头就能抓住人
3. 按起止时间把视频切出来，导出成片

第 2 步是语言模型最擅长的，第 1、3 步是工具链问题。三段都能在本机跑完，就没有理由把用户的原片上传到任何服务器。

于是就有了 **VClip**：一个 Electron 桌面应用，识别、切片、导出全本地，唯一的外部调用是**可选**的文本级大模型 API
（也可以换成本地 Ollama，那样就完全没有出网请求）。

---

## 二、它到底能做什么（已实现的功能）

先把功能摊开讲，后面再说技术怎么支撑这些功能。

![首页：我的项目](images/01-home.png)

*↑ 首页就是项目列表，每张卡片直接标出「已识别字幕 / 7 个切片 / 时长 / 创建时间」，点进去就是工作台。*

### 1. 本地语音识别（离线）

- 内置 FunASR 系模型：**SenseVoice Small**（中/英/日/韩/粤，带 token 级时间戳）、**Paraformer**（中文大小两版）
- Silero VAD 做语音活动检测，先切出"有人说话"的片段再逐段识别 —— 既省算力，也避免把静音识别成幻觉文本
- 识别跑在独立的 `utilityProcess` 里，1 小时视频识别时界面照样能拖时间轴、改设置
- 模型可以在设置页一键下载，也可以离屏预置进安装包

### 2. AI 分析切片 + 规则切片兜底

- 把字幕按字符量分块（每块 6000 字）喂给大模型，要求它返回结构化 JSON：标题、摘要、起止时间、评分、推荐理由
- 兼容所有 OpenAI 协议的服务：DeepSeek / 通义千问 / 硅基流动 / Ollama……
- **没有 API Key 也能出片**：内置规则引擎按字幕语义边界、停顿、字数聚合出候选切片
- AI 返回空数组或解析失败时，自动降级到规则切片 —— 保证"有字幕就有切片"，不会让你对着空列表发呆

![AI 切片结果](images/04-clips.png)

*↑ 切出来的 7 条候选：标题、起止时间、一句摘要、推荐理由、评分条，右上角「AI」标记表示来源是大模型而非规则引擎。
卡片右侧的「导出」开关控制是否参与导出，起止时间既能手改，也能直接拖时间轴。*

### 3. 时间轴：能拖、能擦、能悬停看画面

- 字幕轨 + 切片轨双轨；切片可整体拖动、拖边缘改起止点、双击切换是否导出，改动实时保存
- 点空白处即可定位，视频画面实时联动；工具栏支持 `90` / `1:30` / `01:02:03` 三种时间码跳转
- 快捷键：空格播放暂停，`←/→` ±1 秒（`Shift` ±5 秒），`,`/`.` 逐帧
- **鼠标悬停即显示该时刻的画面缩略图** + 时间码 + 当时的字幕原文，并画出与缩略图严格对齐的时标线
- 独立的**预监画面**面板，可切换「跟随鼠标 / 跟随播放头」，选中切片后可一键「设为起点 / 设为终点」

### 4. 一键导出（这一步的细节最多）

- **精确模式**：重新编码（libx264 / veryfast / CRF 20），画面精准对齐到毫秒
- **快速模式**：`-c copy` 流复制，秒级完成，不损失画质
- **导出内容可任选**：「单个切片」和「切片合集」是两个独立开关 —— 只导切片、只导合集、或两者都要
- **切片合集**：把选中切片按顺序拼成一个 `00_切片合集.mp4`；只导合集时，各切片只作为拼接中间产物存在于临时子目录，拼完整体清理，输出目录里就一个文件
- 整份字幕可导出 SRT / 带时间码文本 / JSON，统一写 UTF-8 BOM（Windows 记事本、VLC、PotPlayer 都不会乱码）

### 5. 打包与脱敏

- electron-builder：Windows NSIS 安装包 + `win-unpacked` 绿色目录（复制走就能跑），macOS 出 DMG
- 打包内置**两道脱敏闸门**：入包前扫一遍、`app.asar` 生成后扫一遍，命中 API Key 直接中断构建
- API Key 只存在用户数据目录的 `settings.json` 里，永不进包、不进仓库、不进日志（日志只打掩码）

---

## 三、技术栈

| 层 | 选型 | 说明 |
| --- | --- | --- |
| 桌面容器 | **Electron 33** | 需要 `utilityProcess`（跑 ASR）、自定义特权协议（媒体流）、原生 Node 扩展（ONNX Runtime） |
| 构建 | **electron-vite 2.3**（Vite 5.4） | 主进程 / preload / 渲染进程三份构建配置，开发期 HMR |
| 渲染层 | **React 18.3 + Ant Design 5.21 + TypeScript 5.6** | 表单、表格、滑块直接用 antd；时间轴是手写 SVG/div 布局 |
| 语音识别 | **sherpa-onnx-node 1.10**（ONNX Runtime N-API 绑定） | 纯 native 绑定，不需要 Python、不需要额外服务；自带 Silero VAD 封装 |
| 模型 | **SenseVoice Small / Paraformer**（FunASR 系，ONNX int8） | int8 量化，SenseVoice 约 240MB，Paraformer-small 约 82MB |
| 媒体处理 | **FFmpeg**（`ffmpeg-static`，打包时收集进 `resources/ffmpeg-bin`） | 切片段、拼合集、探时长、抽帧 |
| 大模型 | **任意 OpenAI 兼容 HTTP 接口** | 只发文本（字幕），不发视频；可指向本地 Ollama |
| 打包 | **electron-builder 25** | NSIS + dir，含 `beforePack` / `afterPack` 钩子 |
| 测试 | 自研 e2e + CDP 探针 | 44 项断言的旗舰回归，不调 LLM/ASR 也能跑（不花钱） |

**为什么是 sherpa-onnx 而不是"起个 Python 服务"**：桌面软件里塞 Python 运行时是个无底洞（版本、路径、杀软误报）。
`sherpa-onnx-node` 是 ONNX Runtime 的 N-API 绑定，`npm install` 装完就是一个 `.node` 文件，
`new sherpa.OfflineRecognizer(...)` 直接调，VAD 也有现成封装。代价是打包时要把它从 `app.asar` 里
`asarUnpack` 出来（native 模块不能从 asar 里加载）。

---

## 四、六个真正花时间的实现细节

前面那些功能描述听起来都挺顺，但每一个背后都有一个"不这么写就是坏的"的点。这部分是本文的重点。

### 1. `media://` 协议：必须自己实现 HTTP Range / 206

这是整个项目最贵的一课。

Electron 里放视频最直觉的写法是注册一个自定义协议，然后：

```ts
// ❌ 这样写，视频能播，但进度条拖不动
protocol.handle('media', (req) => net.fetch(pathToFileURL(filePath).toString()))
```

现象很迷惑：视频能正常播放，但 `<video>` 的 `seekable` 只有 `[0, 0]`，**拖进度条、时间轴定位、
悬停预览全部失效，只能播开头缓冲的那几秒**。

原因：`net.fetch(file://)` 返回的响应里既没有 `Content-Length`，也没有 `Accept-Ranges`，
请求头里的 `Range` 还被丢掉了。浏览器拿不到这些信息，就认为这个资源不可随机访问。

所以协议必须自己实现 Range 语义：

```ts
protocol.registerSchemesAsPrivileged([
  { scheme: 'media', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }
])

protocol.handle('media', async (request) => {
  const { size } = await fs.promises.stat(filePath)
  const range = parseRange(request.headers.get('Range'), size)   // bytes=start-end

  const baseHeaders = { 'Content-Type': mime, 'Accept-Ranges': 'bytes' }

  if (!range) {
    // 普通请求：给了 Content-Length 才能算出 seekable
    return new Response(createReadStream(filePath), { status: 200, headers: { ...baseHeaders, 'Content-Length': String(size) } })
  }
  if (range.unsatisfiable) {
    return new Response(null, { status: 416, headers: { ...baseHeaders, 'Content-Range': `bytes */${size}` } })
  }
  return new Response(createReadStream(filePath, { start: range.start, end: range.end }), {
    status: 206,
    headers: { ...baseHeaders, 'Content-Range': `bytes ${range.start}-${range.end}/${size}` }
  })
})
```

验收标准（也是回归测试里的一条）：

```js
await fetch('media://file/D%3A/a.mp4', { headers: { Range: 'bytes=0-99' } })  // → 206
document.querySelector('video').seekable.end(0) === video.duration            // → true
```

> 结论：涉及媒体流的自定义协议，**200 / 206 / 416 三件套 + `Content-Length` + `Accept-Ranges` 一个都不能少**。
> 只返回 200 的"能播"是假象。

### 2. 识别不能卡 UI：`utilityProcess` + VAD 分段

ASR 是 CPU 密集型，跑在主进程会卡死整个应用，跑在渲染进程会抢 UI 线程。Electron 33 的 `utilityProcess`
是正解：Node 环境、独立进程、通过 `postMessage` 通信、崩了不影响主进程。

```ts
const child = utilityProcess.fork(path.join(__dirname, 'asr-worker.js'), [], { serviceName: 'vclip-asr' })
child.postMessage({ type: 'start', audioPath, modelDir, numThreads })
// worker 侧 postMessage({ percent, stage }) → 主进程转发到渲染进程的进度条
```

worker 里的流程是 `ffmpeg 抽 16k 单声道 wav → 读成 Float32Array → VAD 切段 → 逐段 OfflineRecognizer`：

```ts
const vadConfig = {
  sileroVad: {
    model: vadPath,
    threshold: 0.5,          // 语音判定阈值
    minSpeechDuration: 0.3,  // 短于 0.3 秒的"语音"当噪声丢掉
    minSilenceDuration: 0.4, // 静音 0.4 秒以上才切断
    maxSpeechDuration: 15,   // 单段上限，避免一口气 3 分钟不切
    windowSize: 512
  },
  sampleRate, numThreads: 1, provider: 'cpu'
}
const vad = new sherpa.Vad(vadConfig)
// 逐 512 采样点喂进去，vad.front() 取出一段语音 → 单独识别 → 按窗口偏移拼回全局时间轴
```

这么做有三个好处：静音段不送进模型（省时间、少幻觉）、长音频不必一次性进内存的识别器、进度可以按段上报。

### 3. 时间戳兜底：Paraformer 根本不返回 token 时间

这里有个容易踩的坑：**Paraformer 系列不返回 token 级时间戳**，只给一段文本。
如果直接把它当成"每句话从 0 秒开始"，字幕时间会全错，后面切片、悬停预览、导出的对齐全崩。

代码里做了两层：

1. `hasUsableTimestamps(timestamps, duration)` —— 识别完先校验时间戳是否单调、是否落在时长内、是否全 0
2. 不可用时走 `buildSubtitlesProportional()` —— 按字符数比例把总时长分配给每个 token，再结合 VAD 段边界做校正和碎片合并

所以产品里的建议是：要**精确的逐句时间**就用 SenseVoice Small（支持 token 时间戳），
Paraformer 更适合"只要文本、快就行"的场景。这个差异在 README 的常见问题里也写明了 —— 不藏着。

### 4. LLM 切片流水线：分块、约束、校验、兜底

把 1 小时的字幕（几万字）一次性塞给模型是行不通的：上下文超限、成本高、模型还会开始"总结全文"而不是"挑片段"。
所以先分块：

```ts
const MAX_CHARS_PER_BLOCK = 6000   // 按字符量切块，块之间保留时间边界
export function chunkSegments(segments) { /* ... */ }
```

每个块单独请求，要求返回**纯 JSON 数组**（不要 markdown 代码块、不要解释文字），然后 `normalizeClips()`
做一次严格校验：时间必须在块范围内、起止不能颠倒、时长要在阈值内、字段缺失就丢。

时长阈值是**随素材总长自适应**的 —— 这条是踩坑踩出来的。早期版本把"切片至少 15 秒"写死，
结果 10 秒的短视频（比如一条口播）候选全部被丢弃，用户看到的是"分析完成，0 条切片"。
现在提示词会先告诉模型素材总长：

- 短素材（< 1 分钟）：切片可以是 8 秒 ~ 全片时长，"宁短勿空"
- 常规素材：45 秒 ~ 8 分钟为佳，短视频形态 1~4 分钟最佳

并且**明确禁止返回空数组**：

```
## 时长与数量要求
- **禁止返回空数组 []。**
- 若确实找不到亮点，就挑选语义最完整、时长最长、最连贯的段落作为切片；
- 只有在"字幕为空"这种极端情况下才允许返回空数组。
```

再加一层工程兜底：`analyzeProject()` 拿到的切片数为 0 或 JSON 解析失败时，直接调 `analyzeByRules()`，
按字幕的语义边界（句末标点、长停顿、话题切换）聚合出候选。

**这三层（提示词约束 → 结果校验 → 规则兜底）叠起来，才敢对用户承诺"有字幕就有切片"。**

### 5. 悬停缩略图：单飞 seek + rAF 合并

"鼠标在时间轴上滑过，就显示那个时刻的画面"听起来简单，实现起来是个性能陷阱：
鼠标 `mousemove` 每秒能触发上百次，如果每次都 `video.currentTime = t`，解码器会堆积一堆 seek 请求，
画面开始抽搐，CPU 直接拉满。

`ScrubVideo` 的解法是**单飞（single-flight）+ rAF 合并**：

```ts
// 同一时刻只允许一个 seek 在途；期间的新的目标时间只覆盖 targetRef
// seeked 之后再由 requestAnimationFrame 取最新目标 → 天然去抖，不堆积
```

另外两个真实存在的细节：

- **seek 到正好 `duration`** 这个点上，部分解码器会停在原地、不触发 `seeked` 事件 —— 要钳位到 `duration - ε`，并加超时兜底
- 悬停时若正在拖动切片，预览必须让路（否则拖动手感被预览的 seek 拖慢）

![时间轴悬停预览](images/03-hover.png)

*↑ 鼠标停在 04:11 处：浮层里是该时刻的画面（1280×720，已解码）+ 时间码 + 当时那句字幕原文；
右侧「预监画面」切到"跟随鼠标"，显示的是同一帧。蓝色块是字幕、红色块是切片，一眼能看出哪几段已被选中。*

### 6. FFmpeg 导出：为什么要分两种模式，合集怎么拼

**精确模式**（重编码）：

```bash
ffmpeg -y -ss <start> -t <dur> -i in.mp4 \
       -c:v libx264 -preset veryfast -crf 20 \
       -c:a aac -b:a 128k -movflags +faststart out.mp4
```

`-ss` 和 `-t` 都放在 `-i` **之前**（输入侧定位），配合重编码才能做到帧级精准；放在输出侧则会先解码整段再裁，
慢且容易有偏差。

**快速模式**（流复制）：

```bash
ffmpeg -y -ss <start> -t <dur> -i in.mp4 -c copy -avoid_negative_ts make_zero out.mp4
```

秒级完成、无损，代价是起点会被拉到最近的关键帧（前后差最多一个 GOP）。`-avoid_negative_ts make_zero`
是为了把流复制常见的负时间戳（B 帧导致的）归零，否则某些播放器会把开头几百毫秒吞掉、音画错位。

> **精确模式刻意不产出任何字幕**（既不外挂 SRT，也不烧录进画面）。
> 这不是漏了功能：重编码后输出的时间基准和原字幕不完全一致，外挂 SRT 会整体偏移、和画面错位。
> 要字幕就用整份字幕导出，或者切到快速模式（时间戳与原片一致）再勾"额外生成外挂 SRT"。

**切片合集**用 concat demuxer：

```bash
# list.txt 里每行 file '<路径>'，路径要先统一成 / 再转义单引号，否则 Windows 路径容易炸
# 生成逻辑：`file '${p.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`
ffmpeg -f concat -safe 0 -i list.txt -c copy 00_切片合集.mp4
```

快速模式下先试 `-c copy`，一旦片段参数不一致（分辨率/帧率/timebase 不同）就**自动降级重编码**。
合集失败不影响单切片，只在结果区用标签提示。

这里有一条必须守住的不变量：**合集时长 ≡ 各独立切片时长之和**（不是"请求区间之和" —— 流复制受关键帧影响会变长）。
`features.js` 里有一条断言专门比对这个差值（< 0.35s），因为导出逻辑改一次就可能破一次。

导出面板长这样：

![导出设置](images/05-export.png)

*↑ 导出模式（精确 / 快速）、切片字幕策略（默认"不生成任何字幕"，选项旁直接写明原因）、
导出内容（单个切片 / 切片合集 / 附带 clips.json）三者互相独立，怎么组合都行。*

![导出结果](images/06-export-result.png)

*↑ 快速模式下 7 条切片几秒钟就导完，结果区给出真实输出目录，点「打开目录」直达。
注意这次的组合是"只导单个切片"（合集那个勾没勾），所以产出 7 个独立 MP4。*

---

## 五、安全：把"Key 被打进安装包"这件事从流程上堵死

Electron 应用最常见的翻车方式是：开发者本地 `settings.json` 里有一把真实的 API Key，
某次打包不小心把它带进去了，然后安装包被传到群里。

VClip 的做法是**不给"记得清理"留空间**，直接用钩子把打包流程卡死：

| 闸门 | 位置 | 做什么 |
| --- | --- | --- |
| 入包前 | `beforePack` → `scan-secrets.js` | 扫描即将入包的文件（`out/**`、`package.json`、`build/ffmpeg-bin`），命中 `sk-…`、`Bearer …`、私钥块、云厂商凭证、字面量密钥赋值 → 抛错中断构建 |
| 出包后 | `afterPack` | 扫已生成的 `app.asar`，并检查是否混入 `settings.json` / `.env` / `*.pem` |

配套的三件事：

1. **打包白名单**：`files` 只写 `out/**`（编译产物）。源码、脚本、文档、`.env` 一律不进包 ——
   不是"排除敏感文件"，而是"只允许放行这些文件"，方向反过来，漏配的风险小一个数量级
2. **日志掩码**：命中时只打印 `sk-abc…456(len=35)`，绝不把完整密钥写进日志
3. **运行期脱敏**：LLM 接口报错时，响应体里的密钥痕迹先过一遍 `redactSecrets()` 再显示到界面

设置页顺带说明一下密钥的"生命周期"—— 只在这里填一次，落地为 `%APPDATA%\VClip\settings.json`，
应用启动时读、保存时写，全程不碰安装目录：

![设置页](images/07-settings.png)

*↑ 上面是大模型配置（API 地址 / 模型 / Key / Temperature），下面是本地 ASR 模型管理，带体积与「已下载」状态。
这张截图来自一个干净的配置目录，所以 API Key 是空的 —— 也从侧面说明：安装包本身不含任何 Key。*

还有个细节值得一提：**这个扫描器会扫到自己**。测试脚本里我写了把假 Key `sk-SYNTHETIC-...` 用于
"证明应用只从 userData 读密钥"的对照实验，结果 `npm run scan:secrets` 全仓审计时自己命中了自己。
最后改成字符串拼接生成（值完全一样、行为不变），审计才能稳定跑出 0 命中。
**当你的安全检查开始拦住自己的测试代码，说明它真的在工作。**

发布前的自查清单也都做成了脚本：

```bash
npm run scan:secrets   # 全仓审计硬编码密钥
npm run verify:asar    # 校验已生成的 app.asar：结构 + 密钥 + 代码标记
npm run verify:dist    # 从安装包内层解出 app.asar，用本机真实密钥的 5 种编码变体做字面量比对
```

---

## 六、踩坑清单（给要做同类项目的人）

| 坑 | 现象 | 解法 |
| --- | --- | --- |
| 自定义协议不做 Range | 视频能播，但 `seekable` 只有 `[0,0]`，拖不动 | 自己返回 200/206/416 + `Content-Length` + `Accept-Ranges` |
| 原生模块进 asar | `sherpa-onnx-node` 加载失败 | `asarUnpack: "**/node_modules/sherpa-onnx-*/**"` |
| VAD 音频切片传参 | napi 报 `External buffers are not allowed` | `vad.front()` 必须传 `false`，拿副本而不是外部内存缓冲区 |
| ASR 跑在主进程 | 识别时整个界面卡死 | `utilityProcess.fork()` 独立进程 + 进度消息 |
| Paraformer 无 token 时间 | 字幕时间全是 0 秒或挤在一起 | 时间戳可用性校验 + 按字符比例分配 + VAD 边界校正 |
| 切片时长硬编码 | 短视频"分析完成但 0 条切片" | 阈值随素材总长自适应 + 提示词禁止空数组 + 规则兜底 |
| 精确模式外挂字幕 | 字幕整体偏移、和画面错位 | 精确模式不产字幕；要字幕走快速模式或整体导出 |
| 悬停预览疯狂 seek | 鼠标一滑，画面抽搐、CPU 拉满 | 单飞 seek + rAF 合并 + 拖动时禁用预览 |
| 合集用 `-c copy` 拼接 | 参数不一致时直接失败 | 失败自动降级重编码，且不阻塞单切片 |
| electron-builder 首次打包 | `Cannot create symbolic link`（winCodeSign 里的 macOS 符号链接） | 开 Windows 开发者模式，或预置缓存目录 / 显式指定 `ELECTRON_BUILDER_CACHE` |
| 语言包批量删除 | 配了 `electronLanguages` 反而让打包被安全策略中断 | 干脆不配，多占 20MB 而已 |

---

## 七、仓库里有什么、没有什么

这个项目在 GitHub 上是**只放源码**的：<https://github.com/wyfirstname/videoclip>

**没有**的东西（故意的）：

- ❌ Windows 安装包（`VClip Setup x.y.z.exe`）
- ❌ 免安装绿色包（`win-unpacked/`）
- ❌ 语音识别模型权重（320MB+）

它们都是本机构建产物，`.gitignore` 里 `release/`、`models/`、`build/ffmpeg-bin/` 直接排除。
想用成品就自己构建一次 —— 对 Electron + 原生模块的项目来说，这反而是最不容易出问题的分发方式
（不用赌别人的 CPU 指令集、不用赌杀软对未签名 exe 的态度）。

### 从源码安装（Windows）

```bash
git clone https://github.com/wyfirstname/videoclip.git
cd videoclip

# 国内先配镜像，否则 Electron 二进制（100MB+）大概率下载卡死
npm config set registry https://registry.npmmirror.com
export ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
export ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/

npm install
npm run dev        # 开发模式；首次进「设置 → 本地语音识别模型」下载模型
npm run dist:win   # 打包：release/<version>/ 下出安装包 + win-unpacked 绿色目录
```

环境要求：Node.js ≥ 18（推荐 20/22 LTS）、FFmpeg + ffprobe（打包时自动收集，或手动放进 `build/ffmpeg-bin/`）、
ASR 模型（应用内下载，或手动放进 `models/<模型id>/`）、磁盘 ≥ 5GB。

完整步骤（含 FFmpeg 放置、模型目录结构、打包踩坑、数据目录、排错）在
[`docs/INSTALL.md`](https://github.com/wyfirstname/videoclip/blob/main/docs/INSTALL.md)。

---

## 八、这套设计适合谁、不适合谁

**适合**：几十条到上百条的中短视频批量切片；不想把原片传到云上的访谈、课程、直播回放；
已经有 OpenAI 兼容接口（或本地 Ollama）的团队。

**不适合**：需要多轨时间线、转场、调色这类"真剪辑"能力的场景 —— VClip 只做"切片"，不做后期。

**后续想做的**：竖屏重构（自动裁切主体）、按切片批量生成标题/封面文案、导出队列断点续跑、
以及把 `features.js` 那套断言再扩一层覆盖导出组合的边界。

---

## 九、写在最后

这个项目里最有价值的代码不是 AI 相关的部分，而是那几个"看起来只是调个 API"的地方：
一个自定义协议的响应头、一次 seek 的节流、一个时长阈值的自适应、一道打包前的扫描闸门。

它们的共同点是：**写错的时候不会报错，只会"看起来能用"** —— 视频能播但拖不动、字幕导出但错位、
分析完成但没切片、打包成功但带了 Key。这类问题只能靠"先把不变量写下来，再用测试钉住"来解决。

如果这篇内容帮你省掉其中一个坑，那这个项目就值了。

- 仓库：<https://github.com/wyfirstname/videoclip>
- 安装文档：<https://github.com/wyfirstname/videoclip/blob/main/docs/INSTALL.md>
- 变更记录：<https://github.com/wyfirstname/videoclip/blob/main/CHANGELOG.md>
- License：MIT

*（本文基于 VClip v0.3.4 的实际实现整理，代码片段为说明原理做过精简。）*
