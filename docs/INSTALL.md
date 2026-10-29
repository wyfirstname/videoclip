# VClip 安装指南（从源码手动安装）

> **本仓库只发布源代码。**
>
> 仓库里**没有** Windows 安装包（`VClip Setup x.y.z.exe`），**没有**免安装便携版（绿色包
> `win-unpacked/`），也**没有**语音识别模型权重（320MB+）。这些都属于本机构建产物，
> 已在 `.gitignore` 中排除（见 `release/`、`models/`、`build/ffmpeg-bin/`）。
>
> 所以从 GitHub 拿到代码后，需要你**在自己的机器上手动安装依赖并构建**。下面是从零开始的全流程，
> 按顺序做完即可跑起来；只想快速试用，走「第 6 节 开发模式」；想要双击即用的成品，走「第 7 节 打包」。

---

## 1. 环境要求

| 项目 | 要求 | 说明 |
| --- | --- | --- |
| 操作系统 | Windows 10/11 x64 | 主力验证平台；macOS 可打出 DMG，但未做完整回归 |
| Node.js | **18 或更高**（推荐 20 / 22 LTS） | `node -v` 自检；npm 随 Node 一起安装 |
| Git | 任意较新版本 | 用于 `git clone` 与版本记录 |
| 磁盘空间 | **≥ 5 GB** | `node_modules` 约 740MB、模型约 320MB、构建产物约 1GB，另需临时空间 |
| 网络 | 首次安装需要 | 下载 Electron 二进制（约 100MB）、npm 依赖、模型权重 |
| FFmpeg | 构建时自动收集，或手动提供 | 见第 4 节；`ffmpeg` 与 `ffprobe` 两个都要 |

---

## 2. 获取源码

```bash
git clone https://github.com/wyfirstname/videoclip.git
cd videoclip
```

没有 Git 也可以：仓库页面 → `Code` → `Download ZIP`，解压后进入目录。

---

## 3. 安装依赖

### 3.1 国内网络先配镜像（强烈建议）

PowerShell：

```powershell
# npm 包
npm config set registry https://registry.npmmirror.com

# Electron 二进制（postinstall 会从 GitHub 拉 100MB+，不设镜像经常卡死）
$env:ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"

# electron-builder 打包时需要的 7za / nsis 等工具链
$env:ELECTRON_BUILDER_BINARIES_MIRROR="https://npmmirror.com/mirrors/electron-builder-binaries/"
```

> 上面两个 `$env:` 只在当前窗口生效。想长期生效：`setx ELECTRON_MIRROR "https://npmmirror.com/mirrors/electron/"`，然后重开终端。

### 3.2 安装

```bash
npm install
```

- 卡在 `Downloading electron` → 回到 3.1 设置 `ELECTRON_MIRROR`，删掉 `node_modules/electron` 重装。
- 仍然卡死 → `npm install --ignore-scripts` 装完 JS 依赖后，按 `README.md` FAQ 第 1 条手工补 Electron 二进制。

---

## 4. 准备 FFmpeg

应用导出切片、探测时长、生成悬停缩略图都依赖 FFmpeg，且**必须同时有 `ffprobe`**。

**方式 A（默认，通常不需要动手）**
`scripts/beforePack.js` 在打包时会依次尝试：`build/ffmpeg-bin/` 里已有的二进制 → `ffmpeg-static` 的 postinstall 产物 → 系统 PATH。只要有任意一个来源可用就会自动收集进安装包。

**方式 B（推荐的稳妥做法）**
自己下载一份完整版 FFmpeg，把两个可执行文件放进缓存目录，后续打包直接复用、不再依赖网络：

```
build/ffmpeg-bin/ffmpeg.exe
build/ffmpeg-bin/ffprobe.exe
```

> 体积校验：单个文件必须大于 64KB，否则 `beforePack.js` 会判定"不是真二进制"并中断打包 —— 这是为了避免把同名脚本误打进包（会导致运行期 `spawn UNKNOWN`）。
>
> 开发模式下（`npm run dev`）也可以不准备这两个文件，直接在「设置 → FFmpeg 路径」里指定本机 `ffmpeg.exe`。

---

## 5. 准备语音识别模型

模型有两条路，任选：

### 5.1 应用内一键下载（推荐，最省事）

启动应用 → **设置 → 本地语音识别模型** → 选一个下载（推荐 `SenseVoice Small`，约 240MB，带 token 级时间戳，时间最准）：

- 下载后会落到用户数据目录：Windows `%APPDATA%\vclip\models\<模型 id>`（安装版是 `%APPDATA%\VClip\models`）
- GitHub 慢的话，在同一页填「下载镜像前缀」（任意可用的 GitHub 反代地址），下载会自动走前缀

### 5.2 手动放置（离线 / 想随包预置）

把模型放进**项目根目录**的 `models/`（开发模式自动识别；打包时会被塞进 `resources/models`）：

```
models/
├─ silero_vad.onnx                 # VAD 语音分段，必需，约 630KB
├─ sense-voice-small/
│  ├─ model.int8.onnx              # 约 240MB
│  └─ tokens.txt
└─ paraformer-zh-small/            # 可选，轻量中文模型，约 82MB
   ├─ model.int8.onnx
   └─ tokens.txt
```

目录名必须是模型 id：`sense-voice-small` / `paraformer-zh` / `paraformer-zh-small`（不是压缩包里的长目录名）。

命令行下载（Windows 10+ 自带 `tar`，可直接解 bz2）：

```bash
mkdir models

# SenseVoice Small
curl -L -o sv.tar.bz2 https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17.tar.bz2
tar -xjf sv.tar.bz2 -C models
mv models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17 models/sense-voice-small
rm sv.tar.bz2

# Paraformer 中文小型（可选）
curl -L -o pf.tar.bz2 https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-paraformer-zh-small-2024-03-09.tar.bz2
tar -xjf pf.tar.bz2 -C models
mv models/sherpa-onnx-paraformer-zh-small-2024-03-09 models/paraformer-zh-small
rm pf.tar.bz2

# VAD（必需，缺失会导致时间轴不准）
curl -L -o models/silero_vad.onnx https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx

# 只保留实际用到的文件，不必要的大文件可以删掉
rm -rf models/sense-voice-small/test_wavs models/sense-voice-small/model.onnx
rm -f models/sense-voice-small/export-onnx.py
```

> `model.onnx` 是全精度版（约 937MB），代码只用 `model.int8.onnx`，删掉不影响功能。
>
> 一个模型都不放也能启动：只是首次识别前必须先下载，否则会提示「模型尚未下载」。

---

## 6. 开发模式运行

```bash
npm run dev
```

首次启动后按应用内提示配置 AI（可选）：

- **设置 → AI (LLM)**：填 OpenAI 兼容接口，如 DeepSeek / 通义千问 / 硅基流动，或本地 Ollama（`http://localhost:11434/v1`）
- API Key 只写到本机用户数据目录的 `settings.json`，**不会进仓库、不会进安装包**
- 不配 Key 也能用：字幕识别、规则切片、手动切片、导出全部本地可用

其他常用命令：

```bash
npm run build          # 只编译（out/）
npm run typecheck:node # 主进程类型检查
npm run typecheck:web  # 渲染进程类型检查
npm run scan:secrets   # 全仓扫描硬编码密钥，应为 0 命中
```

---

## 7. 构建成品（安装包 / 便携版）

```bash
npm run dist:win
```

产物固定在 `release/<version>/`：

| 产物 | 路径 | 说明 |
| --- | --- | --- |
| NSIS 安装包 | `release/0.3.4/VClip Setup 0.3.4.exe` | 双击安装，可选安装目录、自动建桌面快捷方式 |
| **便携版（绿色包）** | `release/0.3.4/win-unpacked/` | 整个目录复制到任意位置，双击 `VClip.exe` 直接运行，不写注册表 |

> ⚠️ 这两种产物**只留在你自己的机器上**，也**不要**提交到仓库（`release/` 已在 `.gitignore` 里）。
> 想分发给别人时，直接发 exe 或把 `win-unpacked` 打包成压缩包，走文件传输而不是 git。

打包时的两道脱敏闸门（命中即中断构建，不会带病出包）：

1. `scripts/beforePack.js` → 扫描即将入包的文件（`out/**`、`package.json`、`build/ffmpeg-bin`）
2. `scripts/afterPack.js` → 扫描已生成的 `app.asar`，并检查包内是否混入 `settings.json` / `.env` / `*.pem`

发布前建议再跑一遍：

```bash
npm run verify:dist   # 从安装包内层解出 app.asar 做密钥字面量比对 + 结构校验
```

macOS（需在 macOS 上执行）：

```bash
npm run dist:mac
```

---

## 8. 运行期数据在哪

| 内容 | 开发模式 | 安装后 |
| --- | --- | --- |
| 设置（含 API Key） | `%APPDATA%\vclip\settings.json` | `%APPDATA%\VClip\settings.json` |
| 模型 | `%APPDATA%\vclip\models\` 或项目 `models/` | `%APPDATA%\VClip\models\` 或安装目录 `resources\models\` |
| 项目与字幕 | `%APPDATA%\vclip\projects\` | `%APPDATA%\VClip\projects\` |
| 导出成片 | 设置里的输出目录，留空则 `视频\VClip\<项目名>` | 同左 |

macOS 对应 `~/Library/Application Support/vclip`。卸载程序**不会**删除这些数据，也不会删除含有明文 Key 的 `settings.json`；共用机器前请手动清理。

---

## 9. 装不上？先看这几条

完整排查清单见 [`README.md` 的「常见问题」](../README.md#-常见问题实测记录)，最常踩的四个：

1. **`npm install` 卡在 Electron 下载** —— 没设 `ELECTRON_MIRROR`，见 3.1。
2. **打包报 `Cannot create symbolic link : 客户端没有所需的特权`** —— electron-builder 解压 `winCodeSign` 需要符号链接权限，开启 Windows 开发者模式，或按 [`QUICKSTART.md`](QUICKSTART.md#打包说明windows) 预置缓存目录。
3. **打包报「未找到可用的 ffmpeg 二进制」** —— 按第 4 节方式 B 手工放 `build/ffmpeg-bin/ffmpeg.exe`、`ffprobe.exe`（每个 > 64KB）。
4. **识别报「模型尚未下载」** —— 按第 5 节放模型，或在设置页下载；注意目录名必须是模型 id。

---

## 10. 版本与升级

- 版本号在 `package.json` 的 `version`，产物目录 `release/<version>/` 与之一致。
- 升级源码：`git pull` 后重新 `npm install`（依赖有变动时）→ `npm run dist:win`。
- 覆盖安装不会动用户数据目录，项目、字幕、设置都保留。
