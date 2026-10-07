/**
 * dsh-voice-polish service — OpenAI-compatible chat client and polish pipeline.
 *
 * This is the *only* place the standalone service builds a model request. The
 * prompt text itself comes from `../lib/core.js`, the same module the DSH plugin
 * imports, so a polish produced here is the polish the plugin would have produced
 * (same system prompt, same style guide, same vocabulary block, same salvage
 * parser).
 *
 * Zero dependencies: `fetch` is global (Node >= 20).
 *
 * @module dsh-voice-polish/service/llm
 */

import { readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { DEFAULT_STYLE, STYLE_GUIDE, SYSTEM_PROMPT, parseAnswer, vocabPromptBlock } from '../lib/core.js'

/** OpenAI-compatible root. Override with VP_LLM_BASE_URL or --base-url. */
export const DEFAULT_LLM_BASE_URL = 'https://api.deepseek.com'

/** Default model. `deepseek-flash` is the fast route the plugin pairs with. */
export const DEFAULT_LLM_MODEL = 'deepseek-flash'

/** Same sampling knobs the plugin defaults to, so results stay comparable. */
export const DEFAULT_TEMPERATURE = 0.2
export const DEFAULT_MAX_TOKENS = 2400
export const DEFAULT_TIMEOUT_MS = 120_000

/** Largest accepted transcript, in UTF-16 code units (same cap as the plugin). */
export const MAX_INPUT_CHARS = 24_000

/** Extra per-request instruction cap (same as the plugin). */
const INSTRUCTION_MAX_CHARS = 400

/**
 * Strip a trailing slash so `${base}/chat/completions` never doubles up.
 * @param {string} [value] - raw base URL.
 * @returns {string} the normalised base URL, or the default when empty.
 */
export function normalizeBaseUrl(value) {
  const raw = String(value ?? '').trim()
  if (raw.length === 0) return DEFAULT_LLM_BASE_URL
  return raw.replace(/\/+$/, '')
}

/**
 * Where the user's word list lives — the exact location and format the DSH
 * plugin uses, so both halves share one vocabulary.
 * @param {Record<string, string|undefined>} [env] - environment.
 * @returns {string} absolute path to vocab.txt.
 */
export function vocabFilePath(env = process.env) {
  const home = env.DSH_HOME || path.join(os.homedir(), '.dsh')
  return path.join(home, 'voice-polish', 'vocab.txt')
}

/**
 * Read the shared word list. A missing file is an empty list, not an error.
 * @param {Record<string, string|undefined>} [env] - environment.
 * @returns {string} raw file text ('' when absent or unreadable).
 */
export function readVocab(env = process.env) {
  try {
    return readFileSync(vocabFilePath(env), 'utf8')
  } catch {
    return ''
  }
}

/**
 * Resolve base URL / key / model from CLI flags first, environment second.
 * @param {object} [options]
 * @param {Record<string, string|undefined>} [options.env] - environment.
 * @param {string} [options.baseUrl] - CLI override.
 * @param {string} [options.apiKey] - CLI override.
 * @param {string} [options.model] - CLI override.
 * @returns {{ baseUrl: string, apiKey: string, model: string, sources: object }}
 * @throws {Error} when no API key is configured — a missing key must never fail silently.
 */
export function resolveLlmConfig({ env = process.env, baseUrl, apiKey, model } = {}) {
  const envBase = String(env.VP_LLM_BASE_URL ?? '').trim()
  const envKey = String(env.VP_LLM_API_KEY ?? '').trim()
  const envModel = String(env.VP_LLM_MODEL ?? '').trim()

  const cliBase = String(baseUrl ?? '').trim()
  const cliKey = String(apiKey ?? '').trim()
  const cliModel = String(model ?? '').trim()

  const resolvedBase = cliBase !== '' ? cliBase : envBase
  const resolvedKey = cliKey !== '' ? cliKey : envKey
  const resolvedModel = cliModel !== '' ? cliModel : envModel

  if (resolvedKey.trim().length === 0) {
    throw new Error(
      'VP_LLM_API_KEY 未设置：请先设置环境变量 VP_LLM_API_KEY（或用 --api-key 传入）。' +
        '服务不会在缺少密钥时静默失败，也不会把密钥写进任何文件。',
    )
  }

  return {
    baseUrl: normalizeBaseUrl(resolvedBase),
    apiKey: resolvedKey.trim(),
    model: resolvedModel.trim() || DEFAULT_LLM_MODEL,
    sources: {
      baseUrl: cliBase !== '' ? 'cli' : envBase !== '' ? 'env' : 'default',
      model: cliModel !== '' ? 'cli' : envModel !== '' ? 'env' : 'default',
      apiKey: cliKey !== '' ? 'cli' : 'env',
    },
  }
}

/**
 * Non-throwing view of the LLM configuration, for `/health` and `--selftest`.
 * Never returns the key itself.
 * @param {object} [options] - same shape as resolveLlmConfig.
 * @returns {{ baseUrl: string, model: string, keyConfigured: boolean }}
 */
export function llmConfigStatus({ env = process.env, baseUrl, apiKey, model } = {}) {
  const cliBase = String(baseUrl ?? '').trim()
  const cliModel = String(model ?? '').trim()
  return {
    baseUrl: normalizeBaseUrl(cliBase !== '' ? cliBase : env.VP_LLM_BASE_URL),
    model: cliModel !== '' ? cliModel : String(env.VP_LLM_MODEL ?? '').trim() || DEFAULT_LLM_MODEL,
    keyConfigured: String(apiKey ?? '').trim() !== '' || String(env.VP_LLM_API_KEY ?? '').trim() !== '',
  }
}

/**
 * The chat-completions URL for one base URL.
 * @param {string} baseUrl - OpenAI-compatible root.
 * @returns {string} absolute URL.
 */
export function chatCompletionsUrl(baseUrl) {
  return `${normalizeBaseUrl(baseUrl)}/chat/completions`
}

/**
 * Keep a known style, fall back to the plugin's default for anything else —
 * exactly what the plugin route does with an unknown `style`.
 * @param {unknown} style - requested style.
 * @returns {string} a key of STYLE_GUIDE.
 */
export function normalizeStyle(style) {
  return typeof style === 'string' && Object.hasOwn(STYLE_GUIDE, style) ? style : DEFAULT_STYLE
}

/**
 * Build the system prompt: stable instruction block plus the vocabulary block.
 * Byte-identical to what the plugin sends.
 * @param {string} [vocabText] - raw word-list text.
 * @returns {string} the system message.
 */
export function buildSystemPrompt(vocabText = '') {
  return SYSTEM_PROMPT + vocabPromptBlock(vocabText)
}

/**
 * Build the user message. Byte-identical to what the plugin sends, including the
 * `【风格要求】` / `【原始口语转写】` / `【本次额外要求】` markers. `text` is used
 * as given — the caller trims it, as the plugin does.
 * @param {string} text - spoken transcript.
 * @param {{ style?: string, instruction?: string }} [options] - style + extra ask.
 * @returns {string} the user message.
 */
export function buildUserMessage(text, { style, instruction } = {}) {
  const chosen = normalizeStyle(style)
  const extra =
    typeof instruction === 'string' && instruction.trim().length > 0
      ? `\n\n【本次额外要求】${instruction.trim().slice(0, INSTRUCTION_MAX_CHARS)}`
      : ''
  return `【风格要求】${STYLE_GUIDE[chosen]}\n\n【原始口语转写】\n${text}${extra}`
}

/** Shorten a server response for an error message. */
function excerpt(text, max = 300) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

/**
 * One non-streaming chat completion, OpenAI-compatible.
 * @param {object} options
 * @param {{ baseUrl: string, apiKey: string, model: string }} options.config - resolved config.
 * @param {string} options.system - system message.
 * @param {string} options.user - user message.
 * @param {number} [options.temperature] - sampling temperature.
 * @param {number} [options.maxTokens] - output cap.
 * @param {typeof fetch} [options.fetchImpl] - injectable transport (tests).
 * @param {AbortSignal} [options.signal] - caller signal.
 * @param {number} [options.timeoutMs] - per-request timeout.
 * @returns {Promise<string>} the model's text answer.
 */
export async function callChat({
  config,
  system,
  user,
  temperature = DEFAULT_TEMPERATURE,
  maxTokens = DEFAULT_MAX_TOKENS,
  fetchImpl = globalThis.fetch,
  signal,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
  if (typeof fetchImpl !== 'function') {
    throw new Error('this runtime has no global fetch — Node.js >= 20 is required')
  }
  const body = {
    model: config.model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    stream: false,
    temperature,
    max_tokens: maxTokens,
  }
  const response = await fetchImpl(chatCompletionsUrl(config.baseUrl), {
    method: 'POST',
    headers: {
      // Explicit charset: the prompts are Chinese and must not be guessed at.
      'content-type': 'application/json; charset=utf-8',
      accept: 'application/json',
      authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify(body),
    signal: signal ?? AbortSignal.timeout(timeoutMs),
  })

  const raw = await response.text()
  if (response.ok !== true) {
    throw new Error(`LLM 请求失败：HTTP ${response.status} ${excerpt(raw)}`)
  }
  let data
  try {
    data = JSON.parse(raw)
  } catch {
    throw new Error(`LLM 返回的不是合法 JSON：${excerpt(raw)}`)
  }
  const choice = data?.choices?.[0]
  const content = choice?.message?.content
  if (typeof content === 'string' && content.trim().length > 0) return content
  if (typeof choice?.text === 'string' && choice.text.trim().length > 0) return choice.text
  throw new Error(`LLM 返回里没有文本内容：${excerpt(raw)}`)
}

/**
 * Transcript → `{ polished, tip, gaps }` through an OpenAI-compatible endpoint.
 * Uses the shared core parser, so malformed JSON is salvaged the same way the
 * plugin salvages it.
 * @param {object} options
 * @param {{ baseUrl: string, apiKey: string, model: string }} options.config - resolved config.
 * @param {string} options.text - already-trimmed transcript.
 * @param {string} [options.style] - style preset key.
 * @param {string} [options.instruction] - extra per-request ask.
 * @param {string} [options.vocabText] - raw word-list text.
 * @param {Function} [options.fetchImpl] - injectable transport (tests).
 * @param {AbortSignal} [options.signal] - caller signal.
 * @returns {Promise<{ value: { polished: string, tip: string, gaps: string[] }, raw: string }>}
 */
export async function polish({
  config,
  text,
  style,
  instruction,
  vocabText = '',
  temperature,
  maxTokens,
  fetchImpl,
  signal,
  timeoutMs,
}) {
  const chosen = normalizeStyle(style)
  const answer = await callChat({
    config,
    system: buildSystemPrompt(vocabText),
    user: buildUserMessage(text, { style: chosen, instruction }),
    temperature,
    maxTokens,
    fetchImpl,
    signal,
    timeoutMs,
  })
  const value = parseAnswer(answer)
  // Same extra fields the plugin attaches, so callers can tell what happened.
  value.style = chosen
  value.model = config.model
  return { value, raw: answer }
}
