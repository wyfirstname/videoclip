# VClip 使用说明（快速上手）

## 安装完成后应该具备什么

- 一个可用的语音识别模型目录（应用内下载，或手动放进项目根的 `models/`）：
  - `sense-voice-small/`（推荐，带 token 级时间戳，字幕时间最准）或 `paraformer-zh-small/`（轻量中文）
  - `silero_vad.onnx`（语音活动检测，用于精准分段，缺了时间轴会偏）
- FFmpeg 可用：打包时自动收集进包，或开发时在「设置 → FFmpeg 路径」指定本机 `ffmpeg.exe`（需同时有 `ffprobe`）
- 构建产物（**只在本机，不入库**）：`release\<version>\VClip Setup <version>.exe`（安装包）、`release\<version>\win-unpacked\VClip.exe`（免安装便携版）

> 从 GitHub 拿到的仓库里**没有**上面这些成品包和模型，需要自己构建，见 [INSTALL.md](INSTALL.md)。

## 三步开始使用

1. **启动**：`npm run dev`（开发模式），或运行你自己打出来的 `release\<version>\win-unpacked\VClip.exe`
2. **配置 AI**：右上角「设置」→ 填入 LLM API Key（默认 DeepSeek 接口，也可换成通义千问 / 硅基流动 / 本地 Ollama），点「测试连接」
3. **切片**：首页「新建项目」选视频 → 项目页点「识别字幕」→ 点「AI 分析切片」→ 时间轴拖动微调 → 「导出」页一键导出

## 关于模型选择

| 模型 | 大小 | 特点 |
| --- | --- | --- |
| Paraformer 中文小型 | 90MB | 下载快、识别快；不返回 token 级时间戳，字幕时间按字符比例近似 |
| SenseVoice Small（推荐） | 240MB | 中英日韩粤、自带标点、支持 token 级时间戳，字幕时间更精准 |
| Paraformer 中文大模型 | 230MB | 中文精度更高 |

模型均在「设置 → 本地语音识别模型」中一键下载（GitHub 慢时可在同页配置镜像前缀，如 `https://ghfast.top`）。

## 打包说明（Windows）

```bash
npm run dist:win    # 生成 exe 安装包 + win-unpacked 便携目录
npm run dist:mac    # 生成 dmg（需在 macOS 上执行）
```

打包流程自带**脱敏闸门**，命中即中断打包（不会再出现"API Key 被打进安装包"的情况）：

| 阶段 | 脚本 | 行为 |
| --- | --- | --- |
| `beforePack` | `scripts/beforePack.js` → `scripts/scan-secrets.js` | 扫描即将入包的文件，发现 `sk-…`/`Bearer …`/云厂商凭证/私钥/字面量密钥赋值就抛错 |
| `afterPack` | `scripts/afterPack.js` | 扫已生成的 `app.asar`，并检查是否混入 `settings.json`/`.env`/`*.pem` |

- 打包白名单：`out/**` + `package.json`（仅编译产物）。源码、脚本、文档、`.env` 不进包。
- API Key 只在运行时存于 `%APPDATA%\vclip\settings.json`（用户数据目录，不属于入包范围）。
- 自查：`npm run scan:secrets`（全仓审计）、`npm run verify:asar`（校验已生成的 asar）。
- 命中时日志只打印掩码（`sk-abc…456(len=35)`），不会泄露完整密钥。

> **Windows 打包踩坑记录**：electron-builder 首次打包会下载 `winCodeSign` 包，其中包含 macOS 的 dylib 符号链接，非管理员账户解压会报
> `Cannot create symbolic link : 客户端没有所需的特权`。解决办法二选一：
> 1. 开启 Windows「开发者模式」（设置 → 系统 → 开发者选项），或
> 2. 手动把缓存目录预置好（本项目采用）：
>    ```
>    mkdir %USERPROFILE%\.cache\electron-builder\winCodeSign\winCodeSign-2.6.0
>    7za x -y -snld -bd %USERPROFILE%\.cache\electron-builder\winCodeSign\<临时hash>.7z -o%USERPROFILE%\.cache\electron-builder\winCodeSign\winCodeSign-2.6.0
>    ```
>    其中 7za 来自 `node_modules\7zip-bin\win\x64\7za.exe`。
>
> ⚠️ **预置好了却仍反复重试？是缓存根目录不对。** electron-builder v25 在 Windows 上默认用
> `%LOCALAPPDATA%\electron-builder\Cache`，而不是老文档里的 `%USERPROFILE%\.cache\electron-builder`，
> 于是它在新根目录下找不到预置内容，每次都解压到新的随机目录、每次都因符号链接失败。
> 解决办法是显式指定缓存根：
> ```bash
> ELECTRON_BUILDER_CACHE="C:/Users/<用户名>/.cache/electron-builder" npx electron-builder --win
> ```
> 日志里出现 `-o<AppData\Local\electron-builder\Cache\winCodeSign\<随机hash>>` + `retrying 3 more times`
> 就是这个症状。
>
> 排查技巧：先跑 `npx electron-builder --win --dir` 只出 `win-unpacked`（跳过 NSIS，快很多），
> 确认 `resources/ffmpeg-bin/`、`resources/app.asar.unpacked/node_modules/sherpa-onnx-node/**` 都在，
> 再跑 `--win` 出安装包。

## 目录结构

- 项目数据（字幕、切片）：`%APPDATA%\vclip\projects\<项目id>\`
- 模型：`%APPDATA%\vclip\models\`
- 导出默认目录：系统「视频」目录下的 `VClip\<项目名>\`
