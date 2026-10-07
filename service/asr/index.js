/**
 * dsh-voice-polish service — ASR provider resolution, capability checks and dispatch.
 *
 *   local  SenseVoice + sherpa-onnx. The model files already exist on this machine
 *          (they ship with DSH's official voice-input bundle), so the check below
 *          really stats them — but the inference engine is P2, and
 *          `transcribeAudio` says so instead of pretending.
 *   cloud  OpenAI-compatible `/audio/transcriptions`, implemented in `./cloud.js`.
 *          Independent configuration (VP_ASR_*), hand-rolled multipart, zero deps.
 *
 * Nothing here imports DSH or a third-party package.
 *
 * @module dsh-voice-polish/service/asr
 */

import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { cloudAsrStatus, resolveCloudAsrConfig, transcribeCloud } from './cloud.js'
import { AsrUnavailableError } from './errors.js'

export { AsrConfigError, AsrError, AsrUnavailableError } from './errors.js'
export {
  DEFAULT_ASR_BASE_URL,
  DEFAULT_ASR_MODEL,
  buildMultipartBody,
  cloudAsrStatus,
  parseTranscription,
  resolveCloudAsrConfig,
  transcribeCloud,
  transcriptionsUrl,
} from './cloud.js'

/** Providers the CLI / HTTP surface accepts. */
export const ASR_PROVIDERS = ['local', 'cloud']

/** Default provider when neither --asr nor VP_ASR says otherwise. */
export const DEFAULT_ASR_PROVIDER = 'local'

/** The engine P2 will add. Named here so the capability report is concrete. */
export const LOCAL_ENGINE = 'sherpa-onnx-node'

/** Local inference is still P2. */
export const LOCAL_IMPLEMENTED = false

/** The cloud transcription path is wired. */
export const CLOUD_IMPLEMENTED = true

/**
 * Resolve the ASR provider from an explicit value, then VP_ASR, then the default.
 * @param {unknown} [value] - explicit provider (CLI `--asr`).
 * @param {Record<string, string|undefined>} [env] - environment.
 * @returns {'local'|'cloud'} the resolved provider.
 * @throws {Error} on an unknown provider — never guess.
 */
export function resolveAsrProvider(value, env = process.env) {
  const explicit = String(value ?? '').trim()
  const fromEnv = String(env.VP_ASR ?? '').trim()
  const raw = (explicit !== '' ? explicit : fromEnv !== '' ? fromEnv : DEFAULT_ASR_PROVIDER).toLowerCase()
  if (!ASR_PROVIDERS.includes(raw)) {
    throw new Error(`未知的 ASR 提供者「${raw}」：只支持 ${ASR_PROVIDERS.join(' | ')}（用 --asr 或 VP_ASR 指定）`)
  }
  return raw
}

/**
 * Where the local SenseVoice assets live. These are the files DSH's official
 * voice-input bundle downloads; the service only ever reads them.
 * @param {Record<string, string|undefined>} [env] - environment.
 * @returns {{ home: string, modelsRoot: string, modelDir: string, model: string, tokens: string, vad: string, vadDir: string }}
 */
export function sensevoicePaths(env = process.env) {
  const home = env.DSH_HOME || path.join(os.homedir(), '.dsh')
  const modelsRoot = path.join(home, 'speech-to-text', 'sensevoice', 'models')
  const modelDir = path.join(modelsRoot, 'sensevoice-onnx')
  const vadDir = path.join(modelsRoot, 'silero')
  return {
    home,
    modelsRoot,
    modelDir,
    model: path.join(modelDir, 'model.int8.onnx'),
    tokens: path.join(modelDir, 'tokens.txt'),
    vadDir,
    vad: path.join(vadDir, 'silero_vad.onnx'),
  }
}

/**
 * Offline capability report for the local provider. Stats the three files; never
 * loads a model and never touches the network.
 * @param {object} [options]
 * @param {Record<string, string|undefined>} [options.env] - environment.
 * @param {(p: string) => boolean} [options.exists] - injectable existence check (tests).
 * @returns {object} a structured report.
 */
export function checkLocalAsr({ env = process.env, exists = existsSync } = {}) {
  const paths = sensevoicePaths(env)
  const checks = [
    { name: 'sensevoice-onnx/model.int8.onnx', path: paths.model, ok: exists(paths.model) },
    { name: 'sensevoice-onnx/tokens.txt', path: paths.tokens, ok: exists(paths.tokens) },
    { name: 'silero/silero_vad.onnx', path: paths.vad, ok: exists(paths.vad) },
  ]
  const configured = checks.every((check) => check.ok)
  return {
    provider: 'local',
    engine: LOCAL_ENGINE,
    implemented: LOCAL_IMPLEMENTED,
    configured,
    ready: configured && LOCAL_IMPLEMENTED,
    modelDir: paths.modelDir,
    checks,
    phase: 'P2',
    message: configured
      ? '模型文件齐备，但本地推理尚未接入（P2：sherpa-onnx-node）。当前无法在本地转写；如需现在就能用，请设 VP_ASR=cloud。'
      : '未找到完整的 SenseVoice 模型文件；本地推理也尚未接入（P2）。请先在 DSH 的官方「语音输入 Bundle」里完成模型下载，或改用 VP_ASR=cloud。',
  }
}

/**
 * Offline capability report for the cloud provider. Checks configuration only —
 * it never issues a request, so it costs nothing and works without network.
 * @param {object} [options]
 * @param {Record<string, string|undefined>} [options.env] - environment.
 * @returns {object} a structured report.
 */
export function checkCloudAsr({ env = process.env } = {}) {
  const status = cloudAsrStatus({ env })
  const checks = [
    {
      name: 'VP_ASR_API_KEY',
      path: '(环境变量)',
      ok: status.keyConfigured,
      detail: status.keyConfigured ? '已设置（不显示内容）' : '未设置（不会回退到 VP_LLM_API_KEY）',
    },
    { name: 'VP_ASR_BASE_URL', path: '(环境变量)', ok: true, detail: status.baseUrl },
    { name: 'VP_ASR_MODEL', path: '(环境变量)', ok: true, detail: status.model },
  ]
  return {
    provider: 'cloud',
    endpoint: status.endpoint,
    baseUrl: status.baseUrl,
    model: status.model,
    implemented: CLOUD_IMPLEMENTED,
    configured: status.keyConfigured,
    ready: status.keyConfigured && CLOUD_IMPLEMENTED,
    checks,
    phase: 'P3',
    message: status.keyConfigured
      ? `云端配置齐备：${status.endpoint}（模型 ${status.model}）。本检查不发起真实请求。`
      : '缺少 VP_ASR_API_KEY：云端转录已接入，但未配置。DeepSeek 没有 /audio/transcriptions 端点，' +
        '请用 VP_ASR_BASE_URL 指向支持该接口的兼容服务（OpenAI / SiliconFlow / Groq / 本地 whisper server 等）。',
  }
}

/**
 * Dispatch to the provider's capability report.
 * @param {'local'|'cloud'} provider - resolved provider.
 * @param {object} [options] - forwarded to the provider check.
 * @returns {object} a structured report.
 */
export function checkAsr(provider, options = {}) {
  const resolved = resolveAsrProvider(provider, options.env ?? process.env)
  return resolved === 'cloud' ? checkCloudAsr(options) : checkLocalAsr(options)
}

/**
 * Transcribe audio.
 *
 * `cloud` goes to the OpenAI-compatible transcription endpoint. `local` is still
 * P2 and throws with the exact phase that owns it, rather than returning an empty
 * transcript and letting the caller believe it worked.
 *
 * @param {object} options
 * @param {'local'|'cloud'} [options.provider] - provider (defaults to VP_ASR).
 * @param {Buffer|Uint8Array} options.audio - the audio bytes.
 * @param {Record<string, string|undefined>} [options.env] - environment.
 * @param {string} [options.filename] - file name for the multipart part.
 * @param {string} [options.mimeType] - part content type.
 * @param {typeof fetch} [options.fetchImpl] - injectable transport (tests).
 * @returns {Promise<{ text: string, provider: string, model?: string, audioSeconds: number, inferenceSeconds: number }>}
 * @throws {AsrConfigError} when the cloud provider is selected without a key.
 * @throws {AsrUnavailableError} when the local provider is selected (P2).
 */
export async function transcribeAudio({ provider, audio, env = process.env, filename, mimeType, fetchImpl, signal, timeoutMs } = {}) {
  const resolved = resolveAsrProvider(provider, env)

  if (resolved === 'cloud') {
    const config = resolveCloudAsrConfig({ env })
    const result = await transcribeCloud({ config, audio, filename, mimeType, fetchImpl, signal, timeoutMs })
    return { ...result, audioSeconds: result.durationSeconds ?? 0, inferenceSeconds: 0 }
  }

  const report = checkLocalAsr({ env })
  const bytes = audio?.length ?? 0
  throw new AsrUnavailableError(`${report.message}（收到 ${bytes} 字节音频；未做任何转写。）`, {
    provider: 'local',
    phase: report.phase,
  })
}
