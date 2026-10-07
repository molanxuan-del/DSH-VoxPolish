/**
 * Offline tests for the standalone service half.
 *
 * Everything here is deterministic and network-free: the LLM transport is
 * injected, the ASR providers are only *checked* (never invoked), and the HTTP
 * tests talk to a real `node:http` server on an ephemeral port.
 *
 * Run with: node --test test/service.test.mjs
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'

import {
  DEFAULT_STYLE,
  STYLE_GUIDE,
  SYSTEM_PROMPT,
  normalizeVocab,
  parseAnswer,
  salvageAnswer,
  vocabPromptBlock,
} from '../lib/core.js'
import * as plugin from '../lib/index.js'
import {
  DEFAULT_LLM_BASE_URL,
  DEFAULT_LLM_MODEL,
  buildSystemPrompt,
  buildUserMessage,
  chatCompletionsUrl,
  llmConfigStatus,
  normalizeBaseUrl,
  normalizeStyle,
  polish,
  resolveLlmConfig,
} from '../service/llm.js'
import {
  AsrConfigError,
  AsrUnavailableError,
  DEFAULT_ASR_BASE_URL,
  DEFAULT_ASR_MODEL,
  buildMultipartBody,
  checkAsr,
  checkCloudAsr,
  checkLocalAsr,
  parseTranscription,
  resolveAsrProvider,
  resolveCloudAsrConfig,
  transcribeAudio,
  transcribeCloud,
} from '../service/asr/index.js'
import { USAGE, looksLikeAudioPath, mimeTypeFor, parseArgs, run } from '../service/cli.js'
import { ROUTES, SERVICE_REV, startServer } from '../service/server.js'

/* ------------------------------------------------------------------ helpers */

/** A `fetch` stand-in that answers with one canned chat completion. */
function fakeChat(reply, record = []) {
  const impl = async (url, init) => {
    record.push({ url, init, body: JSON.parse(init.body) })
    return new Response(JSON.stringify({ choices: [{ message: { content: reply } }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }
  impl.record = record
  return impl
}

/** A `fetch` stand-in for the whole cloud pipeline: ASR route + chat route. */
function fakePipeline({ transcript = '呃 那个 原始转写', reply = '{"polished":"整理后","tip":"建议","gaps":[]}', asrStatus = 200, record = [] } = {}) {
  const impl = async (url, init) => {
    record.push({ url: String(url), init })
    if (String(url).endsWith('/audio/transcriptions')) {
      if (asrStatus !== 200) return new Response('{"error":{"message":"bad key"}}', { status: asrStatus })
      return new Response(JSON.stringify({ text: transcript, language: 'zh', duration: 2.5 }), { status: 200 })
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: reply } }] }), { status: 200 })
  }
  impl.record = record
  return impl
}

/** ASR + LLM env for the cloud path. */
function cloudEnv(extra = {}) {
  return {
    VP_ASR: 'cloud',
    VP_ASR_BASE_URL: 'http://asr.test/v1',
    VP_ASR_API_KEY: 'asr-key',
    VP_ASR_MODEL: 'whisper-1',
    VP_LLM_API_KEY: 'llm-key',
    DSH_HOME: path.join(os.tmpdir(), 'vp-test-home-absent'),
    ...extra,
  }
}

/** A writable stand-in for stdout/stderr. */
function capture() {
  const state = { text: '' }
  return {
    stream: {
      write(chunk) {
        state.text += String(chunk)
        return true
      },
    },
    get text() {
      return state.text
    },
  }
}

/** Start a server on an ephemeral port and always close it. */
async function withServer(options, fn) {
  const { server, url } = await startServer({ port: 0, ...options })
  try {
    return await fn(url)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

/* ------------------------------------------------- 1. the shared pure core */

test('core exposes the whole frozen prompt surface', () => {
  assert.equal(typeof parseAnswer, 'function')
  assert.equal(typeof salvageAnswer, 'function')
  assert.equal(typeof normalizeVocab, 'function')
  assert.equal(typeof vocabPromptBlock, 'function')
  assert.ok(SYSTEM_PROMPT.length > 500)
  assert.equal(Object.keys(STYLE_GUIDE).length, 6)
  assert.ok(Object.hasOwn(STYLE_GUIDE, DEFAULT_STYLE))
})

test('core has no DSH surface: it is pure', () => {
  // The service relies on this: if core ever grew a DSH import it would stop
  // loading outside the DSH process.
  assert.equal(Object.hasOwn(plugin, 'apply'), true)
  assert.equal(plugin.name, 'dsh-voice-polish')
  assert.deepEqual(plugin.inject, ['webServer'])
})

test('lib/index.js re-exports the very same parseAnswer instance from core', () => {
  // Identity, not just equality: proves the plugin really delegates to core.
  assert.equal(plugin.parseAnswer, parseAnswer)
})

test('normalizeVocab trims, de-duplicates and caps', () => {
  assert.equal(normalizeVocab('甲\n甲\n  乙  \n\n丙'), '甲\n乙\n丙')
  assert.equal(normalizeVocab(''), '')
  assert.equal(normalizeVocab(undefined), '')
})

test('vocabPromptBlock adds the block only for a non-empty list', () => {
  assert.equal(vocabPromptBlock(''), '')
  const block = vocabPromptBlock('库狄\n库狄\nVoxPolish')
  assert.ok(block.startsWith('\n\n【用户自定义词表】'))
  assert.ok(block.endsWith('库狄\nVoxPolish'))
})

/* ------------------------------------------------------ 2. the JSON salvage */

test('parseAnswer takes the strict path for well-formed JSON', () => {
  const strict = parseAnswer('{"polished":"整理后的内容","tip":"建议","gaps":["甲","乙"]}')
  assert.deepEqual(strict, { polished: '整理后的内容', tip: '建议', gaps: ['甲', '乙'] })

  // The tip itself contains an embedded `,"gaps"` marker. A strict parse keeps
  // it whole; the salvage fallback would truncate it to 先说". If this ever
  // starts failing, strict parsing was skipped.
  const tricky = '{"polished":"P","tip":"先说\\",\\"gaps\\":[]}","gaps":["g"]}'
  const result = parseAnswer(tricky)
  assert.equal(result.polished, 'P')
  assert.equal(result.tip, '先说","gaps":[]}')
  assert.deepEqual(result.gaps, ['g'])
})

test('parseAnswer unwraps a Markdown fence', () => {
  const result = parseAnswer('```json\n{"polished":" fenced case","tip":"","gaps":[]}\n```')
  assert.equal(result.polished, 'fenced case')
  assert.deepEqual(result.gaps, [])
})

test('parseAnswer salvages unescaped quotes instead of dumping raw JSON', () => {
  const raw =
    '{"polished":"查看这个项目，在图中画出一块区域。注意：不要与 rr 耦合。","tip":""不与rr底层耦合"前面有几次自我更正。","gaps":["甲？","乙？","丙？"]}'
  const result = parseAnswer(raw)
  assert.ok(result.polished.startsWith('查看这个项目'))
  assert.ok(result.polished.endsWith('不要与 rr 耦合。'))
  assert.ok(!result.polished.includes('"polished"'))
  assert.ok(result.tip.includes('自我更正'))
  assert.equal(result.gaps.length, 3)
})

test('parseAnswer turns plain prose into the polished text', () => {
  const result = parseAnswer('这不是 JSON，只是一段普通文本。')
  assert.equal(result.polished, '这不是 JSON，只是一段普通文本。')
  assert.equal(result.tip, '')
  assert.deepEqual(result.gaps, [])
})

test('parseAnswer tolerates an empty reply', () => {
  const result = parseAnswer('')
  assert.deepEqual(result, { polished: '', tip: '', gaps: [] })
})

/* -------------------------------------------- 3. message construction (B4) */

test('buildUserMessage is byte-identical to the plugin format', () => {
  assert.equal(
    buildUserMessage('原始文本', { style: 'deep' }),
    `【风格要求】${STYLE_GUIDE.deep}\n\n【原始口语转写】\n原始文本`,
  )
  assert.ok(buildUserMessage('x', { style: 'light' }).includes(STYLE_GUIDE.light))
})

test('buildUserMessage falls back to the default style and caps the extra ask', () => {
  const unknown = buildUserMessage('x', { style: '不存在的风格' })
  assert.ok(unknown.includes(STYLE_GUIDE[DEFAULT_STYLE]))
  const long = buildUserMessage('x', { instruction: '甲'.repeat(1000) })
  const suffix = long.slice(long.indexOf('【本次额外要求】') + '【本次额外要求】'.length)
  assert.equal(suffix.length, 400)
  assert.ok(!buildUserMessage('x', { instruction: '   ' }).includes('【本次额外要求】'))
})

test('buildSystemPrompt appends the vocabulary block to the shared prompt', () => {
  assert.equal(buildSystemPrompt(''), SYSTEM_PROMPT)
  const withVocab = buildSystemPrompt('库狄\n库狄\nSenseVoice')
  assert.ok(withVocab.startsWith(SYSTEM_PROMPT))
  assert.ok(withVocab.includes('【用户自定义词表】'))
  assert.ok(withVocab.endsWith('库狄\nSenseVoice'))
})

test('normalizeStyle keeps known styles only', () => {
  assert.equal(normalizeStyle('structured'), 'structured')
  assert.equal(normalizeStyle('nope'), DEFAULT_STYLE)
  assert.equal(normalizeStyle(undefined), DEFAULT_STYLE)
})

/* ------------------------------------------------------ 4. LLM configuration */

test('resolveLlmConfig defaults to DeepSeek + deepseek-flash', () => {
  const config = resolveLlmConfig({ env: { VP_LLM_API_KEY: 'test-key' } })
  assert.equal(config.baseUrl, DEFAULT_LLM_BASE_URL)
  assert.equal(config.baseUrl, 'https://api.deepseek.com')
  assert.equal(config.model, DEFAULT_LLM_MODEL)
  assert.equal(config.model, 'deepseek-flash')
  assert.equal(config.sources.model, 'default')
  assert.equal(chatCompletionsUrl(config.baseUrl), 'https://api.deepseek.com/chat/completions')
})

test('resolveLlmConfig fails loudly without a key, and CLI wins over env', () => {
  assert.throws(() => resolveLlmConfig({ env: {} }), /VP_LLM_API_KEY/)
  const config = resolveLlmConfig({
    env: { VP_LLM_API_KEY: 'env-key', VP_LLM_MODEL: 'env-model', VP_LLM_BASE_URL: 'http://env.example/v1/' },
    model: 'cli-model',
    baseUrl: 'http://cli.example/',
  })
  assert.equal(config.model, 'cli-model')
  assert.equal(config.sources.model, 'cli')
  assert.equal(config.baseUrl, 'http://cli.example')
  assert.equal(config.sources.baseUrl, 'cli')
})

test('normalizeBaseUrl and llmConfigStatus never expose the key', () => {
  assert.equal(normalizeBaseUrl(''), DEFAULT_LLM_BASE_URL)
  assert.equal(normalizeBaseUrl(undefined), DEFAULT_LLM_BASE_URL)
  assert.equal(normalizeBaseUrl('http://x///'), 'http://x')
  const status = llmConfigStatus({ env: { VP_LLM_API_KEY: 'secret-value' } })
  assert.equal(status.keyConfigured, true)
  assert.equal(JSON.stringify(status).includes('secret-value'), false)
})

test('polish uses the shared parser and posts an OpenAI-compatible body', async () => {
  const transport = fakeChat('{"polished":"整理后","tip":"建议","gaps":["缺口"]}')
  const config = resolveLlmConfig({ env: { VP_LLM_API_KEY: 'test-key' } })
  const { value, raw } = await polish({ config, text: '呃 那个 文本', style: 'concise', vocabText: '库狄', fetchImpl: transport })
  assert.equal(value.polished, '整理后')
  assert.deepEqual(value.gaps, ['缺口'])
  assert.equal(value.style, 'concise')
  assert.equal(value.model, 'deepseek-flash')
  assert.equal(raw, '{"polished":"整理后","tip":"建议","gaps":["缺口"]}')

  const sent = transport.record[0]
  assert.equal(sent.url, 'https://api.deepseek.com/chat/completions')
  assert.equal(sent.init.method, 'POST')
  assert.equal(sent.init.headers['content-type'], 'application/json; charset=utf-8')
  assert.equal(sent.init.headers.authorization, 'Bearer test-key')
  assert.equal(sent.body.model, 'deepseek-flash')
  assert.equal(sent.body.stream, false)
  assert.equal(sent.body.messages[0].role, 'system')
  assert.ok(sent.body.messages[0].content.includes('【用户自定义词表】'))
  assert.ok(sent.body.messages[1].content.includes(STYLE_GUIDE.concise))
  assert.ok(sent.body.messages[1].content.includes('呃 那个 文本'))
})

test('polish reports an upstream failure instead of returning junk', async () => {
  const failing = async () => new Response('{"error":"nope"}', { status: 401 })
  const config = resolveLlmConfig({ env: { VP_LLM_API_KEY: 'test-key' } })
  await assert.rejects(() => polish({ config, text: 'x', fetchImpl: failing }), /HTTP 401/)
})

/* --------------------------------------------------------- 5. CLI argument parsing */

test('parseArgs selects text / stdin / file / selftest / asr-check modes', () => {
  assert.equal(parseArgs(['你好']).mode, 'text')
  assert.equal(parseArgs(['你好']).input, '你好')
  assert.equal(parseArgs(['-']).mode, 'stdin')
  assert.equal(parseArgs(['audio.wav']).mode, 'file')
  assert.equal(parseArgs(['recording.MP3']).mode, 'file')
  assert.equal(parseArgs(['--file', 'no-extension']).mode, 'file')
  assert.equal(parseArgs(['--selftest']).mode, 'selftest')
  assert.equal(parseArgs(['--help']).mode, 'help')
  assert.equal(parseArgs(['-h']).mode, 'help')
  assert.equal(parseArgs(['--asr-check', 'local']).mode, 'asr-check')
  assert.equal(parseArgs(['--asr-check=cloud']).asrCheck, 'cloud')
  assert.equal(parseArgs([]).mode, 'none')
})

test('parseArgs handles --json / --style / --raw / --no-vocab', () => {
  const options = parseArgs(['--json', '--raw', '--no-vocab', '--style', 'deep', '文本'])
  assert.equal(options.json, true)
  assert.equal(options.raw, true)
  assert.equal(options.vocab, false)
  assert.equal(options.style, 'deep')
  assert.equal(parseArgs(['--style=light', '文本']).style, 'light')
  for (const style of Object.keys(STYLE_GUIDE)) assert.equal(parseArgs(['--style', style, 'x']).style, style)
})

test('parseArgs rejects unknown flags, bad styles and missing values', () => {
  assert.throws(() => parseArgs(['--bogus']), /未知参数/)
  assert.throws(() => parseArgs(['-x']), /未知参数/)
  assert.throws(() => parseArgs(['--style', 'nope', 'x']), /不是已知风格/)
  assert.throws(() => parseArgs(['--style']), /需要一个参数值/)
  assert.throws(() => parseArgs(['--asr-check']), /需要一个参数值/)
  assert.throws(() => parseArgs(['a', 'b']), /只接受一个输入/)
})

test('looksLikeAudioPath only accepts known audio extensions', () => {
  assert.equal(looksLikeAudioPath('a.wav'), true)
  assert.equal(looksLikeAudioPath('C:\\x\\a.flac'), true)
  assert.equal(looksLikeAudioPath('这是一段话.txt'), false)
  assert.equal(looksLikeAudioPath('一句话'), false)
})

/* ------------------------------------------------------------- 6. ASR providers */

test('resolveAsrProvider: CLI wins, then VP_ASR, then local', () => {
  assert.equal(resolveAsrProvider(undefined, {}), 'local')
  assert.equal(resolveAsrProvider(undefined, { VP_ASR: 'cloud' }), 'cloud')
  assert.equal(resolveAsrProvider('cloud', {}), 'cloud')
  assert.equal(resolveAsrProvider('local', { VP_ASR: 'cloud' }), 'local')
  assert.equal(resolveAsrProvider('CLOUD', {}), 'cloud')
  assert.throws(() => resolveAsrProvider('nope', {}), /未知的 ASR 提供者/)
})

test('checkLocalAsr stats the SenseVoice files and admits P1 is not wired', () => {
  const report = checkLocalAsr({ env: {} })
  assert.equal(report.provider, 'local')
  assert.equal(report.implemented, false)
  assert.equal(report.ready, false)
  assert.equal(report.phase, 'P2')
  assert.equal(report.checks.length, 3)
  assert.ok(report.checks.every((check) => typeof check.path === 'string' && typeof check.ok === 'boolean'))
  assert.ok(report.checks[0].path.endsWith(path.join('sensevoice-onnx', 'model.int8.onnx')))
  assert.ok(report.checks[1].path.endsWith(path.join('sensevoice-onnx', 'tokens.txt')))
  assert.ok(report.checks[2].path.endsWith(path.join('silero', 'silero_vad.onnx')))
  assert.match(report.message, /P2/)

  // Injectable existence check: no filesystem needed to prove the logic.
  const allPresent = checkLocalAsr({ env: {}, exists: () => true })
  assert.equal(allPresent.configured, true)
  const nonePresent = checkLocalAsr({ env: {}, exists: () => false })
  assert.equal(nonePresent.configured, false)
  assert.equal(nonePresent.ready, false)
})

test('checkCloudAsr checks configuration only and never calls out', () => {
  const without = checkCloudAsr({ env: {} })
  assert.equal(without.configured, false)
  assert.equal(without.implemented, true)
  assert.equal(without.ready, false)
  assert.equal(without.phase, 'P3')
  assert.equal(without.baseUrl, DEFAULT_ASR_BASE_URL)
  assert.equal(without.model, DEFAULT_ASR_MODEL)
  assert.ok(without.endpoint.endsWith('/audio/transcriptions'))
  assert.match(without.message, /VP_ASR_API_KEY/)

  const withKey = checkCloudAsr({ env: { VP_ASR_API_KEY: 'k', VP_ASR_BASE_URL: 'https://example.test/v1/' } })
  assert.equal(withKey.configured, true)
  assert.equal(withKey.baseUrl, 'https://example.test/v1')
  assert.equal(withKey.endpoint, 'https://example.test/v1/audio/transcriptions')
  assert.equal(withKey.model, 'whisper-1')
  assert.equal(withKey.ready, true)
})

test('checkAsr dispatches, and an unknown provider is rejected', () => {
  assert.equal(checkAsr('local', { env: {} }).provider, 'local')
  assert.equal(checkAsr('cloud', { env: {} }).provider, 'cloud')
  assert.throws(() => checkAsr('nope', { env: {} }), /未知的 ASR 提供者/)
})

test('transcribeAudio: local is still P2, cloud demands its own key', async () => {
  await assert.rejects(
    () => transcribeAudio({ provider: 'local', audio: Buffer.alloc(4), env: {} }),
    (error) => error instanceof AsrUnavailableError && error.code === 'ASR_NOT_IMPLEMENTED' && error.phase === 'P2',
  )
  await assert.rejects(
    () => transcribeAudio({ provider: 'cloud', audio: Buffer.alloc(4), env: {} }),
    (error) => error instanceof AsrConfigError && error.code === 'ASR_NOT_CONFIGURED',
  )
})

/* ------------------------------------------------ 6b. cloud ASR (multipart) */

test('resolveCloudAsrConfig defaults to OpenAI and never reuses the LLM key', () => {
  assert.throws(() => resolveCloudAsrConfig({ env: {} }), /VP_ASR_API_KEY/)
  // The LLM credential must NOT be silently reused: it usually belongs to a
  // different vendor, and DeepSeek has no /audio/transcriptions endpoint at all.
  assert.throws(() => resolveCloudAsrConfig({ env: { VP_LLM_API_KEY: 'deepseek-key', VP_LLM_BASE_URL: 'https://api.deepseek.com' } }), /VP_ASR_API_KEY/)

  const config = resolveCloudAsrConfig({ env: { VP_ASR_API_KEY: 'k' } })
  assert.equal(config.baseUrl, DEFAULT_ASR_BASE_URL)
  assert.equal(config.model, DEFAULT_ASR_MODEL)
  const overridden = resolveCloudAsrConfig({ env: { VP_ASR_API_KEY: 'k', VP_ASR_MODEL: 'whisper-large-v3' }, model: 'cli-model' })
  assert.equal(overridden.model, 'cli-model')
  assert.equal(overridden.sources.model, 'cli')
})

test('buildMultipartBody encodes file, model and binary audio untouched', () => {
  const audio = Buffer.from([0x52, 0x49, 0x46, 0x46, 0x00, 0xff, 0x1a])
  const { body, contentType, boundary } = buildMultipartBody({
    audio,
    model: 'whisper-1',
    filename: 'C:\\录音\\样例.wav',
    mimeType: 'audio/wav',
    boundary: 'X-BOUNDARY-X',
  })
  assert.equal(contentType, 'multipart/form-data; boundary=X-BOUNDARY-X')
  // Decode as UTF-8: the header text is UTF-8, and the assertions below are about
  // the headers, not the binary span (which is checked on the Buffer itself).
  const head = body.toString('utf8')
  assert.ok(head.startsWith('--X-BOUNDARY-X\r\n'))
  assert.ok(head.includes('Content-Disposition: form-data; name="file"; filename="样例.wav"'))
  assert.ok(head.includes('Content-Type: audio/wav'))
  assert.ok(head.includes('Content-Disposition: form-data; name="model"'))
  assert.ok(head.includes('\r\n\r\nwhisper-1\r\n'))
  assert.ok(head.trimEnd().endsWith('--X-BOUNDARY-X--'))
  // The audio span must survive byte for byte, NUL and 0xff included.
  assert.ok(body.includes(audio))

  const withFields = buildMultipartBody({ audio, model: 'm', fields: { language: 'zh' }, boundary: 'B' })
  assert.ok(withFields.body.toString('utf8').includes('name="language"'))
  // A generated boundary is unique and header-safe.
  const generated = buildMultipartBody({ audio, model: 'm' })
  assert.match(generated.boundary, /^----dshVoicePolish[0-9a-f]{32}$/)
  assert.notEqual(buildMultipartBody({ audio, model: 'm' }).boundary, generated.boundary)
})

test('parseTranscription accepts the OpenAI shape, plain text and rejects emptiness', () => {
  assert.deepEqual(parseTranscription('{"text":"  你好  ","language":"zh","duration":1.5}'), {
    text: '你好',
    language: 'zh',
    durationSeconds: 1.5,
  })
  assert.deepEqual(parseTranscription('裸文本转录'), { text: '裸文本转录' })
  assert.throws(() => parseTranscription(''), /空响应/)
  assert.throws(() => parseTranscription('{"foo":1}'), /text/)
})

test('transcribeCloud posts a real multipart body and reports upstream failures', async () => {
  const transport = fakePipeline({ transcript: '云端识别结果' })
  const config = resolveCloudAsrConfig({ env: { VP_ASR_API_KEY: 'k', VP_ASR_BASE_URL: 'http://asr.test/v1' } })
  const result = await transcribeCloud({ config, audio: Buffer.from('RIFF....'), fetchImpl: transport })
  assert.equal(result.text, '云端识别结果')
  assert.equal(result.provider, 'cloud')
  assert.equal(result.durationSeconds, 2.5)

  const sent = transport.record[0]
  assert.equal(sent.url, 'http://asr.test/v1/audio/transcriptions')
  assert.equal(sent.init.method, 'POST')
  assert.match(sent.init.headers['content-type'], /^multipart\/form-data; boundary=----dshVoicePolish[0-9a-f]{32}$/)
  assert.equal(sent.init.headers.authorization, 'Bearer k')

  const failing = fakePipeline({ asrStatus: 401 })
  await assert.rejects(() => transcribeCloud({ config, audio: Buffer.from('x'), fetchImpl: failing }), /HTTP 401/)
})

/* ------------------------------------------------------------- 7. HTTP server */

test('ROUTES is exactly the frozen endpoint set', () => {
  assert.deepEqual(ROUTES, ['/health', '/polish', '/transcribe', '/process'])
  assert.equal(typeof SERVICE_REV, 'string')
})

test('GET /health reports status and resolved configuration without the key', async () => {
  await withServer({ env: { VP_LLM_API_KEY: 'secret-value', VP_ASR: 'cloud', VP_ASR_API_KEY: 'asr-secret' } }, async (url) => {
    const response = await fetch(`${url}/health`)
    assert.equal(response.status, 200)
    assert.match(response.headers.get('content-type'), /application\/json; charset=utf-8/)
    const body = await response.json()
    assert.equal(body.ok, true)
    assert.equal(body.value.status, 'ok')
    assert.equal(body.value.service, 'dsh-voice-polish')
    assert.equal(body.value.llm.baseUrl, DEFAULT_LLM_BASE_URL)
    assert.equal(body.value.llm.model, DEFAULT_LLM_MODEL)
    assert.equal(body.value.llm.keyConfigured, true)
    assert.equal(body.value.asr.provider, 'cloud')
    assert.equal(JSON.stringify(body).includes('secret-value'), false)
    assert.equal(JSON.stringify(body).includes('asr-secret'), false)
  })
})

test('POST /polish runs the whole pipeline and returns the shared envelope', async () => {
  const transport = fakeChat('{"polished":"整理后的文本","tip":"建议","gaps":["缺口"]}')
  const env = { VP_LLM_API_KEY: 'test-key', DSH_HOME: path.join(os.tmpdir(), 'vp-test-home-absent') }
  await withServer({ env, fetchImpl: transport }, async (url) => {
    const response = await fetch(`${url}/polish`, {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ text: '  呃 那个 我想 改一下 配置  ', style: 'deep', instruction: '别动别的' }),
    })
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.equal(body.ok, true)
    assert.equal(body.value.polished, '整理后的文本')
    assert.equal(body.value.tip, '建议')
    assert.deepEqual(body.value.gaps, ['缺口'])
    assert.equal(body.value.style, 'deep')

    const sent = transport.record[0].body
    assert.equal(sent.messages[1].content, buildUserMessage('呃 那个 我想 改一下 配置', { style: 'deep', instruction: '别动别的' }))
    assert.equal(sent.messages[0].content, buildSystemPrompt(''))
  })
})

test('POST /polish validates its input and fails loudly without a key', async () => {
  await withServer({ env: {} }, async (url) => {
    const bad = await fetch(`${url}/polish`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{oops' })
    assert.equal(bad.status, 400)
    assert.equal((await bad.json()).ok, false)

    const empty = await fetch(`${url}/polish`, { method: 'POST', body: JSON.stringify({ text: '   ' }) })
    assert.equal(empty.status, 400)

    const noKey = await fetch(`${url}/polish`, { method: 'POST', body: JSON.stringify({ text: '文本' }) })
    assert.equal(noKey.status, 500)
    const body = await noKey.json()
    assert.equal(body.ok, false)
    assert.equal(body.error.code, 'LLM_NOT_CONFIGURED')
    assert.match(body.error.message, /VP_LLM_API_KEY/)

    const wrongMethod = await fetch(`${url}/polish`)
    assert.equal(wrongMethod.status, 405)
  })
})

test('POST /transcribe and /process answer 501 until P2/P3 wire ASR', async () => {
  const env = { VP_LLM_API_KEY: 'test-key' }
  await withServer({ env }, async (url) => {
    for (const route of ['/transcribe', '/process']) {
      const response = await fetch(`${url}${route}`, { method: 'POST', body: Buffer.from('RIFF....WAVE') })
      assert.equal(response.status, 501)
      const body = await response.json()
      assert.equal(body.ok, false)
      assert.equal(body.error.code, 'ASR_NOT_IMPLEMENTED')
      assert.match(body.error.message, /尚未接入/)
      assert.match(body.error.message, /P2/)
    }
    const empty = await fetch(`${url}/transcribe`, { method: 'POST', body: Buffer.alloc(0) })
    assert.equal(empty.status, 400)
    const wrongMethod = await fetch(`${url}/transcribe`)
    assert.equal(wrongMethod.status, 405)
  })
})

test('POST /transcribe returns a real transcript through the cloud provider', async () => {
  const transport = fakePipeline({ transcript: '呃 那个 原始转写' })
  await withServer({ env: cloudEnv(), fetchImpl: transport }, async (url) => {
    const response = await fetch(`${url}/transcribe?filename=note.wav`, {
      method: 'POST',
      headers: { 'content-type': 'audio/wav' },
      body: Buffer.from('RIFF....WAVEfmt '),
    })
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.equal(body.ok, true)
    assert.equal(body.value.text, '呃 那个 原始转写')
    assert.equal(body.value.provider, 'cloud')

    const sent = transport.record[0]
    assert.equal(sent.url, 'http://asr.test/v1/audio/transcriptions')
    assert.equal(sent.init.headers.authorization, 'Bearer asr-key')
    const raw = Buffer.from(sent.init.body).toString('utf8')
    assert.ok(raw.includes('name="file"; filename="note.wav"'))
    assert.ok(raw.includes('name="model"') && raw.includes('whisper-1'))
    assert.ok(raw.includes('RIFF....WAVEfmt '))
  })
})

test('POST /process chains cloud ASR into the shared polish pipeline', async () => {
  const transport = fakePipeline({ transcript: '呃 那个 我想加缓存' })
  await withServer({ env: cloudEnv(), fetchImpl: transport }, async (url) => {
    const response = await fetch(`${url}/process?style=concise`, { method: 'POST', body: Buffer.from('RIFF....WAVEfmt ') })
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.equal(body.ok, true)
    assert.equal(body.value.raw, '呃 那个 我想加缓存')
    assert.equal(body.value.polished, '整理后')
    assert.equal(body.value.tip, '建议')
    assert.deepEqual(body.value.gaps, [])
    assert.equal(body.value.style, 'concise')

    const chat = transport.record.find((call) => call.url.endsWith('/chat/completions'))
    const chatBody = JSON.parse(chat.init.body)
    assert.ok(chatBody.messages[1].content.includes('呃 那个 我想加缓存'))
    assert.ok(chatBody.messages[1].content.includes(STYLE_GUIDE.concise))
  })
})

test('cloud ASR is not silently skipped when unconfigured or failing', async () => {
  // Configured provider, missing key: a clear 500 naming the variable.
  await withServer({ env: { VP_ASR: 'cloud', VP_LLM_API_KEY: 'llm-key' } }, async (url) => {
    const response = await fetch(`${url}/transcribe`, { method: 'POST', body: Buffer.from('RIFF') })
    assert.equal(response.status, 500)
    const body = await response.json()
    assert.equal(body.ok, false)
    assert.equal(body.error.code, 'ASR_NOT_CONFIGURED')
    assert.match(body.error.message, /VP_ASR_API_KEY/)
  })

  // Configured and reachable-looking, but the upstream rejects it.
  const failing = fakePipeline({ asrStatus: 401 })
  await withServer({ env: cloudEnv(), fetchImpl: failing }, async (url) => {
    const response = await fetch(`${url}/transcribe`, { method: 'POST', body: Buffer.from('RIFF') })
    assert.equal(response.status, 502)
    const body = await response.json()
    assert.equal(body.error.code, 'ASR_FAILED')
    assert.match(body.error.message, /HTTP 401/)
  })

  // `local` is untouched: it still reports 501 and owns up to P2.
  const localEnv = { VP_LLM_API_KEY: 'llm-key' }
  await withServer({ env: localEnv }, async (url) => {
    const response = await fetch(`${url}/transcribe`, { method: 'POST', body: Buffer.from('RIFF') })
    assert.equal(response.status, 501)
    assert.equal((await response.json()).error.code, 'ASR_NOT_IMPLEMENTED')
  })
})

test('unknown paths answer 404 with the failure envelope', async () => {
  await withServer({ env: {} }, async (url) => {
    const response = await fetch(`${url}/nope`)
    assert.equal(response.status, 404)
    const body = await response.json()
    assert.deepEqual(body, { ok: false, error: { message: 'not found' } })
  })
})

test('VP_TOKEN is enforced on every route when set', async () => {
  await withServer({ env: { VP_TOKEN: 'tok-123' } }, async (url) => {
    const denied = await fetch(`${url}/health`)
    assert.equal(denied.status, 401)
    assert.equal((await denied.json()).error.code, 'UNAUTHORIZED')

    const wrong = await fetch(`${url}/health`, { headers: { authorization: 'Bearer nope' } })
    assert.equal(wrong.status, 401)

    const allowed = await fetch(`${url}/health`, { headers: { authorization: 'Bearer tok-123' } })
    assert.equal(allowed.status, 200)
    assert.equal((await allowed.json()).ok, true)
  })
})

/* ------------------------------------------------------------------ 8. CLI run */

test('run --selftest passes offline and prints a readable report', async () => {
  const stdout = capture()
  const stderr = capture()
  const code = await run(['--selftest'], { stdout: stdout.stream, stderr: stderr.stream, env: { VP_LLM_API_KEY: 'should-be-ignored' } })
  assert.equal(code, 0)
  assert.equal(stderr.text, '')
  assert.match(stdout.text, /离线自检/)
  assert.match(stdout.text, /全部通过/)
  assert.equal(stdout.text.includes('✘'), false)
})

test('run --help prints usage and exits 0', async () => {
  const stdout = capture()
  const code = await run(['--help'], { stdout: stdout.stream, stderr: capture().stream, env: {} })
  assert.equal(code, 0)
  assert.equal(stdout.text, USAGE)
  assert.match(stdout.text, /--selftest/)
})

test('run rejects a bad invocation with exit code 2 on stderr', async () => {
  const stderr = capture()
  const code = await run(['--bogus'], { stdout: capture().stream, stderr: stderr.stream, env: {} })
  assert.equal(code, 2)
  assert.match(stderr.text, /未知参数/)
})

test('run prints plain text by default and {polished,tip,gaps} with --json', async () => {
  const reply = '{"polished":"整理后的文本","tip":"建议","gaps":["缺口"]}'
  const env = { VP_LLM_API_KEY: 'test-key', DSH_HOME: path.join(os.tmpdir(), 'vp-test-home-absent') }

  const plainOut = capture()
  const plainCode = await run(['呃 那个 文本'], { stdout: plainOut.stream, stderr: capture().stream, env, fetchImpl: fakeChat(reply) })
  assert.equal(plainCode, 0)
  assert.equal(plainOut.text, '整理后的文本\n')

  const jsonOut = capture()
  const jsonCode = await run(['--json', '文本'], { stdout: jsonOut.stream, stderr: capture().stream, env, fetchImpl: fakeChat(reply) })
  assert.equal(jsonCode, 0)
  assert.deepEqual(JSON.parse(jsonOut.text), { polished: '整理后的文本', tip: '建议', gaps: ['缺口'] })
})

test('run reads stdin with "-"', async () => {
  const stdout = capture()
  const stdin = Readable.from([Buffer.from('来自 stdin 的文本', 'utf8')])
  const code = await run(['-'], {
    stdout: stdout.stream,
    stderr: capture().stream,
    env: { VP_LLM_API_KEY: 'test-key', DSH_HOME: path.join(os.tmpdir(), 'vp-test-home-absent') },
    stdin,
    fetchImpl: fakeChat('{"polished":"来自 stdin","tip":"","gaps":[]}'),
  })
  assert.equal(code, 0)
  assert.equal(stdout.text, '来自 stdin\n')
})

test('run reports a missing API key on stderr with a non-zero exit', async () => {
  const stderr = capture()
  const code = await run(['文本'], { stdout: capture().stream, stderr: stderr.stream, env: {} })
  assert.equal(code, 1)
  assert.match(stderr.text, /VP_LLM_API_KEY/)
})

test('run on an audio file reports that ASR is not wired (exit 3)', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'vp-cli-'))
  try {
    const wav = path.join(dir, 'sample.wav')
    writeFileSync(wav, Buffer.from('RIFF....WAVEfmt '))
    const stderr = capture()
    const code = await run([wav], {
      stdout: capture().stream,
      stderr: stderr.stream,
      env: { VP_LLM_API_KEY: 'test-key' },
    })
    assert.equal(code, 3)
    assert.match(stderr.text, /尚未接入/)

    const missing = capture()
    const missingCode = await run([path.join(dir, 'nope.wav')], { stdout: capture().stream, stderr: missing.stream, env: {} })
    assert.equal(missingCode, 1)
    assert.match(missing.text, /音频文件不存在/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('CLI audio path runs end to end once cloud ASR is configured', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'vp-cli-cloud-'))
  try {
    const wav = path.join(dir, 'recording.wav')
    writeFileSync(wav, Buffer.from('RIFF....WAVEfmt '))

    // Transcribe + polish: prints the polished text.
    const transcript = '呃 那个 我想加缓存'
    const stdout = capture()
    const transport = fakePipeline({ transcript })
    const code = await run([wav], { stdout: stdout.stream, stderr: capture().stream, env: cloudEnv(), fetchImpl: transport })
    assert.equal(code, 0)
    assert.equal(stdout.text, '整理后\n')

    const asrCall = transport.record.find((call) => call.url.endsWith('/audio/transcriptions'))
    const raw = Buffer.from(asrCall.init.body).toString('utf8')
    assert.ok(raw.includes('name="file"; filename="recording.wav"'))
    assert.ok(raw.includes('Content-Type: audio/wav'))

    // --json carries the transcript alongside the polish.
    const jsonOut = capture()
    const jsonCode = await run(['--json', wav], { stdout: jsonOut.stream, stderr: capture().stream, env: cloudEnv(), fetchImpl: fakePipeline({ transcript }) })
    assert.equal(jsonCode, 0)
    assert.deepEqual(JSON.parse(jsonOut.text), { raw: transcript, polished: '整理后', tip: '建议', gaps: [] })

    // --transcript stops before the LLM, so no LLM key is required.
    const rawOut = capture()
    const rawCode = await run(['--transcript', wav], {
      stdout: rawOut.stream,
      stderr: capture().stream,
      env: { VP_ASR: 'cloud', VP_ASR_BASE_URL: 'http://asr.test/v1', VP_ASR_API_KEY: 'asr-key' },
      fetchImpl: fakePipeline({ transcript }),
    })
    assert.equal(rawCode, 0)
    assert.equal(rawOut.text, `${transcript}\n`)

    // Cloud selected but unconfigured: exit 3, message names the variable.
    const errOut = capture()
    const errCode = await run([wav], { stdout: capture().stream, stderr: errOut.stream, env: { VP_ASR: 'cloud' } })
    assert.equal(errCode, 3)
    assert.match(errOut.text, /VP_ASR_API_KEY/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('mimeTypeFor maps audio extensions for the multipart part', () => {
  assert.equal(mimeTypeFor('a.wav'), 'audio/wav')
  assert.equal(mimeTypeFor('a.mp3'), 'audio/mpeg')
  assert.equal(mimeTypeFor('a.m4a'), 'audio/mp4')
  assert.equal(mimeTypeFor('a.flac'), 'audio/flac')
  assert.equal(mimeTypeFor('a.unknown'), 'audio/wav')
})

test('run --asr-check reports capabilities offline and never transcribes', async () => {
  const localOut = capture()
  const localCode = await run(['--asr-check', 'local'], { stdout: localOut.stream, stderr: capture().stream, env: {} })
  assert.equal(localCode, 1, 'local ASR is not ready in P1')
  assert.match(localOut.text, /离线/)
  assert.match(localOut.text, /未做任何转写|尚未接入/)
  assert.match(localOut.text, /model\.int8\.onnx/)

  const cloudOut = capture()
  const cloudCode = await run(['--asr-check', 'cloud'], { stdout: cloudOut.stream, stderr: capture().stream, env: { VP_ASR_API_KEY: 'k' } })
  assert.equal(cloudCode, 0, 'cloud is wired and configured')
  assert.match(cloudOut.text, /配置齐备：是/)
  assert.match(cloudOut.text, /就绪：是/)

  const noKeyOut = capture()
  const noKeyCode = await run(['--asr-check', 'cloud'], { stdout: noKeyOut.stream, stderr: capture().stream, env: {} })
  assert.equal(noKeyCode, 1)
  assert.match(noKeyOut.text, /配置齐备：否/)
  assert.match(noKeyOut.text, /VP_ASR_API_KEY/)

  const stderr = capture()
  const badCode = await run(['--asr-check', 'nope'], { stdout: capture().stream, stderr: stderr.stream, env: {} })
  assert.equal(badCode, 2)
  assert.match(stderr.text, /未知的 ASR 提供者/)
})
