/**
 * dsh-voice-polish service — HTTP entry.
 *
 *   GET  /health        liveness + resolved LLM/ASR configuration
 *   POST /polish        { text, style?, instruction? }  → { polished, tip, gaps }
 *   POST /transcribe    raw audio body                  → { text }
 *   POST /process       raw audio body                  → { raw, polished, tip, gaps }
 *
 * Every response uses one envelope — `{ ok: true, value }` or
 * `{ ok: false, error: { message } }` — the same shape the DSH plugin's routes
 * use. JSON is always `charset=utf-8`; the request side is decoded as UTF-8.
 *
 * Node's own `http`, no framework, no dependencies. With VP_TOKEN set, every
 * route requires `Authorization: Bearer <token>`.
 *
 * @module dsh-voice-polish/service/server
 */

import { createServer as createHttpServer } from 'node:http'
import { pathToFileURL } from 'node:url'

import { AsrConfigError, AsrUnavailableError, checkAsr, resolveAsrProvider, transcribeAudio } from './asr/index.js'
import { MAX_INPUT_CHARS, llmConfigStatus, polish, readVocab, resolveLlmConfig } from './llm.js'

/** The frozen public route set. */
export const ROUTES = ['/health', '/polish', '/transcribe', '/process']

/** Liveness marker for the standalone service half. */
export const SERVICE_REV = 'service-p1'

/** Default port; override with VP_PORT. */
export const DEFAULT_PORT = 8787

/** Default bind host. Local by design — this service is not a public gateway. */
export const DEFAULT_HOST = '127.0.0.1'

/** Largest accepted request body, in bytes (same 64 MiB cap as the plugin). */
const MAX_BODY_BYTES = 64 * 1024 * 1024

/** Build the failure half of the envelope. */
function errorEnvelope(message, code) {
  return { ok: false, error: code === undefined ? { message } : { message, code } }
}

/**
 * Read a request body with a hard size cap. Rejects without destroying the
 * socket, so the caller can still write a real 413.
 * @param req - Node request stream.
 * @param {number} limit - maximum accepted bytes.
 * @param {boolean} [raw] - true to resolve with the raw Buffer (binary audio).
 * @returns {Promise<Buffer|string>} the body.
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
 * Write one JSON response. Failure-safe against a client that vanished mid-upload.
 * @param res - Node response.
 * @param {number} status - HTTP status.
 * @param {unknown} payload - serialisable body.
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

/** Constant-time-ish bearer comparison; never leaks length through a fast path. */
function tokenMatches(header, token) {
  const expected = `Bearer ${token}`
  if (typeof header !== 'string' || header.length !== expected.length) return false
  let diff = 0
  for (let i = 0; i < expected.length; i += 1) diff |= header.charCodeAt(i) ^ expected.charCodeAt(i)
  return diff === 0
}

/** ASR summary for /health, never throwing on a bad VP_ASR. */
function asrSummary(env) {
  try {
    const provider = resolveAsrProvider(undefined, env)
    const report = checkAsr(provider, { env })
    return {
      provider,
      implemented: report.implemented,
      configured: report.configured,
      ready: report.ready,
      phase: report.phase,
    }
  } catch (error) {
    return { provider: null, error: String(error?.message ?? error) }
  }
}

/**
 * Build the request handler.
 * @param {object} [options]
 * @param {Record<string, string|undefined>} [options.env] - environment.
 * @param {typeof fetch} [options.fetchImpl] - injectable transport (tests).
 * @param {string} [options.token] - required bearer token (defaults to VP_TOKEN).
 * @param {{ warn?: Function, error?: Function }} [options.logger] - sink for upstream failures.
 * @returns {(req, res) => void} the handler.
 */
export function createRequestHandler({ env = process.env, fetchImpl, token = env.VP_TOKEN, logger } = {}) {
  return function handle(req, res) {
    const url = new URL(req.url ?? '/', 'http://dsh.internal')
    const pathname = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, '') : url.pathname

    if (typeof token === 'string' && token.length > 0 && !tokenMatches(req.headers?.authorization, token)) {
      writeJson(res, 401, errorEnvelope('unauthorized: 需要 Authorization: Bearer <VP_TOKEN>', 'UNAUTHORIZED'))
      return
    }

    if (pathname === '/health') {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        writeJson(res, 405, errorEnvelope('method not allowed'))
        return
      }
      writeJson(res, 200, {
        ok: true,
        value: {
          status: 'ok',
          service: 'dsh-voice-polish',
          rev: SERVICE_REV,
          llm: llmConfigStatus({ env }),
          asr: asrSummary(env),
        },
      })
      return
    }

    if (pathname === '/polish') {
      if (req.method !== 'POST') {
        writeJson(res, 405, errorEnvelope('method not allowed'))
        return
      }
      readBody(req, MAX_BODY_BYTES)
        .then(async (raw) => {
          let payload
          try {
            payload = JSON.parse(raw)
          } catch {
            writeJson(res, 400, errorEnvelope('invalid JSON body'))
            return
          }
          const text = typeof payload?.text === 'string' ? payload.text.trim() : ''
          if (text.length === 0) {
            writeJson(res, 400, errorEnvelope('text is required'))
            return
          }
          if (text.length > MAX_INPUT_CHARS) {
            writeJson(res, 413, errorEnvelope(`text exceeds ${MAX_INPUT_CHARS} characters`))
            return
          }
          let config
          try {
            config = resolveLlmConfig({ env })
          } catch (error) {
            writeJson(res, 500, errorEnvelope(String(error?.message ?? error), 'LLM_NOT_CONFIGURED'))
            return
          }
          try {
            const style = typeof payload?.style === 'string' ? payload.style : undefined
            const instruction = typeof payload?.instruction === 'string' ? payload.instruction : undefined
            const { value } = await polish({ config, text, style, instruction, vocabText: readVocab(env), fetchImpl })
            writeJson(res, 200, { ok: true, value })
          } catch (error) {
            logger?.warn?.(`[dsh-voice-polish] polish failed: ${error?.message ?? error}`)
            writeJson(res, 502, errorEnvelope(String(error?.message ?? error), 'LLM_CALL_FAILED'))
          }
        })
        .catch((error) => {
          writeJson(res, 413, errorEnvelope(String(error?.message ?? error)))
        })
      return
    }

    if (pathname === '/transcribe' || pathname === '/process') {
      if (req.method !== 'POST') {
        writeJson(res, 405, errorEnvelope('method not allowed'))
        return
      }
      readBody(req, MAX_BODY_BYTES, true)
        .then(async (audio) => {
          if (audio.length === 0) {
            writeJson(res, 400, errorEnvelope('audio payload is empty'))
            return
          }
          let transcript
          try {
            const provider = resolveAsrProvider(url.searchParams.get('asr') ?? undefined, env)
            // The audio arrives as a raw byte stream; the part headers tell the
            // upstream service what it is instead of forcing a base64 envelope.
            const requestType = String(req.headers?.['content-type'] ?? '')
            const mimeType = requestType.startsWith('audio/') ? requestType : 'audio/wav'
            const filename = url.searchParams.get('filename') ?? 'audio.wav'
            transcript = await transcribeAudio({ provider, audio, env, filename, mimeType, fetchImpl })
          } catch (error) {
            if (error instanceof AsrConfigError) {
              writeJson(res, 500, errorEnvelope(String(error.message), error.code))
              return
            }
            if (error instanceof AsrUnavailableError) {
              writeJson(res, 501, errorEnvelope(String(error.message), error.code))
              return
            }
            logger?.warn?.(`[dsh-voice-polish] transcribe failed: ${error?.message ?? error}`)
            writeJson(res, 502, errorEnvelope(String(error?.message ?? error), 'ASR_FAILED'))
            return
          }

          if (pathname === '/transcribe') {
            writeJson(res, 200, { ok: true, value: transcript })
            return
          }

          const text = String(transcript?.text ?? '').trim()
          if (text.length === 0) {
            writeJson(res, 422, errorEnvelope('转写结果为空，无法整理'))
            return
          }
          let config
          try {
            config = resolveLlmConfig({ env })
          } catch (error) {
            writeJson(res, 500, errorEnvelope(String(error?.message ?? error), 'LLM_NOT_CONFIGURED'))
            return
          }
          try {
            const style = url.searchParams.get('style') ?? undefined
            const { value } = await polish({ config, text, style, vocabText: readVocab(env), fetchImpl })
            writeJson(res, 200, {
              ok: true,
              value: { raw: text, polished: value.polished, tip: value.tip, gaps: value.gaps, style: value.style, model: value.model },
            })
          } catch (error) {
            logger?.warn?.(`[dsh-voice-polish] process failed: ${error?.message ?? error}`)
            writeJson(res, 502, errorEnvelope(String(error?.message ?? error), 'LLM_CALL_FAILED'))
          }
        })
        .catch((error) => {
          writeJson(res, 413, errorEnvelope(String(error?.message ?? error)))
        })
      return
    }

    writeJson(res, 404, errorEnvelope('not found'))
  }
}

/**
 * Create the HTTP server without listening.
 * @param {object} [options] - same as createRequestHandler.
 * @returns {import('node:http').Server} the server.
 */
export function createServer(options = {}) {
  return createHttpServer(createRequestHandler(options))
}

/**
 * Start listening.
 * @param {object} [options]
 * @param {number} [options.port] - port (default VP_PORT, then 8787; 0 picks a free one).
 * @param {string} [options.host] - bind host (default VP_HOST, then 127.0.0.1).
 * @param {object} [options] - remaining options go to createServer.
 * @returns {Promise<{ server: object, port: number, host: string, url: string }>}
 */
export async function startServer(options = {}) {
  const { port = Number(process.env.VP_PORT ?? DEFAULT_PORT), host = process.env.VP_HOST || DEFAULT_HOST, ...rest } = options
  const server = createServer(rest)
  await new Promise((resolve, reject) => {
    const onError = (error) => reject(error)
    server.once('error', onError)
    server.listen(port, host, () => {
      server.off('error', onError)
      resolve()
    })
  })
  const address = server.address()
  const actualPort = address && typeof address === 'object' ? address.port : port
  return { server, port: actualPort, host, url: `http://${host}:${actualPort}` }
}

// Only auto-start when this file is the process entry point.
const entry = process.argv[1]
if (typeof entry === 'string' && import.meta.url === pathToFileURL(entry).href) {
  const { url } = await startServer()
  process.stdout.write(`dsh-voice-polish service listening on ${url}\n`)
  process.stdout.write(`routes: ${ROUTES.join(' ')}\n`)
}
