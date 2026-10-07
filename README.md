# dsh-voice-polish · 语音表达整理

> **VoxPolish** 项目 —— 把「说出来的话」打磨成清晰表达的 DeepSeek Harness 插件。
> 仓库：<https://github.com/molanxuan-del/DSH-VoxPolish>

一个**完全独立**的语音输入功能，不依赖、不修改、不读取官方语音插件的任何东西。

- **自带麦克风**：工具栏上自己一个 🎤 按钮，点一下开始说，再点一下停止。
- **📋 粘贴整理**：别处复制来的文字也能整理——点工具栏 📋 自动读剪贴板开始整理；
  或者直接把文字 Ctrl+V 进「原话」框（≥30 字自动整理）。剪贴板读不到时会引导你手动粘贴。
- **两份文本，两个发送键**：停止后 **1~2 秒**「原话」就能发；「整理后」在后台整理，好了自动填上。
  说得短、没问题 → 直接「发原话」不等；说得长理不清 → 等「发整理后」。
- **顺带教练**：一行**表达建议**（指出这次表达最该改的那一个点）＋ 最多 3 条**建议补充**的缺失信息。
- **📚 词表纠错**：英文词/专有名词识别总错？加进词表（面板可折叠块，一行一词），整理时自动把识别错误纠正为正确写法。「原话」保持识别原样作对照；本机持久化，改完下一轮整理立即生效。
- **⚙ 模型选择**：面板里枚举 DSH 已配置的全部模型，任选一个来整理并持久保存。
- **不碰输入框**：全程不读写会话输入框，出问题也丢不了东西。

---

## 安装

```bash
# 本地目录（开发中）
dsh plugin --profile <你的 profile> add link:<本目录绝对路径>

# 发布到 npm 之后（计划中）
dsh plugin --profile <你的 profile> add dsh-voice-polish
```

安装后需要**重启 DSH**（Host 半只在安装那一刻解析入口；客户端半改动刷新页面即可）。

语音识别**复用官方「语音输入 Bundle」已经装好的本机 SenseVoice**——本插件不自带模型、
不触发任何下载。若识别服务不可用，面板会给出明确提示并引导你启用那个官方 Bundle。

面板默认住在**右侧栏**（依赖 `dsh-better-sidebar`，通过它公开的
`registerTab` 服务注册）；没有 better-sidebar 时自动回退到输入框下方的面板。

---

## 怎么用

1. 点工具栏上的 **🎤** 开始说话（按钮变红并显示 `⏺ 0:05` 计时）。
   面板里会出现一条**实时声波**，跟着你的音量跳动 —— 一眼就能确认麦克风确实在收音。
2. 说完**再点一次**（🎤 或面板里的「⏹ 停止并出文字」）。
3. **1~2 秒后**「原话」框先出来，马上就能发；「整理后」框显示「整理中…」，好了自动填上。
4. 两个发送键随你选：

   | 按钮 | 作用 |
   |---|---|
   | **🚀 发原话** | 把识别出的原话直接发给 AI —— 说得没问题就走这条，**不用等整理** |
   | **🚀 发整理后** | 把规整后的表述发给 AI —— 说得长、理不清就走这条 |
   | **🎤 继续说** | 再录一段，自动接到原话后面；整理会把新内容合进去 |
   | **↩ 撤销上一段** | 丢掉最后一段语音，原话和整理结果都按剩下的重来 |
   | **🔁 重新整理** | 按当前整理方式把原话重新整理一遍 |
   | **✕** | 关掉面板，不发送任何内容 |

   两个框都能直接改：原话改了就是你要发的话；整理后改了就是你的最终版。

**手改过「整理后」再加语音**：新段落只整理新内容后**追加**到你的手改后面，**绝不覆盖**。
（想整体重排就点「🔁 重新整理」，它会明确覆盖。）

**录音不怕切走**：录音归模块所有，去侧栏点别的文件、切 tab 都不会中断录音；
工具栏的 🎤 始终显示计时，随时能停。115 秒自动停止作为兜底。

---

## 整理方式

面板上随时切换，切换即重新整理（手改过需点两次确认）：

| 档位 | 行为 |
|---|---|
| 轻度 | 只去填充词、顺句子，几乎不改结构 |
| **中度（默认）** | 合并重复、按逻辑重排、必要时分点 |
| 深度 | 整理成结构完整的「目标 → 背景 → 要求 → 期望」需求说明 |
| 更简洁 / 更正式 / 更结构化 | 定向微调 |

提示词里有五条硬约束：**只重组不新增**、**技术词/文件名/路径/命令原样保留**、
**保留你的人称与语气强度**、**前后矛盾以最后一次为准**（改主意/换方案时只保留最终意图，
被覆盖的旧说法会在表达建议里提醒你）、**JSON 字符串值内不允许未转义英文双引号**。

---

## 结构

```
dsh-voice-polish/
  package.json          dsh.bundle.patch + dsh.client{platform:"web"}
  cordis.patch.yml      插件行（默认不写死模型，回退会话默认）
  lib/index.js          Host 半：/polish + /transcribe + /vocab + /models + /config
  lib/client.js         浏览器半：🎤 按钮 + 折叠面板 + 录音管线 + 右侧栏 tab
  test/parse.test.mjs   解析器回归测试（node --test，不随 npm 包发布）
  icon.svg  LICENSE  README.md  .gitignore
```

纯 JavaScript，**无构建步骤**。客户端半用 DSH 的懒加载 CJS 契约
（`window.__ModuleLoader__.load({id, factory})`），Host 半是普通 ESM。

### 与官方语音插件的关系

**没有关系。** 两个插槽入口（`conversation.input.left` 的 🎤、`conversation.input.dock`
的面板兜底）都是新增的，不改动官方插件占据的 `conversation.input.activity`。
语音识别走本插件自己的 Host 半（`ctx.get('speechToText')`），客户端半只发 HTTP。

### 录音与转写

- 采集：`getUserMedia` → `AudioContext({sampleRate: 16000})`（挂起时自动 resume）→
  `ScriptProcessorNode` 取原始 PCM，经 0 增益节点接到输出（避免回声），停止后编码为
  **16 kHz 单声道 PCM16 WAV**。
- **上传走原始二进制**（`application/octet-stream`），不做 base64 —— 16kHz PCM 一分钟
  的 base64 就要 2.5MB，白白膨胀三分之一。
- 若浏览器拒绝 16 kHz 上下文，用线性插值重采样补齐。
- 转写：客户端 `POST /dsh-voice-polish/transcribe`（二进制 WAV）→ Host 半
  `speechToText.resolve/transcribe`，沿用你已配置的识别器（本机 SenseVoice），
  **不新增模型、不新增下载**。

WAV 编码必须逐字节符合 Host 的 `validateWave` 校验
（`fmt` 块 16 字节、`byteRate = 32000`、data 长度为偶数），否则会被拒收。

**实时声波**：同一个 source 再接一路 `AnalyserNode`，每帧取时域数据算 RMS，
写进 56 格环形缓冲；面板用 `canvas` 按帧绘制，最新一格在最右边、向左滚动。
采样循环挂在录音器上（面板关掉也不会断），绘制走 `requestAnimationFrame` ——
**刻意不经过 React state**，否则 60fps 会把整个面板每帧重渲染一次。
波形颜色读自 CSS 变量（`var(--dsw-alias-brand-primary)`），自动跟随主题。

### 前后端

| 方向 | 机制 |
|---|---|
| 录音 → 原话 | 客户端 `POST /dsh-voice-polish/transcribe` → Host 半 `ctx.get('speechToText')` |
| 原话 → 整理 | 客户端 `POST /dsh-voice-polish/polish`（后台跑，不挡原话） |
| 词表 | `GET/POST /dsh-voice-polish/vocab` → `~/.dsh/voice-polish/vocab.txt` |
| 模型列表 | `GET /dsh-voice-polish/models` → `ctx.llm.listProviders()/listModels()` |
| 模型选择 | `GET/POST /dsh-voice-polish/config` → `~/.dsh/voice-polish/config.json` |
| 模型调用 | Host 半 `ctx.llm.stream({provider, model, messages, sessionId})`，120s 超时 |
| 发送消息 | `ctx.sessions.scope(id)` → `conversation.send(text)` |

**客户端半零守卫服务依赖**：不碰 `remote.*` 键、不参与 cordis 的 inject 门控，
只依赖浏览器麦克风 + 几个同源 HTTP 接口。转写和整理都在 Host 半完成 ——
这样无论官方语音插件是否启用，本插件的 UI 都在，只是服务真不可用时给明确报错。

`sessionId` 必须透传：pi-ai 只在请求带 `sessionId` 时才注入 opencode 所需的
`x-opencode-session` 路由头（见 `@earendil-works/pi-ai/dist/providers/opencode-headers.js`）。

### 模型输出容错

整理结果要求是 `{"polished","tip","gaps"}` 的 JSON，但模型偶尔会在字符串值里留下
**未转义的英文双引号**，让整段 JSON 非法。`parseAnswer` 因此是两级的：

1. 先剥掉代码围栏、尝试严格 `JSON.parse`；
2. 失败则走 `salvageAnswer`：按 `"polished"` / `"tip"` / `"gaps"` 的键边界切片取值，
   手工反转义，容忍值内的杂散引号 —— **绝不把原始 JSON 倒给用户**。

`test/parse.test.mjs` 把这条路径（含真实故障样本）钉成回归测试。

---

## 配置

**默认不写死模型**：`cordis.patch.yml` 只插入插件行，整理用哪条路由按下面的优先级决定。

| 优先级 | 来源 | 说明 |
|---|---|---|
| 1 | **面板里选的**（⚙ 整理模型） | 存在 `~/.dsh/voice-polish/config.json`，随时切回「跟随会话默认」 |
| 2 | 插件配置 `provider`/`model` | 想固定一条路由（不占用主力模型的额度）时写在这里 |
| 3 | 会话默认模型 | 兜底，自动跟随你在 DSH 里的设置 |

固定路由的写法（可选）：

```yaml
- insert:
    - id: voice-polish
      name: 'dsh-voice-polish'
      config:
        provider: opencode-go
        model: deepseek-v4.1-flash
        temperature: 0.2
        maxTokens: 2400
```

整理是改写任务，不是推理任务，**用便宜快的模型就够**。

---

## 已知限制

- **改 Host 半必须重启 DSH**：DSH 只在安装那一刻解析插件入口，之后改文件不会热加载
  （客户端半刷新页面即可生效）。
- 录音依赖浏览器麦克风权限，需要 HTTPS 或环回地址。
- 面板内容存在浏览器内存里，刷新页面即清空；发送前请确认。
- 识别服务单次最长 **2 分钟**（内部 4MB 字节闸）：客户端在 **115 秒自动停止**并显示倒计时，
  超长内容请分段——发一段，再点「继续说」录下一段。

---

## 路线图

- [x] **v1.0.0** 插件本体：语音 → 原话 / 整理后双通道、词表纠错、模型选择、右侧栏面板
- [ ] **独立服务（VoxPolish Service）**：把同一套整理能力做成 CLI + HTTP API，
      供其他项目直接调用，不依赖 DSH 进程
  - CLI：`vp "文本"` / `vp audio.wav` / `echo ... | vp -`
  - HTTP：`/health` `/polish` `/transcribe` `/process`（默认 8787）
  - 语音识别可插拔：**本地离线**（sherpa-onnx + SenseVoice，免费）或**云端**（OpenAI 兼容）
- [ ] 发布到 npm（`dsh plugin add dsh-voice-polish` 一行安装）

---

## 许可证

MIT © molanxuan-del
