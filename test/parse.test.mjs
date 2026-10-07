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
