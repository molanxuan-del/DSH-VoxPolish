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

// The prompts, the style presets and the model-output parser now live in a pure,
// DSH-free module so the standalone service (`service/`) shares the exact same
// behaviour. They were moved verbatim; this half's contract is unchanged.
import { DEFAULT_STYLE, STYLE_GUIDE, SYSTEM_PROMPT, normalizeVocab, parseAnswer, vocabPromptBlock } from './core.js'

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
 * The model-output parser is re-exported from `./core.js` so this half's public
 * surface (`name` / `inject` / `apply` / `parseAnswer`) is unchanged.
 */
export { parseAnswer }

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
