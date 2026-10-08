/**
 * Source-level contract tests for the browser half.
 *
 * These exist because three defects reached users and none of them was catchable
 * by running the plugin — they were structural:
 *
 *   1. a tab registration that was not owned by `ctx.effect`, so a reloaded
 *      instance collided with its predecessor's id and the panel lost its host;
 *   2. a tab body written as an INLINE COPY of the dock panel, which drifted and
 *      lost its visibility rule, so an idle panel rendered as a blank tab;
 *   3. visibility keyed on a prop only one host passed, which put the panel on
 *      screen in one host and nowhere in the others.
 *
 * There is no DOM here and no bundler: the assertions read `lib/client.js` as
 * text. That is deliberate — it is the only layer at which "the registration is
 * inside an effect" and "both hosts render the same component" are expressible.
 *
 * Run with: node --test test/client-contract.test.mjs
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const CLIENT = path.join(here, '..', 'lib', 'client.js')
const SOURCE = readFileSync(CLIENT, 'utf8')

/** Count non-overlapping matches of a global regex. */
function count(re) {
  return (SOURCE.match(new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`)) ?? []).length
}

/**
 * Extract one function's source by brace balancing. Good enough for this file:
 * the regions under test contain no braces inside strings or comments.
 * @param {string} name - function name.
 * @returns {string} the function source, `function name(…) { … }`.
 */
function functionSource(name) {
  const start = SOURCE.indexOf(`function ${name}(`)
  assert.notEqual(start, -1, `lib/client.js must define function ${name}()`)
  let depth = 0
  for (let i = SOURCE.indexOf('{', start); i < SOURCE.length; i += 1) {
    if (SOURCE[i] === '{') depth += 1
    else if (SOURCE[i] === '}') {
      depth -= 1
      if (depth === 0) return SOURCE.slice(start, i + 1)
    }
  }
  throw new Error(`unbalanced braces while reading function ${name}()`)
}

/**
 * Remove `//` and comment… block comments while leaving string literals alone, so
 * an "absence" assertion is about code and not about prose that names the thing.
 * @param {string} source - js source slice.
 * @returns {string} the same slice without comments.
 */
function stripComments(source) {
  let out = ''
  let quote = null
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i]
    const next = source[i + 1]
    if (quote !== null) {
      out += ch
      if (ch === '\\') {
        out += next ?? ''
        i += 1
      } else if (ch === quote) quote = null
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch
      out += ch
      continue
    }
    if (ch === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') i += 1
      out += '\n'
      continue
    }
    if (ch === '/' && next === '*') {
      i += 2
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i += 1
      i += 1
      continue
    }
    out += ch
  }
  return out
}

/* --------------------------------------------------- build stamp / identity */

test('the client bundle carries a build stamp and shows it in the panel', () => {
  // The contract is that a stamp EXISTS, is logged on load, and is rendered in
  // the panel — not that it holds one particular value. Pinning the literal made
  // every rev bump fail this test, which is a false alarm, not a regression.
  assert.match(SOURCE, /const CLIENT_REV = '[A-Za-z0-9._-]+'/)
  assert.match(SOURCE, /log\('client bundle loaded', \{ rev: CLIENT_REV \}\)/)
  assert.match(SOURCE, /客户端 \$\{CLIENT_REV\}/)
})

test('the official tab id is the package name and the kind is stable', () => {
  assert.match(SOURCE, /const OFFICIAL_TAB_ID = 'dsh-voice-polish'/)
  assert.match(SOURCE, /const OFFICIAL_TAB_KIND = 'voice-polish'/)
})

test('the browser half imports nothing from @deepseek-ai', () => {
  // Requirement: the plugin talks to injected service NAMES only. A runtime
  // import of an official package would make the bundle depend on a version of
  // DSH it was not built against.
  assert.equal(/@deepseek-ai/.test(SOURCE), false)
  assert.equal(/^\s*import\s/m.test(SOURCE), false, 'the client half is a plain module, not an ESM import graph')
})

/* ------------------------------------------- defect 1: effect-owned lifetime */

test('the official tab-type registration is wrapped in ctx.effect', () => {
  assert.match(
    SOURCE,
    /\.effect\(\s*\(\)\s*=>\s*[\w.]*sidebarRightTabs\.register\(/,
    'sidebarRightTabs.register must be called INSIDE an effect, so the type lives exactly as long as the plugin',
  )
})

test('the legacy better-sidebar registration is wrapped in ctx.effect too', () => {
  assert.match(
    SOURCE,
    /\.effect\(\s*\(\)\s*=>\s*[\w.]*registerTab\(/,
    'the better-sidebar tab must also be registered inside an effect',
  )
})

test('no tab registration escapes an effect', () => {
  // One call each, and the same number of effect-wrapped calls: if a second call
  // is ever added outside an effect, these counts stop agreeing.
  assert.equal(count(/sidebarRightTabs\.register\(/), 1)
  assert.equal(count(/\.effect\(\s*\(\)\s*=>\s*[\w.]*sidebarRightTabs\.register\(/), 1)
  assert.equal(count(/\.registerTab\(/), 1)
  assert.equal(count(/\.effect\(\s*\(\)\s*=>\s*[\w.]*registerTab\(/), 1)
})

test('a duplicate id is reused rather than re-registered', () => {
  // Both registries throw on an id they already hold, and a throw that escapes
  // leaves the panel with no host at all.
  const applySource = functionSource('apply')
  assert.match(applySource, /tabs\.get\(OFFICIAL_TAB_KIND\) !== undefined/)
  assert.match(applySource, /service\.getTab\(VOICE_TAB_ID\)/)
})

test('a context without effect() degrades to the dock instead of registering bare', () => {
  const applySource = functionSource('apply')
  assert.equal(count(/typeof (officialCtx|bctx)\.effect !== 'function'/), 2)
  assert.ok(applySource.includes("typeof officialCtx.effect !== 'function'"))
  assert.ok(applySource.includes("typeof bctx.effect !== 'function'"))
})

/* ---------------------------------------- defect 2: one shared body component */

test('all three hosts render the same PanelBody component', () => {
  assert.equal(count(/function PanelBody\(/), 1, 'there must be exactly one panel body')
  for (const host of ['PolishPanel', 'SidebarPanelTab', 'OfficialPanelTab']) {
    const body = functionSource(host)
    assert.match(body, /h\(PanelBody, \{/, `${host} must render the shared PanelBody, not an inline copy`)
  }
})

test('the official seat registers the shared component for body and title', () => {
  assert.match(SOURCE, /officialCtx\.slots\.inject\('sidebar\.right\.pane\.tab',/)
  assert.match(SOURCE, /officialCtx\.slots\.inject\('sidebar\.right\.pane\.tab\.title',/)
  assert.equal(count(/key: OFFICIAL_TAB_ID/g), 2, 'both keyed seat registrations bind the same tab id')
  assert.match(SOURCE, /OfficialPanelTab,/)
  assert.match(SOURCE, /OfficialPanelTitle,/)
})

/* ---------------------------- defect 3: visibility is a rule, not a host prop */

test('no host-only visibility flag exists any more', () => {
  assert.equal(/alwaysVisible/.test(stripComments(SOURCE)), false, 'alwaysVisible was a no-op that masked a drifted copy')
})

test('the dock opts into hiding and every sidebar host renders by default', () => {
  const body = functionSource('PanelBody')
  // Opt-IN for the dock only: absent (or false) dockMode means "render".
  assert.match(body, /props\.dockMode === true \?/)
  assert.match(body, /props\.dockMode === true \? [^\n]*: true/)
  assert.match(body, /if \(!visible\) return null/)

  assert.match(functionSource('PolishPanel'), /dockMode: true/)
  // A sidebar host must NOT pass it: an idle panel still has to draw something.
  assert.equal(/dockMode/.test(stripComments(functionSource('SidebarPanelTab'))), false)
  assert.equal(/dockMode/.test(stripComments(functionSource('OfficialPanelTab'))), false)
})

test('the official body always renders the panel, never an empty pane', () => {
  const body = functionSource('OfficialPanelTab')
  assert.match(body, /h\(PanelBody, \{/)
  // The only early return is the no-session guidance, which is itself content.
  assert.match(body, /没有活动会话/)
  // It reads the framework-injected session + tab record.
  assert.match(body, /props\?\.sessionId/)
  assert.match(body, /readTabInfo\(props\)/)
})

/* ----------------------------------------- three hosts, one visible at a time */

test('host priority is official → better-sidebar → dock, and is readable in the source', () => {
  const applySource = functionSource('apply')
  const officialAt = applySource.indexOf("ctx.inject(['slots', 'sidebarRightTabs', 'sidebarRight']")
  const betterAt = applySource.indexOf("ctx.inject(['betterSidebar']")
  assert.notEqual(officialAt, -1, 'the official sidebar injection must exist')
  assert.notEqual(betterAt, -1, 'the better-sidebar injection must exist')
  assert.ok(officialAt < betterAt, 'the official host is wired before the legacy one')

  assert.match(SOURCE, /let panelHost = 'dock'/)
  assert.match(SOURCE, /function currentHost\(\)/)
  const host = functionSource('currentHost')
  assert.match(host, /if \(revealFailed\) return 'dock'/)
  assert.match(host, /return panelHost/)
})

test('a second host can never draw a second panel', () => {
  // The legacy host never registers while the official services are present…
  assert.match(functionSource('apply'), /officialSidebarAvailable\(bctx\)/)
  assert.match(functionSource('officialSidebarAvailable'), /sidebarRightTabs/)
  assert.match(functionSource('officialSidebarAvailable'), /sidebarRight/)
  // …the dock yields to whichever sidebar host owns the panel…
  assert.match(functionSource('PolishPanel'), /if \(currentHost\(\) !== 'dock'\) return null/)
  // …and the legacy tab body yields to the official one.
  assert.match(functionSource('SidebarPanelTab'), /if \(panelHost === 'official'\) return null/)
})

test('revealing the panel prefers the official host and names its kind', () => {
  const open = functionSource('openPanelTab')
  const officialAt = open.indexOf("panelHost === 'official'")
  const betterAt = open.indexOf("panelHost !== 'better'")
  assert.notEqual(officialAt, -1, 'the official branch must exist')
  assert.notEqual(betterAt, -1, 'the legacy branch must exist')
  assert.ok(officialAt < betterAt, 'the official host is tried first')
  assert.match(open, /openTab\(OFFICIAL_TAB_KIND\)/)
  // A failed reveal must hand the panel to the dock rather than nowhere.
  assert.match(open, /revealFailed = true/)
})

/* ------------------------------------------------------- the discovery entry */

test('the guide entry that makes the panel discoverable is an array entry', () => {
  // The shipped implementation reads `definition.guide ?? []` and maps it, and
  // three official plugins register arrays. An object shape registers silently
  // but never appears in the guide — i.e. the panel would not be discoverable.
  assert.match(SOURCE, /guide:\s*\[/)
  assert.match(SOURCE, /id: 'voice-polish',\s*\n\s*order: 45,/)
  assert.match(SOURCE, /title: \(\) => '语音整理'/)
  assert.match(SOURCE, /description: \(\) =>/)
})

test('the official definition carries the fields the registry reads', () => {
  const applySource = functionSource('apply')
  assert.match(applySource, /id: OFFICIAL_TAB_ID,/)
  assert.match(applySource, /kind: OFFICIAL_TAB_KIND,/)
  assert.match(applySource, /priority: 'extension'/)
  assert.match(applySource, /title: \(\) => '语音整理'/)
  assert.match(applySource, /keepMounted: true/)
})
