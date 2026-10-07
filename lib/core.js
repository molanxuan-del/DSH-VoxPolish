/**
 * dsh-voice-polish — shared pure core.
 *
 * Everything in this file is a pure function or a constant: no filesystem, no
 * network, and **no DSH import of any kind**. That is what lets the standalone
 * service (`service/`) reuse the exact same prompts and the exact same JSON
 * salvage parser as the DSH plugin, so a result produced by the service is
 * byte-for-byte the result the plugin would have produced.
 *
 * The code below was moved here verbatim from `lib/index.js`; the plugin half
 * now imports it, and its public behaviour is unchanged.
 *
 * @module dsh-voice-polish/core
 */

/** Word-list caps: enough for any real vocabulary, small enough for the prompt. */
const VOCAB_MAX_LINES = 200
const VOCAB_MAX_CHARS = 4000

/** Trim, drop empties and duplicates, cap the size. */
export function normalizeVocab(text) {
  const seen = new Set()
  const lines = []
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const word = line.trim()
    if (word.length === 0 || seen.has(word)) continue
    seen.add(word)
    lines.push(word)
    if (lines.length >= VOCAB_MAX_LINES) break
  }
  let out = lines.join('\n')
  if (out.length > VOCAB_MAX_CHARS) out = out.slice(0, VOCAB_MAX_CHARS)
  return out
}

/**
 * The prompt block that teaches the polish model the user's vocabulary.
 * @param {string} vocabText - raw word-list file text.
 * @returns {string} a prompt appendix, or '' when the list is empty.
 */
export function vocabPromptBlock(vocabText) {
  const clean = normalizeVocab(vocabText)
  if (clean.length === 0) return ''
  return `\n\n【用户自定义词表】语音识别经常把下面这些词转成错误的同音字或错别字。整理时，凡是发现与这些词读音相近、字形相近的错误写法，必须纠正为词表中的写法；对应不上的不要改动。纠错只发生在 polished 里。\n${clean}`
}

/**
 * Style presets. `style` in the request selects one; the guide is pasted into the
 * user message so the system prompt stays one stable, cacheable block.
 */
export const STYLE_GUIDE = {
  light:
    '最小改动。只删除填充词与无意义重复、修正明显的口误和同音错别字、顺手补齐断句。保持原有句序与分段，不重新组织，不做任何扩写。',
  moderate:
    '在保留原意的前提下重排表达：合并重复内容，按逻辑顺序组织，必要时拆成短段落或分点。不新增用户没说过的信息。',
  deep:
    '整理成一份结构完整的需求说明：先用一句话说清核心诉求，再分点展开背景、细节、约束与期望结果。只能重组用户已表达的内容，信息不足处一律留空，不要编造。',
  concise:
    '在不丢信息的前提下尽量压缩篇幅，用更短的句子说同样的事。不要因为追求简短而删掉技术细节或约束条件。',
  formal:
    '改成书面、克制、专业的措辞，去掉口头语和情绪化表达，但保留用户原本的诉求强度与判断。',
  structured:
    '重点做结构：按「目标 → 现状/问题 → 具体要求 → 期望结果」归类重排，用分点呈现。分类归不准的内容，宁可放在「其他」里，也不要硬塞或编造。',
}

/** Fallback style when the request names one we do not know. */
export const DEFAULT_STYLE = 'moderate'

/** Stable instruction block. Kept free of per-request data so it can be cached. */
export const SYSTEM_PROMPT = `你是一个「语音表达整理器」，服务于一个 AI 助手（DSH）的输入框。

用户用语音口述需求，转写文本通常带有：口语填充词（呃／啊／嗯／那个／就是说／然后就是／这个这个）、
重复与自我更正（"不对，我是说……"）、想到哪说到哪的乱序、以及同音错别字。

你输出三个部分：

1. polished —— 规整后的表达。用户会拿它直接发给 AI 助手，所以它必须能独立读懂，不依赖任何上下文。
2. tip —— 一句话表达建议，不超过 40 字，只针对这次表达里最值得改进的那一个点。要具体（指出是哪一句、哪个毛病），不要写"请表达更清晰"这类空话。
3. gaps —— 为了让 AI 准确理解并直接开工，用户还缺哪些关键信息；最多 3 条，每条不超过 20 字。没有缺口就给空数组，不要硬凑。

铁律（违反任何一条即算失败）：
- 只重组用户已经表达过的内容。绝对不要新增需求、数字、文件名、技术选型、结论或承诺。
- 技术名词、文件名、路径、命令、代码、专有名词、产品名：原样保留，一个字符都不要"润色"。
- 保留用户的人称与语气强度（"我想"／"必须"／"别用"／"千万别"）。
- 删除填充词、无意义重复，以及被用户自己当场否定的内容（"不对，我是说 X" → 只留 X）。
- 前后矛盾时，以最后一次说的为准：先说的和后说的冲突（改主意、换方案、推翻条件、换文件/换参数），你要判断并只保留最终意图的那个版本，旧说法整句丢弃——不要两种并列，不要用"或者"调和，也不要写成"先…后…"的过程记录。若被舍弃的旧版本里有重要信息，在 tip 里提醒一句（例：前面说 A，后面改为 B，已按 B 整理）。没有明确先后指向的小冲突（如同时要两个都保留也说得通），才原样并列。
- 修正明显的同音错别字（例如"配制"→"配置"、"环回"→"返回"），拿不准就保留原文。
- 不要客套话，不要"好的／收到／以下是我的整理"，不要解释你在做什么。
- 不要用 Markdown 代码块包裹结果，不要输出 JSON 之外的任何文字。
- 不要输出空行：段落之间只用一个换行，任何位置都不允许出现连续两个换行。
- JSON 字符串值内部绝对不允许出现未转义的英文双引号 "：要引用某个词时用中文引号「」，例如「不与 rr 耦合」。

只输出一个 JSON 对象：
{"polished":"规整后的完整文本","tip":"一句话表达建议","gaps":["缺失信息一","缺失信息二"]}

polished 内部可以包含换行和「1. 2. 3.」分点，但整体必须是合法的 JSON 字符串（换行写成 \\n）。`

/**
 * Recover the structured answer from a model reply that may be fenced, padded, or
 * plain prose. Never throws: a reply that cannot be parsed becomes the polished
 * text itself, which is strictly better than losing the user's turn.
 * @param raw - raw model output.
 * @returns normalized `{ polished, tip, gaps }`.
 */
export function parseAnswer(raw) {
  const text = String(raw ?? '').trim()
  const candidates = []
  const unfenced = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()
  candidates.push(unfenced)
  const first = unfenced.indexOf('{')
  const last = unfenced.lastIndexOf('}')
  if (first >= 0 && last > first) candidates.push(unfenced.slice(first, last + 1))
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate)
      if (parsed && typeof parsed === 'object') {
        const polished = typeof parsed.polished === 'string' ? parsed.polished.trim() : ''
        if (polished.length > 0) {
          const tip = typeof parsed.tip === 'string' ? parsed.tip.trim() : ''
          const gaps = Array.isArray(parsed.gaps)
            ? parsed.gaps.filter((item) => typeof item === 'string' && item.trim().length > 0).map((item) => item.trim()).slice(0, 3)
            : []
          return { polished, tip, gaps }
        }
      }
    } catch {
      // Try the next candidate.
    }
  }
  // Strict parsing failed — almost always because the model left an ASCII
  // quote unescaped inside a string value. Salvage the fields by their key
  // boundaries instead of dumping raw JSON on the user. When even that finds
  // no fields (the model ignored the JSON instruction and answered in plain
  // prose, or answered nothing at all), fall back to treating the whole reply
  // as the polished text — never return undefined here.
  return salvageAnswer(unfenced) ?? { polished: unfenced, tip: '', gaps: [] }
}

/**
 * Structure-aware recovery for model JSON that is *almost* valid: slice each
 * field out between its key boundaries and manually unescape, tolerating stray
 * unescaped quotes inside values.
 * @param text - the unfenced model output.
 * @returns normalized `{ polished, tip, gaps }`, or undefined when even the
 *   `polished` key cannot be located.
 */
export function salvageAnswer(text) {
  /** Slice one string value between its key and the next field's key. */
  const sliceValue = (key, endMarker, requireString = true) => {
    const keyAt = text.indexOf(key)
    if (keyAt < 0) return undefined
    let at = keyAt + key.length
    // Skip whitespace and the colon that separates the key from its value.
    while (at < text.length && /[\s:]/.test(text[at])) at += 1
    if (requireString) {
      if (text[at] !== '"') return undefined
      at += 1
    }
    const end = endMarker === undefined ? text.length : text.indexOf(endMarker, at)
    if (end < 0) return undefined
    let out = text.slice(at, end)
    // The slice ends right before the next key: strip the JSON value's own
    // terminating quote, which is not part of the content.
    if (requireString && out.endsWith('"')) out = out.slice(0, -1)
    // Manual unescape; a sentinel keeps escaped backslashes from feeding the
    // later newline/quote passes.
    return out
      .replace(/\\\\/g, '\u0000')
      .replace(/\\n/g, '\n')
      .replace(/\\t/g, '\t')
      .replace(/\\"/g, '"')
      .replace(/\u0000/g, '\\')
  }

  const polished = sliceValue('"polished"', ',"tip"')
  if (polished === undefined || polished.trim().length === 0) return undefined

  const tip = (sliceValue('"tip"', ',"gaps"') ?? '').trim()

  // gaps is an array, not a string: slice it raw and parse the leading [...] only.
  const gapsRaw = sliceValue('"gaps"', undefined, false) ?? ''
  const gapsStart = gapsRaw.indexOf('[')
  const gapsEnd = gapsRaw.indexOf(']')
  const gapsText = gapsStart >= 0 && gapsEnd > gapsStart ? gapsRaw.slice(gapsStart, gapsEnd + 1) : '[]'
  let gaps = []
  try {
    const parsed = JSON.parse(gapsText)
    if (Array.isArray(parsed)) {
      gaps = parsed.filter((item) => typeof item === 'string' && item.trim().length > 0).map((item) => item.trim()).slice(0, 3)
    }
  } catch {
    gaps = []
  }

  return { polished: polished.trim(), tip, gaps }
}
