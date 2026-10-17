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
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

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

/* ------------------------------- terms 三段式：解析器不动，拆分只在客户端 (c10) */

test('a three-part ｜ term survives the strict parser untouched', () => {
  const entry = 'FLIP 动画｜列表重排、筛选时元素平滑移动不闪烁｜iOS 主屏图标重排的顺滑感'
  const result = parseAnswer(
    `{"polished":"把界面做顺","tip":"","gaps":[],"analysis":"你真正想要的是动起来更顺的界面。","terms":["${entry}"]}`,
  )
  // The parser deliberately does NOT split: the wire format stays an array of
  // plain strings, and splitting happens in the client renderer.
  assert.deepEqual(result.terms, [entry])
  assert.equal(result.terms[0].split('｜').length, 3)
  assert.equal(result.analysis, '你真正想要的是动起来更顺的界面。')
})

test('three-part terms are filtered and capped exactly like any other entry', () => {
  const good = '虚拟列表｜几千条数据滚动也不掉帧｜苹果相册无限滚动的流畅度'
  const mixed = parseAnswer(`{"polished":"P","terms":["${good}","","   ",null,7,{"a":1}]}`)
  assert.deepEqual(mixed.terms, [good])

  const many = parseAnswer(
    `{"polished":"P","terms":${JSON.stringify(Array.from({ length: 8 }, (_, i) => `T${i}｜效果${i}｜类似${i}`))}}`,
  )
  assert.equal(many.terms.length, 6, 'the prompt cap of 6 is still enforced')
  assert.ok(many.terms.every((entry) => entry.split('｜').length === 3))
})

test('salvage keeps a three-part term when an unrelated value carries a stray quote', () => {
  const raw =
    '{"polished":"把「main」改成 async","tip":"这里 "引号" 是识别噪音","gaps":[],"analysis":"你真正想要的是让界面更顺。","terms":["FLIP 动画｜平滑移动不闪烁｜iOS 主屏的顺滑感"]}'
  const result = parseAnswer(raw)
  assert.equal(result.terms.length, 1)
  assert.equal(result.terms[0].split('｜').length, 3)
  assert.equal(result.polished.includes('FLIP'), false)
})

/* --------------------------- 客户端三段切分（源码级：lib/client.js 无法被 import） */

const here = path.dirname(fileURLToPath(import.meta.url))
const CLIENT_SOURCE = readFileSync(path.join(here, '..', 'lib', 'client.js'), 'utf8')

/**
 * Extract one function's source by brace balancing — the same technique
 * test/client-contract.test.mjs uses, because the browser half has no export.
 * @param {string} name - function name.
 * @returns {string} the function source.
 */
function functionSource(name) {
  const start = CLIENT_SOURCE.indexOf(`function ${name}(`)
  assert.notEqual(start, -1, `lib/client.js must define function ${name}()`)
  let depth = 0
  for (let i = CLIENT_SOURCE.indexOf('{', start); i < CLIENT_SOURCE.length; i += 1) {
    if (CLIENT_SOURCE[i] === '{') depth += 1
    else if (CLIENT_SOURCE[i] === '}') {
      depth -= 1
      if (depth === 0) return CLIENT_SOURCE.slice(start, i + 1)
    }
  }
  throw new Error(`unbalanced braces while reading function ${name}()`)
}

const client = new Function(
  `${['stripTermLabel', 'splitTerm', 'termItems'].map(functionSource).join('\n')}\nreturn { splitTerm, termItems }`,
)()

test('the client splits a three-part ｜ entry into 名词 / 效果 / 类似', () => {
  const parts = client.splitTerm('FLIP 动画｜效果：列表重排时元素平滑移动不闪烁｜类似：iOS 主屏图标重排的顺滑感')
  assert.equal(parts.term, 'FLIP 动画')
  // The label the model was asked to write is stripped: the renderer draws its own.
  assert.equal(parts.effect, '列表重排时元素平滑移动不闪烁')
  assert.equal(parts.similar, 'iOS 主屏图标重排的顺滑感')
  assert.equal(parts.rest, '')
})

test('the client also cuts on a half-width | and keeps a stray extra separator', () => {
  const halfWidth = client.splitTerm('虚拟列表|滚动不掉帧|苹果相册的流畅度')
  assert.equal(halfWidth.term, '虚拟列表')
  assert.equal(halfWidth.effect, '滚动不掉帧')
  assert.equal(halfWidth.similar, '苹果相册的流畅度')

  // More than three segments: still at most three lines, and no words are lost.
  const extra = client.splitTerm('a|b|c|d')
  assert.equal(extra.term, 'a')
  assert.equal(extra.effect, 'b')
  assert.equal(extra.similar, 'c｜d')
})

test('the client degrades instead of throwing: two segments, one segment, garbage', () => {
  // Two: 名词 + 解释 — the older shape, still rendered.
  const two = client.splitTerm('DSH｜运行插件的宿主')
  assert.equal(two.term, 'DSH')
  assert.equal(two.rest, '运行插件的宿主')
  assert.equal(two.effect, '')
  assert.equal(two.similar, '')

  // One: shown whole, and the panel never guesses which half is the term.
  const one = client.splitTerm('RR 位姿与路网')
  assert.equal(one.term, '')
  assert.equal(one.rest, 'RR 位姿与路网')
  assert.equal(one.effect, '')
  assert.equal(one.similar, '')

  // Nothing usable — empty, blank, missing separator inside an empty middle.
  for (const value of ['', '   ', null, undefined, '｜', '甲｜｜乙']) {
    const parts = client.splitTerm(value)
    assert.equal(typeof parts.term, 'string')
    assert.equal(typeof parts.rest, 'string')
    assert.equal(typeof parts.effect, 'string')
    assert.equal(typeof parts.similar, 'string')
  }
  assert.equal(client.splitTerm('甲｜｜乙').term, '甲')
  assert.equal(client.splitTerm('甲｜｜乙').effect, '')
  assert.equal(client.splitTerm('甲｜｜乙').similar, '乙')
})

test('the client drops blank and non-string term entries before rendering', () => {
  const good = 'FLIP 动画｜效果：平滑移动不闪烁｜类似：iOS 主屏的顺滑感'
  const rows = client.termItems([good, '', '   ', null, 7, undefined, { a: 1 }, '只有一句'])
  assert.equal(rows.length, 2)
  assert.equal(rows[0].term, 'FLIP 动画')
  assert.equal(rows[0].similar, 'iOS 主屏的顺滑感')
  assert.deepEqual(rows[1], { key: 7, term: '', effect: '', similar: '', rest: '只有一句' })
  // Original index survives as the render key, so a dropped entry cannot re-key one.
  assert.deepEqual(rows.map((row) => row.key), [0, 7])

  assert.deepEqual(client.termItems('不是一个数组'), [])
  assert.deepEqual(client.termItems(undefined), [])
  assert.equal(client.termItems(['   ', '']).length, 0)
})
