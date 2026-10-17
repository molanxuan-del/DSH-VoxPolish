/**
 * Regression tests for the model-output parser.
 *
 * `parseAnswer` is the one piece of this plugin that has to survive a hostile
 * input: an LLM reply that is *almost* JSON. The field report that produced
 * `salvageAnswer` was a real recording where the model quoted a phrase with
 * unescaped ASCII quotes inside a string value — strict `JSON.parse` threw, and
 * the old fallback dumped the whole raw JSON on the user. Every case below is
 * either that bug or the boundary next to it.
 *
 * Run with: npm test   (or: node --test test/parse.test.mjs)
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { parseAnswer } from '../lib/index.js'

test('parses a well-formed reply', () => {
  const result = parseAnswer('{"polished":"整理后的内容","tip":"建议","gaps":["甲","乙"]}')
  assert.equal(result.polished, '整理后的内容')
  assert.equal(result.tip, '建议')
  assert.deepEqual(result.gaps, ['甲', '乙'])
})

test('parses a reply wrapped in a Markdown fence', () => {
  const result = parseAnswer('```json\n{"polished":" fenced case","tip":"","gaps":[]}\n```')
  assert.equal(result.polished, 'fenced case')
  assert.deepEqual(result.gaps, [])
})

test('salvages a reply whose tip quotes a phrase with unescaped ASCII quotes', () => {
  // Verbatim from a real recording: the inner quotes around 不与rr底层耦合 were
  // emitted raw, so this is not valid JSON.
  const raw =
    '{"polished":"查看这个项目，在图中画出一块区域。在此基础上做导航相关的、抽象层面的点位间路网规划，包括动态避障，以及路线被挡住后的处理逻辑。注意：这些不要与 rr 等底层耦合，是纯上层的抽象实现。","tip":""不与rr底层耦合"前面有几次自我更正，可先说完耦合关系再说需求，结构会更清楚。","gaps":["画出区域用什么格式/工具？","点位数据从哪来？","输出形式：代码还是方案？"]}'

  const result = parseAnswer(raw)
  assert.ok(result.polished.startsWith('查看这个项目'))
  assert.ok(result.polished.endsWith('是纯上层的抽象实现。'))
  // The raw JSON must never leak into what the user sends.
  assert.ok(!result.polished.includes('"polished"'))
  assert.ok(result.tip.includes('自我更正'))
  assert.equal(result.gaps.length, 3)
})

test('salvages unescaped quotes inside the polished value', () => {
  const raw =
    '{"polished":"把「src/index.ts"里的 main"函数改成 async","tip":"两处引号是识别噪音","gaps":[]}'
  const result = parseAnswer(raw)
  assert.ok(result.polished.includes('改成 async'))
  assert.ok(!result.polished.includes('"polished"'))
})

test('never throws, even on input that is not JSON at all', () => {
  const result = parseAnswer('这不是 JSON，只是一段普通文本。')
  assert.equal(typeof result.polished, 'string')
  assert.deepEqual(result.gaps, [])
})

test('tolerates an empty reply', () => {
  const result = parseAnswer('')
  assert.equal(result.polished, '')
  assert.deepEqual(result.gaps, [])
})

/* ------------------------------------------------ 需求分析 / 领域名词 (c9) */

test('carries the teaching fields through a well-formed reply', () => {
  const result = parseAnswer(
    '{"polished":"整理后的内容","tip":"建议","gaps":["甲"],"analysis":"你真正想要的是把面板更新一下。","terms":["DSH —— DeepSeek Harness，运行插件的宿主；在你的需求里负责承载面板"]}',
  )
  assert.equal(result.polished, '整理后的内容')
  assert.equal(result.analysis, '你真正想要的是把面板更新一下。')
  assert.deepEqual(result.terms, ['DSH —— DeepSeek Harness，运行插件的宿主；在你的需求里负责承载面板'])
})

test('missing teaching fields degrade to an empty string and an empty array', () => {
  const result = parseAnswer('{"polished":"只有旧字段","tip":"","gaps":[]}')
  assert.equal(result.analysis, '')
  assert.deepEqual(result.terms, [])
})

test('ill-typed or dirty terms never throw and never reach the user raw', () => {
  const notArray = parseAnswer('{"polished":"P","analysis":7,"terms":{"a":1}}')
  assert.equal(notArray.analysis, '')
  assert.deepEqual(notArray.terms, [])

  const mixed = parseAnswer('{"polished":"P","terms":["A —— 甲","","   ",null,"B —— 乙"]}')
  assert.deepEqual(mixed.terms, ['A —— 甲', 'B —— 乙'])
})

test('salvage still recovers terms when a value keeps an unescaped ASCII quote', () => {
  const raw =
    '{"polished":"把「main」改成 async","tip":"这里 "引号" 是识别噪音","gaps":[],"analysis":"你真正想要的是重构 "入口" 函数。","terms":["async —— 异步；在你的需求里让函数不阻塞","RR —— 位姿；负责定位"]}'
  const result = parseAnswer(raw)
  assert.equal(result.terms.length, 2)
  assert.ok(result.terms[1].startsWith('RR'))
  assert.equal(result.polished.includes('"polished"'), false)
})

test('the teaching content never leaks into polished', () => {
  const result = parseAnswer(
    '{"polished":"把函数改成异步","tip":"","gaps":[],"analysis":"你真正想要的是异步化","terms":["async —— 异步；负责不阻塞"]}',
  )
  assert.equal(result.polished, '把函数改成异步')
  assert.equal(result.polished.includes('你真正想要的是'), false)
  assert.equal(result.polished.includes('async'), false)
})
