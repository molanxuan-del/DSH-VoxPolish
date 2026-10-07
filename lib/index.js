/**
 * dsh-voice-polish — host half.
 *
 * Owns a small public surface, all same-origin JSON/binary routes:
 *
 *   POST /dsh-voice-polish/polish      spoken transcript → { polished, tip, gaps }
 *   POST /dsh-voice-polish/transcribe  raw 16 kHz WAV   → { text }
 *   GET  /dsh-voice-polish/vocab       the user's custom word list
 *   POST /dsh-voice-polish/vocab       persist the word list
 *   GET  /dsh-voice-polish/config      liveness + resolved model route
 *
 * The browser half never talks to a model directly and never mutates the
 * composer draft. The model call goes through the ordinary `llm` service, so
 * whichever provider route the user already pays for is reused.
 *
 * Export shape follows the dsh convention for host plugin halves:
 * `name` / `inject` / `apply`, and no default export.
 *
 * @module dsh-voice-polish
 */

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** Cordis plugin name. */
export const name = 'dsh-voice-polish'

/** The route carrier this half cannot work without. */
export const inject = ['webServer']

/** Public route prefix. */
const ROUTE_PREFIX = '/dsh-voice-polish'

/** Liveness marker: bumped whenever the host half changes, so a reload can be proven. */
const rev = 'v9-model-picker'

/** Largest accepted transcript, in UTF-16 code units. A spoken turn is far below this. */
const MAX_INPUT_CHARS = 24_000

/** Largest accepted request body, in bytes. 64 MiB ≈ 33 minutes of PCM16 audio. */
const MAX_BODY_BYTES = 64 * 1024 * 1024

/** Word-list caps: enough for any real vocabulary, small enough for the prompt. */
const VOCAB_MAX_LINES = 200
const VOCAB_MAX_CHARS = 4000

/** Where the user's word list lives, inside the DSH home directory. */
function vocabFilePath() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  return path.join(home, 'voice-polish', 'vocab.txt')
}

/**
 * Read the word list. A missing file is an empty list, not an error.
 * @returns {string} the raw file text ('' when absent or unreadable).
 */
function readVocab() {
  const file = vocabFilePath()
  try {
    if (!existsSync(file)) return ''
    return readFileSync(file, 'utf8')
  } catch {
    return ''
  }
}

/**
 * Persist the word list.
 * @param {string} text - raw multi-line word list.
 * @returns {{ lines: number }} how many usable words were kept.
 */
function writeVocab(text) {
  const clean = normalizeVocab(text)
  const file = vocabFilePath()
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, clean, 'utf8')
  return { lines: clean.length === 0 ? 0 : clean.split('\n').length }
}

/** Trim, drop empties and duplicates, cap the size. */
function normalizeVocab(text) {
  const seen = new Set()
  const lines = []
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const word = line.trim()
    if (word.length === 0 || seen.has(word)) continue
    seen.add(word)
    lines.push(word)
    if (lines.length >= VOCAB_MAX_LINES) break
  }
  let out = lines.join('\n')
  if (out.length > VOCAB_MAX_CHARS) out = out.slice(0, VOCAB_MAX_CHARS)
  return out
}

/** Where the model picked in the panel is persisted. */
function overrideFilePath() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  return path.join(home, 'voice-polish', 'config.json')
}

/**
 * Read the panel-picked model override.
 * @returns {{ provider: string, model: string } | undefined} the override, or undefined when unset/invalid.
 */
function readOverride() {
  try {
    const file = overrideFilePath()
    if (!existsSync(file)) return undefined
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    if (parsed && typeof parsed.provider === 'string' && typeof parsed.model === 'string' && parsed.provider && parsed.model) {
      return { provider: parsed.provider, model: parsed.model }
    }
  } catch {
    // A broken override file falls back to the normal route chain.
  }
  return undefined
}

/** Persist the panel-picked model override. */
function writeOverride(override) {
  const file = overrideFilePath()
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(override, null, 2), 'utf8')
}

/** Remove the override so polishing falls back to the configured/default route. */
function clearOverride() {
  try {
    const file = overrideFilePath()
    if (existsSync(file)) unlinkSync(file)
  } catch {
    // Best effort.
  }
}

/** In-memory model catalog cache: enumerating every provider is not free. */
let modelsCache = null
let modelsCacheAt = 0

/**
 * Enumerate every provider/model the DSH composition has configured, so the
 * panel can offer them as polish targets. Read live: a provider or model added
 * to DSH shows up here without touching this plugin.
 * @param ctx - plugin context.
 * @returns {Promise<{ groups: Array<{ provider: string, name: string, models: Array<{ id: string, name: string }> }> }>}
 */
async function listModelCatalog(ctx) {
  if (modelsCache !== null && Date.now() - modelsCacheAt < 60_000) return modelsCache
  const llm = ctx.get('llm')
  if (llm === undefined) throw new Error('llm service is unavailable')
  const providers = await llm.listProviders()
  const groups = await Promise.all(
    providers.map(async (provider) => {
      try {
        const models = await Promise.race([
          Promise.resolve(llm.listModels(provider.id)),
          new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 8000)),
        ])
        return {
          provider: provider.id,
          name: provider.name ?? provider.id,
          models: (models ?? [])
            .filter((model) => model && typeof model.id === 'string')
            .map((model) => ({ id: model.id, name: model.name ?? model.id })),
        }
      } catch {
        return { provider: provider.id, name: provider.id, models: [] }
      }
    }),
  )
  modelsCache = { groups: groups.filter((group) => group.models.length > 0) }
  modelsCacheAt = Date.now()
  return modelsCache
}

/**
 * The prompt block that teaches the polish model the user's vocabulary.
 * @param {string} vocabText - raw word-list file text.
 * @returns {string} a prompt appendix, or '' when the list is empty.
 */
function vocabPromptBlock(vocabText) {
  const clean = normalizeVocab(vocabText)
  if (clean.length === 0) return ''
  return `\n\n【用户自定义词表】语音识别经常把下面这些词转成错误的同音字或错别字。整理时，凡是发现与这些词读音相近、字形相近的错误写法，必须纠正为词表中的写法；对应不上的不要改动。纠错只发生在 polished 里。\n${clean}`
}

/**
 * Style presets. `style` in the request selects one; the guide is pasted into the
 * user message so the system prompt stays one stable, cacheable block.
 */
const STYLE_GUIDE = {
  light:
    '最小改动。只删除填充词与无意义重复、修正明显的口误和同音错别字、顺手补齐断句。保持原有句序与分段，不重新组织，不做任何扩写。',
  moderate:
    '在保留原意的前提下重排表达：合并重复内容，按逻辑顺序组织，必要时拆成短段落或分点。不新增用户没说过的信息。',
  deep:
    '整理成一份结构完整的需求说明：先用一句话说清核心诉求，再分点展开背景、细节、约束与期望结果。只能重组用户已表达的内容，信息不足处一律留空，不要编造。',
  concise:
    '在不丢信息的前提下尽量压缩篇幅，用更短的句子说同样的事。不要因为追求简短而删掉技术细节或约束条件。',
  formal:
    '改成书面、克制、专业的措辞，去掉口头语和情绪化表达，但保留用户原本的诉求强度与判断。',
  structured:
    '重点做结构：按「目标 → 现状/问题 → 具体要求 → 期望结果」归类重排，用分点呈现。分类归不准的内容，宁可放在「其他」里，也不要硬塞或编造。',
}

/** Fallback style when the request names one we do not know. */
const DEFAULT_STYLE = 'moderate'

/** Stable instruction block. Kept free of per-request data so it can be cached. */
const SYSTEM_PROMPT = `你是一个「语音表达整理器」，服务于一个 AI 助手（DSH）的输入框。

用户用语音口述需求，转写文本通常带有：口语填充词（呃／啊／嗯／那个／就是说／然后就是／这个这个）、
重复与自我更正（"不对，我是说……"）、想到哪说到哪的乱序、以及同音错别字。

你输出三个部分：

1. polished —— 规整后的表达。用户会拿它直接发给 AI 助手，所以它必须能独立读懂，不依赖任何上下文。
2. tip —— 一句话表达建议，不超过 40 字，只针对这次表达里最值得改进的那一个点。要具体（指出是哪一句、哪个毛病），不要写"请表达更清晰"这类空话。
3. gaps —— 为了让 AI 准确理解并直接开工，用户还缺哪些关键信息；最多 3 条，每条不超过 20 字。没有缺口就给空数组，不要硬凑。

铁律（违反任何一条即算失败）：
- 只重组用户已经表达过的内容。绝对不要新增需求、数字、文件名、技术选型、结论或承诺。
- 技术名词、文件名、路径、命令、代码、专有名词、产品名：原样保留，一个字符都不要"润色"。
- 保留用户的人称与语气强度（"我想"／"必须"／"别用"／"千万别"）。
- 删除填充词、无意义重复，以及被用户自己当场否定的内容（"不对，我是说 X" → 只留 X）。
- 前后矛盾时，以最后一次说的为准：先说的和后说的冲突（改主意、换方案、推翻条件、换文件/换参数），你要判断并只保留最终意图的那个版本，旧说法整句丢弃——不要两种并列，不要用"或者"调和，也不要写成"先…后…"的过程记录。若被舍弃的旧版本里有重要信息，在 tip 里提醒一句（例：前面说 A，后面改为 B，已按 B 整理）。没有明确先后指向的小冲突（如同时要两个都保留也说得通），才原样并列。
- 修正明显的同音错别字（例如"配制"→"配置"、"环回"→"返回"），拿不准就保留原文。
- 不要客套话，不要"好的／收到／以下是我的整理"，不要解释你在做什么。
- 不要用 Markdown 代码块包裹结果，不要输出 JSON 之外的任何文字。
- 不要输出空行：段落之间只用一个换行，任何位置都不允许出现连续两个换行。
- JSON 字符串值内部绝对不允许出现未转义的英文双引号 "：要引用某个词时用中文引号「」，例如「不与 rr 耦合」。

只输出一个 JSON 对象：
{"polished":"规整后的完整文本","tip":"一句话表达建议","gaps":["缺失信息一","缺失信息二"]}

polished 内部可以包含换行和「1. 2. 3.」分点，但整体必须是合法的 JSON 字符串（换行写成 \\n）。`

/**
 * Read a request body with a hard size cap.
 *
 * On overflow it rejects WITHOUT destroying the socket: `req.destroy()` mid-upload
 * resets the connection and the browser reports a bare "Failed to fetch", hiding
 * the real 413. The caller's catch writes the JSON response instead.
 *
 * @param req - Node request stream.
 * @param limit - maximum accepted bytes.
 * @param raw - true to resolve with the raw Buffer (binary audio) instead of UTF-8 text.
 * @returns the body.
 */
function readBody(req, limit, raw = false) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let settled = false
    req.on('data', (chunk) => {
      if (settled) return
      size += chunk.length
      if (size > limit) {
        settled = true
        reject(new Error(`request body exceeds ${limit} bytes`))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (settled) return
      settled = true
      const body = Buffer.concat(chunks)
      resolve(raw ? body : body.toString('utf8'))
    })
    req.on('error', (error) => {
      if (settled) return
      settled = true
      reject(error)
    })
  })
}

/**
 * Write one JSON response. Failure-safe: a client that aborted mid-upload leaves
 * a dead socket, and `res.end` on it throws — that must never escape into an
 * unhandled rejection in the host process.
 * @param res - Node response.
 * @param status - HTTP status code.
 * @param payload - serializable body.
 */
function writeJson(res, status, payload) {
  if (res.destroyed === true || res.writableEnded === true) return
  try {
    const body = JSON.stringify(payload)
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(body),
    })
    res.end(body)
  } catch {
    // The client disconnected; nothing left to report to.
  }
}

/**
 * Resolve the provider/model route to polish with: explicit plugin config first,
 * then whatever the session default model already points at.
 * @param ctx - plugin context.
 * @param config - plugin config from the profile patch.
 * @returns a provider/model pair.
 * @throws when neither source names a complete route.
 */
function resolveRoute(ctx, config) {
  // The panel picker wins when set — it is the user's most recent explicit choice.
  const override = readOverride()
  if (override) return { provider: override.provider, model: override.model, source: 'panel-picker' }
  const configuredProvider = typeof config?.provider === 'string' ? config.provider : undefined
  const configuredModel = typeof config?.model === 'string' ? config.model : undefined
  if (configuredProvider && configuredModel) {
    return { provider: configuredProvider, model: configuredModel, source: 'config' }
  }
  try {
    const selection = ctx.get('agentDefaultModel')?.currentSelection?.()
    const provider = selection?.provider ?? selection?.providerId
    const model = selection?.model ?? selection?.modelId
    if (typeof provider === 'string' && typeof model === 'string' && provider && model) {
      return { provider, model, source: 'agent-default-model' }
    }
  } catch {
    // Fall through to the loud failure below.
  }
  throw new Error(
    'no polish model configured: set `provider` and `model` in the dsh-voice-polish config, or configure a default agent model',
  )
}

/**
 * Collect one non-streaming model answer through the shared `llm` service.
 * @param ctx - plugin context.
 * @param request - route, system prompt, user message and sampling knobs.
 * @returns the concatenated text output.
 */
async function callModel(ctx, request) {
  const llm = ctx.get('llm')
  if (llm === undefined) throw new Error('llm service is unavailable in this host composition')
  const parts = []
  const stream = llm.stream({
    provider: request.provider,
    model: request.model,
    system: request.system,
    messages: [{ role: 'user', content: [{ type: 'text', text: request.user }] }],
    ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
    ...(request.maxTokens === undefined ? {} : { maxTokens: request.maxTokens }),
    // Some provider routes (opencode-go and friends) refuse a request they cannot
    // attribute to a session, so the caller's Session id rides along when known.
    ...(request.sessionId === undefined || request.sessionId === '' ? {} : { sessionId: request.sessionId }),
    // A hung provider must not pin the panel forever.
    signal: AbortSignal.timeout(120_000),
  })
  for await (const chunk of stream) {
    if (chunk?.type === 'text-delta') {
      parts.push(typeof chunk.text === 'string' ? chunk.text : '')
      continue
    }
    if (chunk?.type === 'finish' && chunk.reason?.kind === 'error') {
      throw new Error(chunk.reason.failure?.message ?? 'model call failed')
    }
    if (chunk?.type === 'finish' && chunk.reason?.kind === 'aborted') {
      throw new Error('model call aborted')
    }
  }
  return parts.join('')
}

/**
 * Transcribe one recording through the Host's speech registry.
 *
 * Keeping this on the Host side means the browser half has zero dependency on
 * any guarded service: it only needs a microphone and HTTP. The bytes arrive as
 * a canonical 16 kHz mono PCM16 WAV stream, which the recogniser validates.
 *
 * @param ctx - plugin context.
 * @param bytes - the complete WAV byte stream.
 * @returns trimmed transcript plus timing facts.
 */
async function transcribeAudio(ctx, bytes) {
  const registry = ctx.get('speechToText')
  if (registry === undefined) {
    throw new Error(
      '语音识别服务不可用 —— 请在「设置 → 插件」里启用官方的「语音输入 Bundle」并完成它的一次性模型下载。本插件不自带模型，直接复用那个识别器。',
    )
  }
  if (bytes.length === 0) throw new Error('empty audio payload')

  // Warm the recogniser while the user's recording was captured.
  try {
    const providerId = registry.snapshot?.()?.selection?.providerId
    // `prepare` may return a promise; never let a rejection escape as an
    // unhandled rejection in the host process.
    if (providerId) void Promise.resolve(registry.prepare(providerId)).catch(() => {})
  } catch {
    // Warming is best effort; transcribe reports the real failure.
  }

  const spec = registry.resolve({ audio: bytes })
  const transcript = await registry.transcribe(spec, AbortSignal.timeout(120_000))
  const text = typeof transcript?.text === 'string' ? transcript.text.trim() : ''
  return {
    text,
    audioSeconds: typeof transcript?.audioSeconds === 'number' ? transcript.audioSeconds : 0,
    inferenceSeconds: typeof transcript?.inferenceSeconds === 'number' ? transcript.inferenceSeconds : 0,
  }
}

/**
 * Recover the structured answer from a model reply that may be fenced, padded, or
 * plain prose. Never throws: a reply that cannot be parsed becomes the polished
 * text itself, which is strictly better than losing the user's turn.
 * @param raw - raw model output.
 * @returns normalized `{ polished, tip, gaps }`.
 */
export function parseAnswer(raw) {
  const text = String(raw ?? '').trim()
  const candidates = []
  const unfenced = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()
  candidates.push(unfenced)
  const first = unfenced.indexOf('{')
  const last = unfenced.lastIndexOf('}')
  if (first >= 0 && last > first) candidates.push(unfenced.slice(first, last + 1))
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate)
      if (parsed && typeof parsed === 'object') {
        const polished = typeof parsed.polished === 'string' ? parsed.polished.trim() : ''
        if (polished.length > 0) {
          const tip = typeof parsed.tip === 'string' ? parsed.tip.trim() : ''
          const gaps = Array.isArray(parsed.gaps)
            ? parsed.gaps.filter((item) => typeof item === 'string' && item.trim().length > 0).map((item) => item.trim()).slice(0, 3)
            : []
          return { polished, tip, gaps }
        }
      }
    } catch {
      // Try the next candidate.
    }
  }
  // Strict parsing failed — almost always because the model left an ASCII
  // quote unescaped inside a string value. Salvage the fields by their key
  // boundaries instead of dumping raw JSON on the user. When even that finds
  // no fields (the model ignored the JSON instruction and answered in plain
  // prose, or answered nothing at all), fall back to treating the whole reply
  // as the polished text — never return undefined here.
  return salvageAnswer(unfenced) ?? { polished: unfenced, tip: '', gaps: [] }
}

/**
 * Structure-aware recovery for model JSON that is *almost* valid: slice each
 * field out between its key boundaries and manually unescape, tolerating stray
 * unescaped quotes inside values.
 * @param text - the unfenced model output.
 * @returns normalized `{ polished, tip, gaps }`, or undefined when even the
 *   `polished` key cannot be located.
 */
function salvageAnswer(text) {
  /** Slice one string value between its key and the next field's key. */
  const sliceValue = (key, endMarker, requireString = true) => {
    const keyAt = text.indexOf(key)
    if (keyAt < 0) return undefined
    let at = keyAt + key.length
    // Skip whitespace and the colon that separates the key from its value.
    while (at < text.length && /[\s:]/.test(text[at])) at += 1
    if (requireString) {
      if (text[at] !== '"') return undefined
      at += 1
    }
    const end = endMarker === undefined ? text.length : text.indexOf(endMarker, at)
    if (end < 0) return undefined
    let out = text.slice(at, end)
    // The slice ends right before the next key: strip the JSON value's own
    // terminating quote, which is not part of the content.
    if (requireString && out.endsWith('"')) out = out.slice(0, -1)
    // Manual unescape; a sentinel keeps escaped backslashes from feeding the
    // later newline/quote passes.
    return out
      .replace(/\\\\/g, '\u0000')
      .replace(/\\n/g, '\n')
      .replace(/\\t/g, '\t')
      .replace(/\\"/g, '"')
      .replace(/\u0000/g, '\\')
  }

  const polished = sliceValue('"polished"', ',"tip"')
  if (polished === undefined || polished.trim().length === 0) return undefined

  const tip = (sliceValue('"tip"', ',"gaps"') ?? '').trim()

  // gaps is an array, not a string: slice it raw and parse the leading [...] only.
  const gapsRaw = sliceValue('"gaps"', undefined, false) ?? ''
  const gapsStart = gapsRaw.indexOf('[')
  const gapsEnd = gapsRaw.indexOf(']')
  const gapsText = gapsStart >= 0 && gapsEnd > gapsStart ? gapsRaw.slice(gapsStart, gapsEnd + 1) : '[]'
  let gaps = []
  try {
    const parsed = JSON.parse(gapsText)
    if (Array.isArray(parsed)) {
      gaps = parsed.filter((item) => typeof item === 'string' && item.trim().length > 0).map((item) => item.trim()).slice(0, 3)
    }
  } catch {
    gaps = []
  }

  return { polished: polished.trim(), tip, gaps }
}

/**
 * Mount the host half.
 * @param ctx - plugin context with `webServer` injected.
 * @param config - plugin config (provider / model / temperature / maxTokens).
 * @returns disposer releasing the route.
 */
export function apply(ctx, config = {}) {
  const temperature = typeof config.temperature === 'number' ? config.temperature : 0.2
  const maxTokens = typeof config.maxTokens === 'number' ? config.maxTokens : 2400

  const handler = (req, res) => {
    const url = new URL(req.url ?? '/', 'http://dsh.internal')
    const pathname = url.pathname

    if (pathname === `${ROUTE_PREFIX}/config`) {
      if (req.method === 'POST') {
        readBody(req, MAX_BODY_BYTES)
          .then((raw) => {
            let payload
            try {
              payload = JSON.parse(raw)
            } catch {
              writeJson(res, 400, { ok: false, error: { message: 'invalid JSON body' } })
              return
            }
            try {
              if (payload?.clear === true) {
                clearOverride()
              } else if (typeof payload?.provider === 'string' && typeof payload?.model === 'string' && payload.provider && payload.model) {
                writeOverride({ provider: payload.provider, model: payload.model })
              } else {
                writeJson(res, 400, { ok: false, error: { message: 'expected {provider, model} or {clear: true}' } })
                return
              }
              writeJson(res, 200, { ok: true, value: { override: readOverride() ?? null } })
            } catch (error) {
              writeJson(res, 500, { ok: false, error: { message: String(error?.message ?? error) } })
            }
          })
          .catch((error) => {
            writeJson(res, 413, { ok: false, error: { message: String(error?.message ?? error) } })
          })
        return
      }
      let route
      try {
        route = resolveRoute(ctx, config)
      } catch (error) {
        writeJson(res, 200, { ok: true, value: { ready: false, message: String(error?.message ?? error), override: readOverride() ?? null, rev }})
        return
      }
      writeJson(res, 200, { ok: true, value: { ready: true, provider: route.provider, model: route.model, source: route.source, override: readOverride() ?? null, rev }})
      return
    }

    if (pathname === `${ROUTE_PREFIX}/models`) {
      listModelCatalog(ctx)
        .then((value) => writeJson(res, 200, { ok: true, value }))
        .catch((error) => writeJson(res, 502, { ok: false, error: { message: String(error?.message ?? error) } }))
      return
    }

    if (pathname === `${ROUTE_PREFIX}/transcribe`) {
      if (req.method !== 'POST') {
        writeJson(res, 405, { ok: false, error: { message: 'method not allowed' } })
        return
      }
      // The audio arrives as the raw WAV byte stream — base64 would inflate an
      // already-large payload by a third for no reason.
      readBody(req, MAX_BODY_BYTES, true)
        .then(async (audio) => {
          if (audio.length === 0) {
            writeJson(res, 400, { ok: false, error: { message: 'audio payload is empty' } })
            return
          }
          try {
            const value = await transcribeAudio(ctx, audio)
            writeJson(res, 200, { ok: true, value })
          } catch (error) {
            ctx.logger?.warn?.(`[dsh-voice-polish] transcribe failed: ${error?.message ?? error}`)
            writeJson(res, 502, { ok: false, error: { message: String(error?.message ?? error) } })
          }
        })
        .catch((error) => {
          writeJson(res, 413, { ok: false, error: { message: String(error?.message ?? error) } })
        })
      return
    }

    if (pathname === `${ROUTE_PREFIX}/vocab`) {
      if (req.method === 'GET') {
        writeJson(res, 200, { ok: true, value: { text: readVocab() } })
        return
      }
      if (req.method !== 'POST') {
        writeJson(res, 405, { ok: false, error: { message: 'method not allowed' } })
        return
      }
      readBody(req, MAX_BODY_BYTES)
        .then((raw) => {
          let payload
          try {
            payload = JSON.parse(raw)
          } catch {
            writeJson(res, 400, { ok: false, error: { message: 'invalid JSON body' } })
            return
          }
          try {
            const saved = writeVocab(typeof payload?.text === 'string' ? payload.text : '')
            writeJson(res, 200, { ok: true, value: saved })
          } catch (error) {
            writeJson(res, 500, { ok: false, error: { message: String(error?.message ?? error) } })
          }
        })
        .catch((error) => {
          writeJson(res, 413, { ok: false, error: { message: String(error?.message ?? error) } })
        })
      return
    }

    if (pathname !== `${ROUTE_PREFIX}/polish`) {
      writeJson(res, 404, { ok: false, error: { message: 'not found' } })
      return
    }
    if (req.method !== 'POST') {
      writeJson(res, 405, { ok: false, error: { message: 'method not allowed' } })
      return
    }

    readBody(req, MAX_BODY_BYTES)
      .then(async (raw) => {
        let payload
        try {
          payload = JSON.parse(raw)
        } catch {
          writeJson(res, 400, { ok: false, error: { message: 'invalid JSON body' } })
          return
        }

        const text = typeof payload?.text === 'string' ? payload.text.trim() : ''
        if (text.length === 0) {
          writeJson(res, 400, { ok: false, error: { message: 'text is required' } })
          return
        }
        if (text.length > MAX_INPUT_CHARS) {
          writeJson(res, 413, { ok: false, error: { message: `text exceeds ${MAX_INPUT_CHARS} characters` } })
          return
        }

        const style = typeof payload?.style === 'string' && STYLE_GUIDE[payload.style] ? payload.style : DEFAULT_STYLE
        const sessionId = typeof payload?.sessionId === 'string' ? payload.sessionId : ''
        const extra = typeof payload?.instruction === 'string' && payload.instruction.trim().length > 0
          ? `\n\n【本次额外要求】${payload.instruction.trim().slice(0, 400)}`
          : ''

        try {
          const route = resolveRoute(ctx, config)
          const user = `【风格要求】${STYLE_GUIDE[style]}\n\n【原始口语转写】\n${text}${extra}`
          // The word list is read per request: an edit applies from the very
          // next polish, no restart.
          const answer = await callModel(ctx, {
            provider: route.provider,
            model: route.model,
            system: SYSTEM_PROMPT + vocabPromptBlock(readVocab()),
            user,
            sessionId,
            temperature,
            maxTokens,
          })
          const value = parseAnswer(answer)
          value.style = style
          value.model = `${route.provider}/${route.model}`
          writeJson(res, 200, { ok: true, value })
        } catch (error) {
          ctx.logger?.warn?.(`[dsh-voice-polish] polish failed: ${error?.message ?? error}`)
          writeJson(res, 502, { ok: false, error: { message: String(error?.message ?? error) } })
        }
      })
      .catch((error) => {
        writeJson(res, 413, { ok: false, error: { message: String(error?.message ?? error) } })
      })
  }

  try {
    const disposePolish = ctx.webServer.register({ kind: 'exact', path: `${ROUTE_PREFIX}/polish`, handler })
    const disposeTranscribe = ctx.webServer.register({ kind: 'exact', path: `${ROUTE_PREFIX}/transcribe`, handler })
    const disposeVocab = ctx.webServer.register({ kind: 'exact', path: `${ROUTE_PREFIX}/vocab`, handler })
    const disposeModels = ctx.webServer.register({ kind: 'exact', path: `${ROUTE_PREFIX}/models`, handler })
    const disposeConfig = ctx.webServer.register({ kind: 'exact', path: `${ROUTE_PREFIX}/config`, handler })
    return () => {
      disposePolish()
      disposeTranscribe()
      disposeVocab()
      disposeModels()
      disposeConfig()
    }
  } catch (error) {
    // A host plugin that throws on apply takes its whole layer down; degrade.
    ctx.logger?.error?.(`[dsh-voice-polish] route registration failed: ${error?.message ?? error}`)
    return () => {}
  }
}
