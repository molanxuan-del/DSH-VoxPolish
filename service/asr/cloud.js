/**
 * dsh-voice-polish service — cloud ASR provider (OpenAI-compatible).
 *
 * `POST {VP_ASR_BASE_URL}/audio/transcriptions` with a hand-rolled
 * `multipart/form-data` body. Zero dependencies: no `form-data`, no SDK — the
 * body is assembled as a Buffer so binary audio crosses the wire untouched.
 *
 * ⚠️ DeepSeek itself has no `/audio/transcriptions` endpoint (it serves text
 * models only), so this provider is deliberately independent of the LLM
 * configuration and points at OpenAI by default:
 *
 *   VP_ASR_BASE_URL   default https://api.openai.com/v1
 *   VP_ASR_API_KEY    required — no silent fallback to VP_LLM_API_KEY
 *   VP_ASR_MODEL      default whisper-1
 *
 * Point those at OpenAI / SiliconFlow / Groq / a local whisper server — anything
 * that speaks the OpenAI-compatible transcription API.
 *
 * @module dsh-voice-polish/service/asr/cloud
 */

import { randomBytes } from 'node:crypto'

import { AsrConfigError } from './errors.js'

/** Canonical OpenAI-compatible root. Override with VP_ASR_BASE_URL. */
export const DEFAULT_ASR_BASE_URL = 'https://api.openai.com/v1'

/** Default transcription model. */
export const DEFAULT_ASR_MODEL = 'whisper-1'

/** Per-request timeout. A long recording can legitimately take a while. */
export const DEFAULT_ASR_TIMEOUT_MS = 120_000

/** Strip a trailing slash so the joined URL never doubles up. */
function stripTrailingSlashes(value, fallback) {
  const raw = String(value ?? '').trim()
  if (raw.length === 0) return fallback
  return raw.replace(/\/+$/, '')
}

/**
 * The transcription endpoint for one base URL.
 * @param {string} baseUrl - OpenAI-compatible root.
 * @returns {string} absolute URL.
 */
export function transcriptionsUrl(baseUrl) {
  return `${stripTrailingSlashes(baseUrl, DEFAULT_ASR_BASE_URL)}/audio/transcriptions`
}

/**
 * Resolve the cloud ASR configuration. These variables are **independent of the
 * LLM ones on purpose**: the ASR endpoint usually belongs to a different
 * provider, so reusing `VP_LLM_API_KEY` would quietly send the wrong credential
 * to the wrong host.
 * @param {object} [options]
 * @param {Record<string, string|undefined>} [options.env] - environment.
 * @param {string} [options.baseUrl] - explicit override.
 * @param {string} [options.apiKey] - explicit override.
 * @param {string} [options.model] - explicit override.
 * @returns {{ baseUrl: string, apiKey: string, model: string, sources: object }}
 * @throws {AsrConfigError} when VP_ASR_API_KEY is missing — a clear error, never a silent failure.
 */
export function resolveCloudAsrConfig({ env = process.env, baseUrl, apiKey, model } = {}) {
  const cliBase = String(baseUrl ?? '').trim()
  const cliKey = String(apiKey ?? '').trim()
  const cliModel = String(model ?? '').trim()
  const envBase = String(env.VP_ASR_BASE_URL ?? '').trim()
  const envKey = String(env.VP_ASR_API_KEY ?? '').trim()
  const envModel = String(env.VP_ASR_MODEL ?? '').trim()

  const resolvedKey = cliKey !== '' ? cliKey : envKey
  if (resolvedKey.length === 0) {
    throw new AsrConfigError(
      'VP_ASR_API_KEY 未设置：云端 ASR 需要独立的语音识别密钥（不会回退到 VP_LLM_API_KEY —— ' +
        'DeepSeek 没有 /audio/transcriptions 端点，两者通常是不同厂商）。' +
        '请设置 VP_ASR_API_KEY，并用 VP_ASR_BASE_URL 指向支持 OpenAI 兼容转录接口的服务' +
        '（OpenAI / SiliconFlow / Groq / 本地 whisper server 等），模型用 VP_ASR_MODEL 指定。',
      { provider: 'cloud', phase: 'P3', missing: ['VP_ASR_API_KEY'] },
    )
  }

  const resolvedBase = cliBase !== '' ? cliBase : envBase
  const resolvedModel = cliModel !== '' ? cliModel : envModel

  return {
    baseUrl: stripTrailingSlashes(resolvedBase, DEFAULT_ASR_BASE_URL),
    apiKey: resolvedKey,
    model: resolvedModel !== '' ? resolvedModel : DEFAULT_ASR_MODEL,
    sources: {
      baseUrl: cliBase !== '' ? 'cli' : envBase !== '' ? 'env' : 'default',
      model: cliModel !== '' ? 'cli' : envModel !== '' ? 'env' : 'default',
      apiKey: cliKey !== '' ? 'cli' : 'env',
    },
  }
}

/**
 * Non-throwing view of the cloud ASR configuration, for `--asr-check`.
 * Never returns the key itself.
 * @param {object} [options] - same shape as resolveCloudAsrConfig.
 * @returns {{ baseUrl: string, model: string, endpoint: string, keyConfigured: boolean }}
 */
export function cloudAsrStatus({ env = process.env, baseUrl, apiKey, model } = {}) {
  const cliBase = String(baseUrl ?? '').trim()
  const envBase = String(env.VP_ASR_BASE_URL ?? '').trim()
  const cliModel = String(model ?? '').trim()
  const envModel = String(env.VP_ASR_MODEL ?? '').trim()
  const resolvedBase = stripTrailingSlashes(cliBase !== '' ? cliBase : envBase, DEFAULT_ASR_BASE_URL)
  return {
    baseUrl: resolvedBase,
    endpoint: transcriptionsUrl(resolvedBase),
    model: cliModel !== '' ? cliModel : envModel !== '' ? envModel : DEFAULT_ASR_MODEL,
    keyConfigured: String(apiKey ?? '').trim() !== '' || String(env.VP_ASR_API_KEY ?? '').trim() !== '',
  }
}

/** Header-safe file name: no quotes, no control characters, no path separators. */
function safeFilename(filename) {
  const raw = String(filename ?? '').trim() || 'audio.wav'
  const base = raw.split(/[\\/]/).pop() ?? 'audio.wav'
  // eslint-disable-next-line no-control-regex
  const cleaned = base.replace(/[\u0000-\u001f\u007f"]/g, '_')
  return cleaned.length > 0 ? cleaned : 'audio.wav'
}

/** A fresh multipart boundary. */
export function makeBoundary() {
  return `----dshVoicePolish${randomBytes(16).toString('hex')}`
}

/**
 * Assemble a `multipart/form-data` body by hand.
 * @param {object} options
 * @param {Buffer|Uint8Array} options.audio - the audio bytes (never re-encoded).
 * @param {string} [options.model] - the `model` form field.
 * @param {string} [options.filename] - file name sent in the part headers.
 * @param {string} [options.mimeType] - part content type.
 * @param {Record<string, string>} [options.fields] - extra text fields (language, prompt…).
 * @param {string} [options.boundary] - fixed boundary (tests).
 * @returns {{ body: Buffer, boundary: string, contentType: string }} the encoded body.
 */
export function buildMultipartBody({ audio, model, filename, mimeType = 'audio/wav', fields = {}, boundary = makeBoundary() }) {
  const parts = []
  const push = (chunk) => parts.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8'))
  const crlf = '\r\n'

  push(`--${boundary}${crlf}`)
  push(`Content-Disposition: form-data; name="file"; filename="${safeFilename(filename)}"${crlf}`)
  push(`Content-Type: ${mimeType}${crlf}${crlf}`)
  push(Buffer.from(audio ?? Buffer.alloc(0)))
  push(crlf)

  for (const [name, value] of Object.entries(fields)) {
    if (value === undefined || value === null || String(value).length === 0) continue
    push(`--${boundary}${crlf}`)
    push(`Content-Disposition: form-data; name="${name}"${crlf}${crlf}`)
    push(String(value))
    push(crlf)
  }

  if (model !== undefined && String(model).length > 0) {
    push(`--${boundary}${crlf}`)
    push(`Content-Disposition: form-data; name="model"${crlf}${crlf}`)
    push(String(model))
    push(crlf)
  }

  push(`--${boundary}--${crlf}`)
  return { body: Buffer.concat(parts), boundary, contentType: `multipart/form-data; boundary=${boundary}` }
}

/**
 * Parse a transcription response. Accepts the OpenAI JSON shape (`{text}`) and,
 * as a fallback, a server that answers with the raw transcript.
 * @param {string} raw - response body.
 * @returns {{ text: string, language?: string, durationSeconds?: number }}
 * @throws {Error} when there is no usable transcript in it.
 */
export function parseTranscription(raw) {
  const trimmed = String(raw ?? '').trim()
  if (trimmed.length === 0) throw new Error('云端 ASR 返回了空响应')
  let data
  try {
    data = JSON.parse(trimmed)
  } catch {
    // Some whisper servers answer with the plain transcript instead of JSON.
    return { text: trimmed }
  }
  const text = typeof data?.text === 'string' ? data.text.trim() : ''
  if (text.length === 0) throw new Error('云端 ASR 响应里没有可用的 text 字段')
  return {
    text,
    ...(typeof data.language === 'string' && data.language.length > 0 ? { language: data.language } : {}),
    ...(typeof data.duration === 'number' ? { durationSeconds: data.duration } : {}),
  }
}

/** Shorten a server response for an error message. */
function excerpt(text, max = 300) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

/**
 * Transcribe audio through an OpenAI-compatible `/audio/transcriptions`.
 * @param {object} options
 * @param {{ baseUrl: string, apiKey: string, model: string }} options.config - resolved config.
 * @param {Buffer|Uint8Array} options.audio - the audio bytes.
 * @param {string} [options.filename] - file name for the part header.
 * @param {string} [options.mimeType] - part content type.
 * @param {string} [options.language] - optional ISO language hint.
 * @param {typeof fetch} [options.fetchImpl] - injectable transport (tests).
 * @param {AbortSignal} [options.signal] - caller signal.
 * @param {number} [options.timeoutMs] - per-request timeout.
 * @returns {Promise<{ text: string, provider: 'cloud', model: string, language?: string, durationSeconds?: number }>}
 */
export async function transcribeCloud({
  config,
  audio,
  filename,
  mimeType,
  language,
  fetchImpl = globalThis.fetch,
  signal,
  timeoutMs = DEFAULT_ASR_TIMEOUT_MS,
} = {}) {
  if (typeof fetchImpl !== 'function') {
    throw new Error('this runtime has no global fetch — Node.js >= 20 is required')
  }
  if (!audio || audio.length === 0) throw new Error('音频数据为空，无法转写')

  const { body, contentType } = buildMultipartBody({
    audio,
    filename,
    mimeType,
    model: config.model,
    fields: language === undefined ? {} : { language },
  })

  const response = await fetchImpl(transcriptionsUrl(config.baseUrl), {
    method: 'POST',
    headers: {
      // Set explicitly: fetch must not guess the boundary for us.
      'content-type': contentType,
      accept: 'application/json',
      authorization: `Bearer ${config.apiKey}`,
    },
    body,
    signal: signal ?? AbortSignal.timeout(timeoutMs),
  })

  const raw = await response.text()
  if (response.ok !== true) {
    throw new Error(`云端 ASR 请求失败：HTTP ${response.status} ${excerpt(raw)}`)
  }
  const parsed = parseTranscription(raw)
  return { text: parsed.text, provider: 'cloud', model: config.model, ...(parsed.language ? { language: parsed.language } : {}), ...(parsed.durationSeconds === undefined ? {} : { durationSeconds: parsed.durationSeconds }) }
}
