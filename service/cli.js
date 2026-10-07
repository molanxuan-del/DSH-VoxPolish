/**
 * dsh-voice-polish service — command line entry.
 *
 *   node service/cli.js "一段口语转写"          → 整理后的纯文本
 *   node service/cli.js --json "文本"           → {"polished","tip","gaps"}
 *   node service/cli.js recording.wav           → 转写 + 整理
 *   cat note.txt | node service/cli.js -        → stdin
 *   node service/cli.js --selftest              → 离线自检，不联网、不需要 key
 *   node service/cli.js --asr-check local       → 只检查 ASR 能力与配置
 *
 * Exit codes: 0 ok · 1 runtime failure · 2 usage error · 3 ASR not wired yet.
 *
 * There is deliberately **no `process.exit()`** anywhere in this file: on Windows
 * a `process.exit()` right after `fetch` trips a libuv assertion
 * (`!(handle->flags & UV_HANDLE_CLOSING)`) and the process dies with 0xC0000409,
 * which destroys the exit code. `process.exitCode` plus a naturally drained event
 * loop is the only correct shape here.
 *
 * @module dsh-voice-polish/service/cli
 */

import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { DEFAULT_STYLE, STYLE_GUIDE, SYSTEM_PROMPT, normalizeVocab, parseAnswer, salvageAnswer, vocabPromptBlock } from '../lib/core.js'
import {
  AsrError,
  DEFAULT_ASR_BASE_URL,
  DEFAULT_ASR_MODEL,
  buildMultipartBody,
  checkAsr,
  parseTranscription,
  resolveAsrProvider,
  transcribeAudio,
} from './asr/index.js'
import {
  DEFAULT_LLM_BASE_URL,
  DEFAULT_LLM_MODEL,
  MAX_INPUT_CHARS,
  buildSystemPrompt,
  buildUserMessage,
  llmConfigStatus,
  polish,
  readVocab,
  resolveLlmConfig,
} from './llm.js'
import { ROUTES } from './server.js'

/** Audio extensions that select file mode without touching the filesystem. */
export const AUDIO_EXTENSIONS = [
  '.wav', '.mp3', '.m4a', '.mp4', '.ogg', '.oga', '.opus',
  '.flac', '.webm', '.aac', '.wma', '.amr', '.aif', '.aiff',
]

/** Printed by --help. */
export const USAGE = `dsh-voice-polish 独立服务 — 语音/文本 → 整理结果

用法
  node service/cli.js "一段口语转写"            整理文本，输出纯文本
  node service/cli.js --json "文本"             输出 {"polished","tip","gaps"}
  node service/cli.js recording.wav             音频文件：转写后整理（--asr 选提供者）
  node service/cli.js --transcript recording.wav  只输出转写原文（不需要 LLM key）
  echo "文本" | node service/cli.js -          从 stdin 读取
  node service/cli.js --selftest                离线自检（不联网、不需要 key）
  node service/cli.js --asr-check local|cloud   只检查 ASR 能力与配置，不发起转写
  node service/cli.js --help                    显示本帮助

选项
  --json                 输出解析后的 {polished,tip,gaps}
  --raw                  把模型原始回复打印到 stderr（调试用）
  --style <名称>         ${Object.keys(STYLE_GUIDE).join(' | ')}（默认 ${DEFAULT_STYLE}）
  --transcript           音频模式下只输出转写原文
  --file <路径>          强制把输入当作音频文件
  --no-vocab             忽略 ~/.dsh/voice-polish/vocab.txt 词表
  --asr <local|cloud>    ASR 提供者（默认取 VP_ASR，再默认 local）
  --model <名称>         覆盖 VP_LLM_MODEL（默认 ${DEFAULT_LLM_MODEL}）
  --base-url <URL>       覆盖 VP_LLM_BASE_URL（默认 ${DEFAULT_LLM_BASE_URL}）
  --api-key <KEY>        覆盖 VP_LLM_API_KEY（建议只用环境变量，避免进入命令历史）
  -h, --help             显示本帮助

环境变量
  VP_LLM_BASE_URL   OpenAI 兼容根地址，默认 ${DEFAULT_LLM_BASE_URL}
  VP_LLM_API_KEY    必填（没有就明确报错，不会静默失败）
  VP_LLM_MODEL      默认 ${DEFAULT_LLM_MODEL}
  VP_ASR            local | cloud，默认 local
  VP_ASR_BASE_URL   云端 ASR 根地址，默认 ${DEFAULT_ASR_BASE_URL}
                    （DeepSeek 没有 /audio/transcriptions，请指向 OpenAI / SiliconFlow /
                      Groq / 本地 whisper server 等兼容服务）
  VP_ASR_API_KEY    云端 ASR 密钥；独立于 VP_LLM_API_KEY，不做回退
  VP_ASR_MODEL      云端 ASR 模型，默认 ${DEFAULT_ASR_MODEL}
  VP_PORT           HTTP 端口，默认 8787（service/server.js）
  VP_TOKEN          可选，设置后 HTTP 需要 Authorization: Bearer <token>

退出码
  0 成功 · 1 运行失败 · 2 用法错误 · 3 ASR 不可用（本地 P2 未接入 / 云端未配置）
`

/** Does this look like an audio path? Extension only — no filesystem access. */
export function looksLikeAudioPath(value) {
  return AUDIO_EXTENSIONS.includes(path.extname(String(value ?? '')).toLowerCase())
}

/** MIME type for a local audio file, by extension. Sent as the multipart part type. */
export function mimeTypeFor(file) {
  switch (path.extname(String(file ?? '')).toLowerCase()) {
    case '.mp3':
      return 'audio/mpeg'
    case '.m4a':
    case '.mp4':
      return 'audio/mp4'
    case '.ogg':
    case '.oga':
    case '.opus':
      return 'audio/ogg'
    case '.flac':
      return 'audio/flac'
    case '.webm':
      return 'audio/webm'
    case '.aac':
      return 'audio/aac'
    case '.wma':
      return 'audio/x-ms-wma'
    case '.amr':
      return 'audio/amr'
    case '.aif':
    case '.aiff':
      return 'audio/aiff'
    default:
      return 'audio/wav'
  }
}

/**
 * Parse CLI argv. Pure and total: it either returns a plain options object or
 * throws a message that belongs on stderr. No filesystem, no network.
 * @param {string[]} [argv] - arguments after the script name.
 * @returns {object} parsed options, including `input` and `mode`.
 * @throws {Error} on an unknown flag, a missing value, or a bad style name.
 */
export function parseArgs(argv = []) {
  const options = {
    json: false,
    raw: false,
    help: false,
    selftest: false,
    transcript: false,
    vocab: true,
    asrCheck: null,
    asr: null,
    style: null,
    model: null,
    baseUrl: null,
    apiKey: null,
  }
  const positional = []
  const takeValue = (index, flag) => {
    const next = argv[index]
    if (next === undefined || (next.startsWith('--') && next.length > 2)) {
      throw new Error(`${flag} 需要一个参数值`)
    }
    return next
  }
  const setStyle = (value, flag) => {
    if (!Object.hasOwn(STYLE_GUIDE, value)) {
      throw new Error(`${flag} 的值「${value}」不是已知风格：只支持 ${Object.keys(STYLE_GUIDE).join(' | ')}`)
    }
    options.style = value
  }

  for (let i = 0; i < argv.length; i += 1) {
    const arg = String(argv[i])
    if (arg === '--json') options.json = true
    else if (arg === '--raw') options.raw = true
    else if (arg === '--help' || arg === '-h') options.help = true
    else if (arg === '--selftest') options.selftest = true
    else if (arg === '--transcript') options.transcript = true
    else if (arg === '--no-vocab') options.vocab = false
    else if (arg === '--style') setStyle(takeValue((i += 1), '--style'), '--style')
    else if (arg.startsWith('--style=')) setStyle(arg.slice('--style='.length), '--style')
    else if (arg === '--asr') options.asr = takeValue((i += 1), '--asr')
    else if (arg.startsWith('--asr=')) options.asr = arg.slice('--asr='.length)
    else if (arg === '--asr-check') options.asrCheck = takeValue((i += 1), '--asr-check')
    else if (arg.startsWith('--asr-check=')) options.asrCheck = arg.slice('--asr-check='.length)
    else if (arg === '--model') options.model = takeValue((i += 1), '--model')
    else if (arg.startsWith('--model=')) options.model = arg.slice('--model='.length)
    else if (arg === '--base-url') options.baseUrl = takeValue((i += 1), '--base-url')
    else if (arg.startsWith('--base-url=')) options.baseUrl = arg.slice('--base-url='.length)
    else if (arg === '--api-key') options.apiKey = takeValue((i += 1), '--api-key')
    else if (arg.startsWith('--api-key=')) options.apiKey = arg.slice('--api-key='.length)
    else if (arg === '--file') {
      options.input = takeValue((i += 1), '--file')
      options.forceFile = true
      positional.push(options.input)
    } else if (arg.startsWith('-') && arg !== '-') {
      throw new Error(`未知参数：${arg}（用 --help 查看用法）`)
    } else positional.push(arg)
  }

  if (positional.length > 1) {
    throw new Error(`只接受一个输入（文本、音频文件路径或 -），收到 ${positional.length} 个`)
  }
  const input = positional.length === 1 ? positional[0] : null
  if (options.forceFile !== true) options.input = input

  const mode = options.help
    ? 'help'
    : options.selftest
      ? 'selftest'
      : options.asrCheck !== null
        ? 'asr-check'
        : input === null
          ? 'none'
          : input === '-'
            ? 'stdin'
            : options.forceFile === true || looksLikeAudioPath(input)
              ? 'file'
              : 'text'

  return { ...options, input, mode }
}

/** Read a whole stream as UTF-8. */
async function readStream(stream) {
  const chunks = []
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
  return Buffer.concat(chunks).toString('utf8')
}

/** Render a capability report as human-readable text. */
function renderAsrReport(report) {
  const yes = (value) => (value ? '是' : '否')
  const lines = [
    'ASR 能力检查（离线：不联网、不发起任何转写）',
    `提供者：${report.provider}`,
    report.engine === undefined ? `模型：${report.model}` : `引擎：${report.engine}（阶段 ${report.phase}）`,
    `已接入：${yes(report.implemented)}`,
    `配置齐备：${yes(report.configured)}`,
    `就绪：${yes(report.ready)}`,
    '检查项：',
  ]
  for (const check of report.checks) lines.push(`  [${check.ok ? '✓' : '×'}] ${check.name}  ${check.detail ?? check.path}`)
  lines.push(`结论：${report.message}`)
  return `${lines.join('\n')}\n`
}

/** `--asr-check`. Configuration only — never a real transcription. */
function runAsrCheck(options, stdout, stderr, { env }) {
  let provider
  try {
    provider = resolveAsrProvider(options.asrCheck, env)
  } catch (error) {
    stderr.write(`错误：${error?.message ?? error}\n`)
    return 2
  }
  const report = checkAsr(provider, { env })
  stdout.write(renderAsrReport(report))
  // "Not ready" is a real answer, not a crash: report it and say so with the code.
  return report.ready ? 0 : 1
}

/** Offline, deterministic self-test: no network, no API key, no model files needed. */
export function runSelftest(stdout, _stderr, { env = {} } = {}) {
  const checks = []
  const record = (name, ok, detail = '') => checks.push({ name, ok: Boolean(ok), detail })

  // 1. the shared core loads and exports the whole frozen surface.
  const coreSurface = ['parseAnswer', 'salvageAnswer', 'normalizeVocab', 'vocabPromptBlock'].every(
    (key) => typeof { parseAnswer, salvageAnswer, normalizeVocab, vocabPromptBlock }[key] === 'function',
  )
  record('core 可加载：解析器/词表工具都是函数', coreSurface)
  record('core 可加载：SYSTEM_PROMPT 非空且足够长', typeof SYSTEM_PROMPT === 'string' && SYSTEM_PROMPT.length > 500, `${SYSTEM_PROMPT.length} 字符`)
  const styleKeys = Object.keys(STYLE_GUIDE)
  record(
    `core 可加载：风格预设齐全（${styleKeys.join(',')}）`,
    styleKeys.length === 6 && styleKeys.includes(DEFAULT_STYLE),
  )

  // 2. the parser on fixed samples — the four classes that matter.
  const strict = parseAnswer('{"polished":"整理后的内容","tip":"建议","gaps":["甲","乙"]}')
  record(
    '解析器：正常 JSON 走严格解析',
    strict.polished === '整理后的内容' && strict.tip === '建议' && strict.gaps.join(',') === '甲,乙',
    JSON.stringify(strict),
  )
  const fenced = parseAnswer('```json\n{"polished":"围栏样例","tip":"","gaps":[]}\n```')
  record('解析器：Markdown 代码围栏', fenced.polished === '围栏样例' && fenced.gaps.length === 0)
  const malformed =
    '{"polished":"查看这个项目，在图中画出一块区域。注意：不要与 rr 耦合。","tip":""不与rr耦合"前面有自我更正。","gaps":["甲？","乙？"]}'
  const salvaged = parseAnswer(malformed)
  record(
    '解析器：畸形 JSON 抢救（未转义引号）',
    salvaged.polished.startsWith('查看这个项目') && !salvaged.polished.includes('"polished"') && salvaged.gaps.length === 2,
    `polished=${JSON.stringify(salvaged.polished.slice(0, 24))}…`,
  )
  const prose = parseAnswer('这不是 JSON，只是一段普通文本。')
  record('解析器：纯散文不丢内容', prose.polished === '这不是 JSON，只是一段普通文本。' && prose.gaps.length === 0)
  const empty = parseAnswer('')
  record('解析器：空串不抛错且为空', empty.polished === '' && empty.tip === '' && empty.gaps.length === 0)

  // 3. message construction — the piece that must match the plugin byte for byte.
  const user = buildUserMessage('样例文本', { style: 'deep' })
  const expectedUser = `【风格要求】${STYLE_GUIDE.deep}\n\n【原始口语转写】\n样例文本`
  record('消息构造：user message 与插件同格式', user === expectedUser, JSON.stringify(user.slice(0, 30)) + '…')
  record('消息构造：未知风格回落 DEFAULT_STYLE', buildUserMessage('x', { style: '不存在' }).includes(STYLE_GUIDE[DEFAULT_STYLE]))
  const system = buildSystemPrompt('甲\n甲\n  乙  \n')
  record(
    '消息构造：system 含词表块且词表已规范化',
    system.startsWith(SYSTEM_PROMPT) && system.includes('【用户自定义词表】') && system.endsWith('甲\n乙'),
  )
  record('消息构造：空词表不附加词表块', buildSystemPrompt('') === SYSTEM_PROMPT)

  // 4. ASR provider resolution + capability reports (offline).
  const asrOk = (() => {
    try {
      return (
        resolveAsrProvider('cloud', {}) === 'cloud' &&
        resolveAsrProvider(undefined, { VP_ASR: 'cloud' }) === 'cloud' &&
        resolveAsrProvider(undefined, {}) === 'local' &&
        resolveAsrProvider('local', { VP_ASR: 'cloud' }) === 'local'
      )
    } catch {
      return false
    }
  })()
  record('ASR：提供者解析（CLI 优先 > VP_ASR > 默认 local）', asrOk)
  const asrRejectsUnknown = (() => {
    try {
      resolveAsrProvider('nope', {})
      return false
    } catch {
      return true
    }
  })()
  record('ASR：未知提供者明确报错', asrRejectsUnknown)
  const localReport = checkAsr('local', { env: {} })
  record(
    'ASR：--asr-check local 离线判定（含模型文件检查）',
    localReport.implemented === false && Array.isArray(localReport.checks) && localReport.checks.length === 3,
    `配置齐备=${localReport.configured} 就绪=${localReport.ready}`,
  )
  const cloudReport = checkAsr('cloud', { env: { VP_ASR_API_KEY: 'x' } })
  record(
    'ASR：--asr-check cloud 只查配置（有 key 即就绪，不发起请求）',
    cloudReport.configured === true &&
      cloudReport.implemented === true &&
      cloudReport.ready === true &&
      cloudReport.endpoint.endsWith('/audio/transcriptions'),
  )
  const noKeyReport = checkAsr('cloud', { env: {} })
  record('ASR：--asr-check cloud 缺 key 时明确报缺哪个变量', noKeyReport.ready === false && noKeyReport.message.includes('VP_ASR_API_KEY'))

  // 4b. the hand-rolled multipart encoder that carries the audio bytes.
  const multipart = buildMultipartBody({
    audio: Buffer.from([0, 1, 2, 255]),
    model: 'whisper-1',
    filename: 'C:\\录音\\样例.wav',
    boundary: 'X-BOUNDARY-X',
  })
  const multipartHead = multipart.body.toString('utf8')
  record(
    'ASR：multipart/form-data 体构造（boundary/字段/二进制原样）',
    multipart.contentType === 'multipart/form-data; boundary=X-BOUNDARY-X' &&
      multipartHead.includes('name="file"; filename="样例.wav"') &&
      multipartHead.includes('name="model"') &&
      multipartHead.includes('whisper-1') &&
      multipartHead.trimEnd().endsWith('--X-BOUNDARY-X--') &&
      multipart.body.includes(Buffer.from([0, 1, 2, 255])),
  )
  const parsedJson = parseTranscription('{"text":"  你好  ","language":"zh","duration":1.5}')
  const parsedPlain = parseTranscription('裸文本转录')
  const emptyThrew = (() => {
    try {
      parseTranscription('')
      return false
    } catch {
      return true
    }
  })()
  record(
    'ASR：云端响应解析（OpenAI JSON / 纯文本 / 空响应报错）',
    parsedJson.text === '你好' &&
      parsedJson.language === 'zh' &&
      parsedJson.durationSeconds === 1.5 &&
      parsedPlain.text === '裸文本转录' &&
      emptyThrew,
  )

  // 5. CLI argument parsing.
  const parseOk = (() => {
    try {
      return (
        parseArgs(['你好']).mode === 'text' &&
        parseArgs(['--json', '你好']).json === true &&
        parseArgs(['--style', 'deep', '你好']).style === 'deep' &&
        parseArgs(['--style=light', '你好']).style === 'light' &&
        parseArgs(['-']).mode === 'stdin' &&
        parseArgs(['a.wav']).mode === 'file' &&
        parseArgs(['--file', 'x']).mode === 'file' &&
        parseArgs(['--asr-check', 'local']).mode === 'asr-check' &&
        parseArgs(['--selftest']).mode === 'selftest' &&
        parseArgs(['--help']).mode === 'help'
      )
    } catch {
      return false
    }
  })()
  record('CLI：参数解析（文本/-/音频/--json/--style/--selftest/--asr-check）', parseOk)
  const throwsOn = (argv) => {
    try {
      parseArgs(argv)
      return false
    } catch {
      return true
    }
  }
  record('CLI：未知参数报错', throwsOn(['--bogus']))
  record('CLI：未知风格报错', throwsOn(['--style', 'nope', 'x']))
  record('CLI：缺少参数值报错', throwsOn(['--style']))
  record('CLI：多个输入报错', throwsOn(['a', 'b']))

  // 6. LLM configuration defaults and the loud missing-key failure.
  const status = llmConfigStatus({ env: {} })
  record(
    'LLM：默认 base url / model',
    status.baseUrl === DEFAULT_LLM_BASE_URL && status.model === DEFAULT_LLM_MODEL && status.keyConfigured === false,
    `${status.baseUrl} · ${status.model}`,
  )
  const keyError = (() => {
    try {
      resolveLlmConfig({ env: {} })
      return ''
    } catch (error) {
      return String(error?.message ?? '')
    }
  })()
  record('LLM：缺 key 明确报错且提示 VP_LLM_API_KEY', keyError.includes('VP_LLM_API_KEY'))
  const cliWins = (() => {
    try {
      const config = resolveLlmConfig({ env: { VP_LLM_API_KEY: 'k', VP_LLM_MODEL: 'env-model' }, model: 'cli-model' })
      return config.model === 'cli-model' && config.sources.model === 'cli'
    } catch {
      return false
    }
  })()
  record('LLM：CLI 参数优先于环境变量', cliWins)

  // 7. the HTTP module loads and exposes exactly the frozen routes.
  const routesOk = Array.isArray(ROUTES) && ROUTES.join(',') === '/health,/polish,/transcribe,/process'
  record(`HTTP：路由表 ${ROUTES.join(' ')}`, routesOk)

  const failed = checks.filter((check) => !check.ok)
  const lines = ['dsh-voice-polish 服务离线自检（不联网、不需要 API key）', '']
  for (const check of checks) lines.push(`${check.ok ? '✔' : '✘'} ${check.name}${check.detail ? `  — ${check.detail}` : ''}`)
  lines.push('', `结果：${checks.length - failed.length}/${checks.length} 通过`)
  if (failed.length > 0) lines.push(`失败项：${failed.map((check) => check.name).join('；')}`)
  else lines.push('全部通过：core / 解析器 / 消息构造 / ASR 提供者 / CLI 参数 / LLM 配置 / HTTP 路由')
  stdout.write(`${lines.join('\n')}\n`)
  return failed.length === 0 ? 0 : 1
}

/**
 * Run the CLI. Returns the exit code instead of exiting, so tests can drive it
 * and so the Windows libuv assertion can never fire.
 * @param {string[]} [argv] - arguments after the script name.
 * @param {object} [io] - injectable streams/env (tests).
 * @returns {Promise<number>} the exit code.
 */
export async function run(argv = process.argv.slice(2), io = {}) {
  const stdout = io.stdout ?? process.stdout
  const stderr = io.stderr ?? process.stderr
  const env = io.env ?? process.env
  const fetchImpl = io.fetchImpl

  let options
  try {
    options = parseArgs(argv)
  } catch (error) {
    stderr.write(`错误：${error?.message ?? error}\n`)
    return 2
  }

  if (options.mode === 'help') {
    stdout.write(USAGE)
    return 0
  }
  if (options.mode === 'selftest') return runSelftest(stdout, stderr, { env })
  if (options.mode === 'asr-check') return runAsrCheck(options, stdout, stderr, { env })
  if (options.mode === 'none') {
    stderr.write('错误：没有输入。\n\n')
    stdout.write(USAGE)
    return 2
  }

  try {
    let text
    let transcript = null

    if (options.mode === 'text') {
      text = options.input
    } else if (options.mode === 'stdin') {
      text = await readStream(io.stdin ?? process.stdin)
    } else {
      const file = path.resolve(options.input)
      if (!existsSync(file)) throw new Error(`音频文件不存在：${file}`)
      const audio = readFileSync(file)
      if (audio.length === 0) throw new Error(`音频文件是空的：${file}`)
      const provider = resolveAsrProvider(options.asr ?? undefined, env)
      const result = await transcribeAudio({
        provider,
        audio,
        env,
        filename: path.basename(file),
        mimeType: mimeTypeFor(file),
        fetchImpl,
      })
      transcript = result.text
      text = result.text
    }

    text = String(text ?? '').trim()
    if (text.length === 0) throw new Error('输入文本为空')
    if (text.length > MAX_INPUT_CHARS) throw new Error(`输入文本超过 ${MAX_INPUT_CHARS} 字符`)

    // `--transcript` stops after ASR: it needs no LLM key at all.
    if (options.transcript && options.mode === 'file') {
      stdout.write(options.json ? `${JSON.stringify({ text: transcript }, null, 2)}\n` : `${transcript}\n`)
      return 0
    }

    const config = resolveLlmConfig({
      env,
      baseUrl: options.baseUrl ?? undefined,
      apiKey: options.apiKey ?? undefined,
      model: options.model ?? undefined,
    })
    const vocabText = options.vocab ? readVocab(env) : ''
    const { value, raw } = await polish({ config, text, style: options.style ?? undefined, vocabText, fetchImpl })

    if (options.raw) stderr.write(`${raw}\n`)
    if (options.json) {
      const payload =
        options.mode === 'file'
          ? { raw: transcript, polished: value.polished, tip: value.tip, gaps: value.gaps }
          : { polished: value.polished, tip: value.tip, gaps: value.gaps }
      stdout.write(`${JSON.stringify(payload, null, 2)}\n`)
    } else {
      stdout.write(`${value.polished}\n`)
    }
    return 0
  } catch (error) {
    stderr.write(`错误：${error?.message ?? error}\n`)
    // 3 = ASR is unavailable for a reason the user can act on (local is still P2,
    // or the cloud provider is not configured). Anything else is a plain runtime
    // failure. Documented in USAGE.
    return error instanceof AsrError ? 3 : 1
  }
}

/**
 * Process entry point. Sets `process.exitCode` and lets the loop drain —
 * never `process.exit()`.
 * @param {string[]} [argv] - arguments after the script name.
 * @returns {Promise<number>} the exit code that was set.
 */
export async function main(argv = process.argv.slice(2)) {
  const code = await run(argv)
  process.exitCode = code
  return code
}

// Only auto-run when this file is the process entry point, so tests can import it.
const entry = process.argv[1]
if (typeof entry === 'string' && import.meta.url === pathToFileURL(entry).href) {
  await main()
}
