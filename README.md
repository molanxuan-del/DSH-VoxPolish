# 声琢 · VoxPolish

> **把「说出来的话」打磨成清晰表达。**
> 说 → 原话 1 秒出 → 后台整理 → **你改、你确认、你再发**。

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![DSH 0.2.0-rc.2](https://img.shields.io/badge/DSH-0.2.0--rc.2-blue)
![no build](https://img.shields.io/badge/build-none-brightgreen)

**English** — Voice input with an expression coach for DeepSeek Harness. Your raw
transcript lands in about a second and is sendable immediately, while a fast model
rewrites it into a clear, well-structured prompt in the background. Two send
buttons (raw / polished), a custom vocabulary that fixes misrecognised words, a
live waveform, a model picker — and it **never reads or writes the composer draft**.
Recognition runs on the local SenseVoice model shipped with the official
voice-input bundle, so there is no extra model download.

---

## 为什么不是又一个语音输入插件

多数语音插件做同一件事：**识别完写进输入框**。声琢做的是下一步——**识别完先给你审**。

| | 常见语音插件 | 声琢 |
|---|---|---|
| 识别结果落在哪 | 直接改写输入框 | **独立面板**里的「原话 / 整理后」两块 |
| 什么时候发 | 识别完就发 | **你看过、改过再发**，两个发送键任选 |
| 输入框 | 被读写 | **全程不碰**——插件出问题也丢不了你的草稿 |
| 说得好不好 | 自己体会 | 每次给一行**表达建议** + 最多 3 条**信息缺口** |
| 专有名词/英文总识别错 | 每次手改 | **词表纠错**：登记一次，以后自动纠正 |
| 给别的项目复用 | 不行 | **独立服务**：命令行 + 本地 HTTP API |

---

## 安装

**一行装（CLI 版 DSH）** —— 直接从 GitHub 拉，**不需要 npm**：

```bash
dsh plugin --profile web add github:molanxuan-del/DSH-VoxPolish
```

**DSH 桌面端**：应用内打开 **设置 → 插件**，点 **「添加插件」**，填入同一个来源
`github:molanxuan-del/DSH-VoxPolish`。
（桌面端的 profile 由应用自己管理，公开 CLI 改不了它。）

**本地开发装法**（改了代码要立刻生效时用这个）：

```bash
git clone https://github.com/molanxuan-del/DSH-VoxPolish.git

# 把 <绝对路径> 换成克隆出来的 DSH-VoxPolish 目录，例如：
#   Linux/macOS : link:/home/me/DSH-VoxPolish
#   Windows     : link:G:/path/to/DSH-VoxPolish
dsh plugin --profile web add link:<绝对路径>
```

安装后**重启 DSH**。之后：改 **Host 半**（`lib/index.js`）要重启；改**客户端半**
（`lib/client.js`）刷新页面即可（面板底部会显示当前客户端版本戳，便于确认加载的是哪份代码）。

---

## 30 秒上手

1. 点输入框工具栏上的 **🎤**（自己一个按钮，与官方语音功能互不干扰）→ 按钮变红并显示计时，
   面板里出现**实时声波**，一眼确认麦克风真在收音。
2. 说完**再点一次**停止。
3. **1~2 秒**「原话」出来，此刻就能发；「整理后」在后台整理，好了自动填上。
4. 两个框都能直接改。改完点发送：

   | 按钮 | 什么时候用 |
   |---|---|
   | **🚀 发原话** | 说得没问题，不想等整理 |
   | **🚀 发整理后** | 说得长、理不清，要规整过的版本 |
   | **🎤 继续说** | 再录一段，接到原话后面，整理会把新内容合进去 |
   | **↩ 撤销上一段** | 丢掉最后一段语音，整段重来 |
   | **🔁 重新整理** | 按当前档位重排一遍 |
   | **✕** | 关掉面板，不发送任何内容 |

**📋 粘贴整理**：别处复制来的文字也能整理——点工具栏 **📋** 自动读剪贴板；或者直接把文字
`Ctrl+V` 进「原话」框（≥30 字自动整理）。

**手改过「整理后」再继续说话**：新内容只整理后**追加**，**绝不覆盖**你改过的部分。
想整体重排就点「🔁 重新整理」，它会明确覆盖。

**录音不怕切走**：录音归插件所有，切页面、点别的文件都不会断；工具栏 🎤 一直显示计时。
115 秒自动停止兜底（识别服务单次上限 2 分钟）。

---

## 功能

- **原话 / 整理后 双通道**：原话先到（可立刻发），整理在后台跑，互不阻塞。
- **六档整理方式**：轻度 / **中度（默认）** / 深度 / 更简洁 / 更正式 / 更结构化，面板上随时切。
- **表达教练**：一行「表达建议」指出这次最该改的点 + 最多 3 条建议补充的缺失信息。
- **📚 词表纠错**：一行一词登记专有名词/英文词，整理时自动把识别错误纠正为正确写法；
  「原话」仍保留识别原样作对照。本机持久化，下一轮立即生效。
- **⚙ 模型选择**：面板里枚举 DSH 已配置的全部模型，任选一个来整理并持久保存。
- **实时声波**：`canvas` 逐帧绘制，颜色跟随主题。
- **右侧栏面板**：不占对话空间（见下方「面板住哪」）。
- **零构建、零额外下载**：纯 JavaScript，识别复用官方语音 Bundle 已装好的本机模型。

### 面板住哪（三条路径自动降级）

| 优先级 | 宿主 | 说明 |
|---|---|---|
| 1 | **DSH 官方右侧栏** | `sidebarRightTabs` + `sidebar.right.pane.tab`（DSH 自带，官方插件同款接口）。切到右侧栏**引导页**就能看到「语音整理」入口 |
| 2 | `dsh-better-sidebar` | 仅在官方接口不可用时使用 |
| 3 | 输入框上方 dock | 前两者都不可用时的兜底 |

三条路径**互斥**，渲染时判定，任何注册顺序都不会同时出现两个面板。

---

## 独立服务（给其他项目用）

同一套整理内核也能脱离 DSH 单独跑：命令行 + 本地 HTTP API。

```bash
cd DSH-VoxPolish

# 离线自检（不联网、不需要任何 key）
node service/cli.js --selftest

# 整理文本
export VP_LLM_API_KEY=<你的模型 API key>     # Windows: $env:VP_LLM_API_KEY="..."
node service/cli.js "呃那个我想把函数改成异步的……不对，还是保持同步加个缓存"
node service/cli.js --json "文本"            # 输出 {"polished","tip","gaps"}
echo "口语文本" | node service/cli.js -

# 音频：转写后再整理
node service/cli.js recording.wav
node service/cli.js --transcript recording.wav   # 只要转写原文，不需要 LLM key

# 起本地 HTTP 服务（默认 8787）
node service/server.js
curl -s -X POST http://127.0.0.1:8787/polish \
  -H "content-type: application/json" -d "{\"text\":\"测试\"}"
```

| 环境变量 | 用途 | 默认 |
|---|---|---|
| `VP_LLM_API_KEY` | 整理用的模型 key | 必填 |
| `VP_LLM_BASE_URL` | OpenAI 兼容端点 | `https://api.deepseek.com` |
| `VP_LLM_MODEL` | 模型名 | `deepseek-flash` |
| `VP_ASR` | `local` / `cloud` | — |
| `VP_ASR_BASE_URL` / `VP_ASR_API_KEY` | 云端识别（OpenAI 兼容 `/audio/transcriptions`） | — |

`--asr-check local|cloud` 会如实报告识别能力是否就绪（**不撒谎**：缺模型就报缺）。

> ⚠️ 语音识别的**本地离线**通道（sherpa-onnx）尚未接入，`--asr-check local` 目前会返回
> 「模型文件齐备，但本地推理尚未接入」。云端通道已实现。

---

## 隐私与权限

| 数据 | 去哪 |
|---|---|
| **录音音频** | 送到**本机**的官方 SenseVoice 识别器（`ctx.get('speechToText')`）——**音频不出本机** |
| **原话文字** | 送到**你在 DSH 里配置的那个模型**做整理（通常是你自己的云端 API） |
| 词表 / 模型选择 / 版本戳配置 | 只写本机 `~/.dsh/voice-polish/` |
| 会话输入框 | **从不读写** |
| 遥测 | **没有**。除上面两条外不发起任何外部请求 |

独立服务模式：只有把 `VP_ASR` 设为 `cloud` 时音频才会发给你自己填的端点；默认不启用。

---

## 配置

**默认不写死模型**，整理用哪条路由按优先级决定：

| 优先级 | 来源 | 说明 |
|---|---|---|
| 1 | **面板里选的**（⚙ 整理模型） | 存 `~/.dsh/voice-polish/config.json`，可随时切回「跟随会话默认」 |
| 2 | 插件配置 `provider` / `model` | 想固定一条便宜路由（不占主力模型额度）时写在这里 |
| 3 | 会话默认模型 | 兜底，跟随你在 DSH 里的设置 |

```yaml
- insert:
    - id: voice-polish
      name: 'dsh-voice-polish'
      config:
        provider: deepseek-official
        model: deepseek-flash
        temperature: 0.2
        maxTokens: 2400
```

整理是**改写任务**不是推理任务，便宜快的模型就够。

---

## 兼容性

- **DSH 0.2.0-rc.2**（桌面端 / Web 端均可）。
- 语音识别需要官方 **「语音输入 Bundle」** 已安装并可用（复用它的本机 SenseVoice）。
  识别服务不可用时面板会明确提示，而不是静默失败。
- 右侧栏优先使用 DSH 官方接口；`dsh-better-sidebar` 只是次级回退，**不是必需依赖**。
- Node.js ≥ 20（仅「独立服务」需要）。

---

## 实现要点

纯 JavaScript，**无构建步骤**。客户端半用 DSH 的懒加载 CJS 契约
（`window.__ModuleLoader__.load({ id, factory })`），Host 半是普通 ESM，**零 `@deepseek-ai/*`
运行时 import**。

```
dsh-voice-polish/
  package.json              dsh.bundle.patch + dsh.client{platform:"web"}
  cordis.patch.yml          插件行（默认不写死模型）
  lib/index.js              Host 半：/polish /transcribe /vocab /models /config
  lib/core.js               共享内核：提示词、解析器、词表（插件与服务同源）
  lib/client.js             客户端半：🎤/📋 按钮 + 面板 + 录音管线 + 三种宿主
  service/                  独立服务：cli.js / server.js / llm.js / asr/
  test/                     离线测试（安装时不会下载）
```

- **录音**：`getUserMedia` → `AudioContext({sampleRate:16000})` → `ScriptProcessorNode`
  取原始 PCM（经 0 增益节点接输出，避免回声）→ 编码成 **16 kHz 单声道 PCM16 WAV**。
  浏览器拒绝 16 kHz 时用线性插值重采样。
- **上传走原始二进制**（`application/octet-stream`）不做 base64：16 kHz PCM 一分钟 base64
  要多膨胀三分之一。
- **实时声波**：同一路 source 接 `AnalyserNode`，每帧 RMS 写进 56 格环形缓冲，`canvas`
  按帧绘制；**刻意不经过 React state**，否则 60fps 会把整个面板每帧重渲染一次。
- **模型输出容错**：整理结果要求是 `{"polished","tip","gaps"}` 的 JSON，但模型偶尔会在字符串值里
  留下**未转义的英文双引号**让 JSON 非法。`parseAnswer` 因此是两级的：先严格 `JSON.parse`，
  失败则按键边界切片救回（`salvageAnswer`）——**绝不把原始 JSON 倒给用户**。
- **`sessionId` 必须透传**：只有在请求带 `sessionId` 时，部分路由才会注入所需的会话路由头。

---

## 已知限制

- **改 Host 半必须重启 DSH**（客户端半刷新页面即可）。
- 录音需要麦克风权限，要求 HTTPS 或环回地址。
- 面板内容存在浏览器内存里，刷新页面即清空；发送前确认。
- 识别服务单次最长 **2 分钟**；客户端 **115 秒**自动停止。
- 面板底部的 `客户端 <版本戳>` 是判断「当前跑的是哪份客户端代码」的唯一可信依据——
  报问题请带上它。

---

## 开发与测试

```bash
node --check lib/client.js                                  # 语法
node --test test/parse.test.mjs test/service.test.mjs       # 解析器 + 服务（52 例）
node --test test/client-contract.test.mjs                   # 客户端契约（18 例）
node service/cli.js --selftest                              # 离线自检（28 项）
npm test                                                    # 上面三项的集合
```

`test/client-contract.test.mjs` 是**源码级契约检查**，钉住三类真实踩过的坑：裸注册
（注册生命周期必须挂在 `ctx.effect` 上）、组件副本漂移（三个宿主必须用同一个组件）、
以及渲染可见性依赖某个宿主专属 prop（会导致白屏）。

---

## 路线图

- [x] **v1.0.0** 插件本体：原话/整理后双通道、词表纠错、模型选择、表达教练、实时声波
- [x] **官方右侧栏适配**：迁移到 `sidebarRightTabs`，`dsh-better-sidebar` 降为可选回退
- [x] **独立服务（VoxPolish Service）**：CLI + HTTP API，`--selftest` 全绿
- [x] **一行安装**：`dsh plugin --profile web add github:molanxuan-del/DSH-VoxPolish`（无需 npm）
- [ ] 语音识别可插拔：**本地离线**（sherpa-onnx + SenseVoice，免费、不出本机）与**用户自带 API**
- [ ] 提交到社区插件市场
- [~] ~~发布到 npm~~ —— 暂缓：npm 现已**强制要求发布者开启二次验证**，
      而 GitHub 直装已经能让任何人一条命令装上，所以不为此增加一个账号安全负担

欢迎提 Issue / PR。合并前会逐行审查（公开仓库的 PR 一律按不可信代码审）。

---

## 许可证

MIT © molanxuan-del
