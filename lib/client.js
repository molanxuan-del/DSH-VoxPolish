/**
 * dsh-voice-polish — browser half.
 *
 * A self-contained voice-to-request surface. It does NOT read, write, wrap or
 * depend on the composer draft, and it does NOT extend the official voice input
 * plugin: it owns its own microphone button, its own recording, and its own
 * review panel. The browser half keeps zero guarded-service dependencies — no
 * `remote.*` keys, no inject gating — and talks to its own host half over plain
 * HTTP, so it works whether or not any other voice plugin is loaded. The host
 * half is what actually reaches the Host's speech-to-text provider.
 *
 * Flow:
 *
 *     click 🎤  →  record (16 kHz mono PCM)
 *     click 🎤  →  stop → transcribe → polish → review panel opens
 *     the panel's 🎤 continues the same cycle, appending one more segment
 *
 * Everything the user sees lands in this plugin's own editable textarea and
 * leaves through `conversation.send()`; the composer is never involved.
 *
 * The record → transcribe → polish pipeline lives at module scope so the two
 * slot entries (a toolbar button and a dock panel) can share it without React
 * context. Components only render and call in.
 *
 * Module format is the client module loader's lazy CJS contract:
 * `window.__ModuleLoader__.load({ id, factory })`, `factory(require)` returning
 * the exports object that carries `apply`.
 */

window.__ModuleLoader__.load({
  id: 'dsh-voice-polish',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const h = React.createElement
    const { useEffect, useRef, useState, useSyncExternalStore } = React

    /** Routes served by this package's host half. */
    const POLISH_URL = '/dsh-voice-polish/polish'
    const TRANSCRIBE_URL = '/dsh-voice-polish/transcribe'
    const VOCAB_URL = '/dsh-voice-polish/vocab'

    /**
     * The official right-sidebar tab-type id. The registry keys types by id and
     * throws on a duplicate, so it is the package name — one plugin, one id.
     */
    const OFFICIAL_TAB_ID = 'dsh-voice-polish'

    /**
     * The official tab *kind*. `ctx.sidebarRight.openTab(kind)` names this, and a
     * kind nobody registered is a throw, not a silent no-op.
     */
    const OFFICIAL_TAB_KIND = 'voice-polish'

    /** The legacy dsh-better-sidebar tab id (used only when the official host is absent). */
    const VOICE_TAB_ID = 'voice-polish:panel'

    /**
     * Build stamp for this browser half. Rendered inside the panel and logged on
     * load, so "which client bundle is the browser actually running" is a fact
     * you can read off the screen instead of inferring it from a cache.
     */
    const CLIENT_REV = 'c8-inline-hints'

    /** The recogniser accepts exactly one canonical recording shape. */
    const TARGET_SAMPLE_RATE = 16000

    /** Below this, the user almost certainly tapped by accident. */
    const MIN_RECORD_MS = 400

    /**
     * The recogniser's internal server hard-rejects audio over 4 MiB — about
     * 131 seconds of 16 kHz PCM16 — with a bare "Invalid speech audio size".
     * Auto-stop well before that so the user never meets the raw error.
     */
    const MAX_RECORD_MS = 115_000
    const RECORD_LIMIT_SECONDS = 120

    /** How many samples the live waveform keeps on screen. */
    const LEVEL_BARS = 56

    /** Style presets; the host half owns the matching guide text. */
    const STYLES = [
      { id: 'light', label: '轻度', title: '只去填充词、顺句子，几乎不改结构' },
      { id: 'moderate', label: '中度', title: '合并重复、按逻辑重排、必要时分点（默认）' },
      { id: 'deep', label: '深度', title: '整理成结构完整的需求说明' },
      { id: 'concise', label: '更简洁', title: '压缩篇幅，但不丢技术细节' },
      { id: 'formal', label: '更正式', title: '改成书面、克制的措辞' },
      { id: 'structured', label: '更结构化', title: '按「目标 → 问题 → 要求 → 期望」归类' },
    ]

    // ---------------------------------------------------------------------
    // Per-Session state.
    //
    // The microphone button and the review panel are separate slot entries with
    // no shared React context, so state is a module-level immutable store.
    // ---------------------------------------------------------------------

    /** @type {Map<string, object>} */
    const states = new Map()
    /** @type {Set<() => void>} */
    const listeners = new Set()
    /** @type {Map<string, object>} */
    const recorders = new Map()

    /** The client runtime context, captured once the slots injection fires. */
    let clientCtx = null

    /**
     * Which host currently owns the review panel. Exactly ONE may draw it:
     *
     *   'official'  DSH's own right sidebar (`sidebarRightTabs` + `sidebarRight`)
     *   'better'    the third-party dsh-better-sidebar — only when official is absent
     *   'dock'      the in-composer fallback above the input box
     *
     * Priority is official → better → dock, and both the dock seat and the legacy
     * tab body re-check this at render time, so a registration race can never put
     * two copies of the panel on screen.
     */
    let panelHost = 'dock'

    /** True once the legacy BetterSidebar tab is registered (only meaningful while panelHost === 'better'). */
    let sidebarTabReady = false

    /** Tagged console diagnostics for field reports (filter devtools by dsh-voice-polish). */
    const log = (...args) => console.log('[dsh-voice-polish]', ...args)

    /**
     * Send one prompt through the session-scoped conversation service.
     * @param {object} ctx - client runtime context.
     */
    function sendVia(ctx, sessionId, text) {
      const scoped = ctx.get('sessions')?.scope?.(sessionId)
      if (scoped === undefined) throw new Error('会话已不存在，无法发送')
      // `.get()` walks the fiber tree without the inject guard that bare
      // property access trips over; the returned service proxy stays bound
      // to the session scope, which `send` needs to route the turn.
      const conversation = scoped.get?.('conversation') ?? scoped.conversation
      if (conversation === undefined) throw new Error('会话服务不可用，无法发送')
      return conversation.send(text)
    }

    /** Session-routed composer notice; a nicety that must never break the flow. */
    function notifyVia(ctx, sessionId, level, text) {
      try {
        const scoped = ctx.get('sessions')?.scope?.(sessionId)
        const conversation = scoped?.get?.('conversation')
        conversation?.input?.for?.(scoped)?.notify?.(level, text)
      } catch {
        // Best effort by design.
      }
    }

    /**
     * True once a reveal attempt could not put the panel on screen. The dock
     * fallback then stands in for the sidebar tab, so a broken reveal can never
     * leave the user staring at a mic button that appears to do nothing.
     */
    let revealFailed = false

    /**
     * The host allowed to draw the panel right now. Mutual exclusion lives here,
     * is read at render time, and never depends on which registration happened to
     * win a race: a failed reveal hands the panel to the dock, and a better-sidebar
     * service that vanished (plugin disabled, HMR) hands it back too.
     * @returns {'official'|'better'|'dock'} the hosting path.
     */
    function currentHost() {
      if (revealFailed) return 'dock'
      if (panelHost === 'better' && clientCtx !== null && clientCtx.get('betterSidebar') === undefined) return 'dock'
      return panelHost
    }

    /** True when DSH's own right sidebar is present in this composition. */
    function officialSidebarAvailable(ctx) {
      try {
        return ctx.get('sidebarRightTabs') !== undefined && ctx.get('sidebarRight') !== undefined
      } catch {
        return false
      }
    }

    /**
     * Reveal the review panel in whichever sidebar host owns it. With no sidebar
     * integration at all the dock fallback is already inline, so there is nothing
     * to open.
     * @param {string} sessionId - the session whose panel to reveal.
     */
    function openPanelTab(sessionId) {
      const bail = (reason, detail) => {
        revealFailed = true
        log('openPanelTab skipped', { reason, ...detail })
        notifyVia(
          clientCtx,
          sessionId,
          'warn',
          '语音整理面板没能在右侧栏打开 —— 已回退到输入框上方的面板；若仍看不到请刷新页面。',
        )
        // Make the dock fallback appear: the store notification re-renders it.
        try {
          patch(sessionId, {})
        } catch {
          // The state may not exist yet; it will be created by the caller.
        }
      }

      if (clientCtx === null) {
        bail('no client context yet', {})
        return
      }

      // Official host: one call, and the collapsed column expands with it.
      if (panelHost === 'official') {
        try {
          const sidebarRight = clientCtx.get('sidebarRight')
          if (sidebarRight === undefined || typeof sidebarRight.openTab !== 'function') {
            bail('official sidebarRight service is unavailable', { hasCtx: true })
            return
          }
          // Throws when no type is registered under this kind — a real failure,
          // and exactly the case the dock fallback exists for.
          sidebarRight.openTab(OFFICIAL_TAB_KIND)
          log('openPanelTab', { host: 'official', kind: OFFICIAL_TAB_KIND, sessionId })
          return
        } catch (error) {
          bail('official openTab threw', { message: String(error?.message ?? error) })
          return
        }
      }

      if (panelHost !== 'better' || !sidebarTabReady) {
        bail('no sidebar host is registered', { hasCtx: true, host: panelHost })
        return
      }
      try {
        const service = clientCtx.get('betterSidebar')
        service?.openTab?.({ type: 'voice-polish:panel' }, { sessionId })
        // openTab selects the tab; the right column itself may still be collapsed
        // (e.g. the user closed it earlier) — expand it so the panel is visible.
        try {
          clientCtx.get('layout')?.openRightbar?.(true, false)
        } catch {
          // Layout is a nicety here; the tab selection already happened.
        }
        // Diagnostics: is our tab type actually in the sidebar's registry?
        try {
          const ids = (service?.getTabs?.() ?? []).map((tab) => tab?.id).filter(Boolean)
          log('openPanelTab', { host: 'better', registeredTabs: ids, mine: ids.includes('voice-polish:panel') })
        } catch {
          // getTabs is optional; the reveal already happened.
        }
        if (revealFailed) {
          revealFailed = false
          try {
            patch(sessionId, {})
          } catch {
            // Nothing to re-render.
          }
        }
      } catch (error) {
        bail('openTab threw', { message: String(error?.message ?? error) })
      }
    }

    function createState() {
      return {
        open: false,
        /** The editable raw transcript — ready seconds after stopping, sendable as-is. */
        raw: '',
        /** The polished text, filled in later by the background polish. */
        polished: '',
        /** The raw text the current polished was generated from (append-mode gate). */
        polishedSourceOf: '',
        /** Per-recording transcripts, for 撤销上一段. */
        segments: [],
        style: 'moderate',
        /** True while the background polish is running; the raw text is usable meanwhile. */
        polishing: false,
        polishError: '',
        tip: '',
        gaps: [],
        model: '',
        /** True once the user hand-edits the polished text; style switches then confirm twice. */
        edited: false,
        /** True while the recogniser is turning audio into text. */
        status: 'idle', // idle | working | error
        error: '',
        /** Which provider/model produced the last polish, shown for transparency. */
        model: '',
        /** True while a send is in flight; blocks double-click duplicates. */
        sending: false,
        /** True when the clipboard could not be read: the panel asks for a manual Ctrl+V. */
        pasteHint: false,
        /** Short-lived inline confirmation (e.g. 「已复制」) shown inside the panel. */
        hint: '',
        /** True between the mic click and the capture actually running: show a starting state, not the editors. */
        starting: false,
        recording: false,
        recordingSince: 0,
        seq: 0,
      }
    }

    function ensureState(sessionId) {
      let state = states.get(sessionId)
      if (state === undefined) {
        state = createState()
        states.set(sessionId, state)
      }
      return state
    }

    function patch(sessionId, changes) {
      const next = Object.assign({}, ensureState(sessionId), changes)
      states.set(sessionId, next)
      for (const listener of listeners) listener()
      return next
    }

    /**
     * Show a short-lived confirmation inside the panel.
     *
     * Deliberately NOT the host's composer notice: that slot holds only the
     * latest notice and is cleared by the host's own events, so a confirmation
     * written there sits on screen until the user happens to do something else.
     * Inside the panel it appears where the user is looking and leaves on its own.
     * @param {string} sessionId - the session whose panel shows it.
     * @param {string} text - the confirmation.
     */
    function flashHint(sessionId, text) {
      patch(sessionId, { hint: text })
      const seq = ensureState(sessionId).seq
      setTimeout(() => {
        // Only clear our own hint: a newer interaction may have replaced it.
        if (ensureState(sessionId).hint === text && ensureState(sessionId).seq === seq) {
          patch(sessionId, { hint: '' })
        }
      }, 2400)
    }

    function subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    }

    function useSessionState(sessionId) {
      return useSyncExternalStore(subscribe, () => ensureState(sessionId))
    }

    // ---------------------------------------------------------------------
    // Audio: capture -> 16 kHz mono PCM16 WAV -> base64.
    //
    // `validateWave` on the Host checks the header byte for byte (a 16-byte fmt
    // block, byteRate 32000, even data length), so the encoder has to emit
    // exactly that canonical shape. Everything below exists to satisfy it.
    // ---------------------------------------------------------------------

    /**
     * Resample by linear interpolation — used only when the browser ignores the
     * requested 16 kHz context rate.
     * @param {Float32Array} samples - source samples in [-1, 1].
     * @param {number} fromRate - source rate in Hz.
     * @param {number} toRate - target rate in Hz.
     * @returns {Float32Array} resampled samples.
     */
    function resampleLinear(samples, fromRate, toRate) {
      if (fromRate === toRate || samples.length === 0) return samples
      const ratio = fromRate / toRate
      const length = Math.max(1, Math.round(samples.length / ratio))
      const out = new Float32Array(length)
      for (let i = 0; i < length; i += 1) {
        const position = i * ratio
        const base = Math.floor(position)
        const next = Math.min(base + 1, samples.length - 1)
        const weight = position - base
        out[i] = samples[base] * (1 - weight) + samples[next] * weight
      }
      return out
    }

    /** @param {DataView} view - target view. @param {number} offset - byte offset. @param {string} text - ASCII text. */
    function writeAscii(view, offset, text) {
      for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i))
    }

    /**
     * Encode mono Float32 samples as a canonical 16 kHz PCM16 WAV stream.
     * @param {Float32Array} samples - mono samples in [-1, 1].
     * @param {number} sampleRate - the rate `samples` is already at.
     * @returns {Uint8Array} the complete WAV byte stream.
     */
    function encodeWav(samples, sampleRate) {
      const dataLength = samples.length * 2
      const buffer = new ArrayBuffer(44 + dataLength)
      const view = new DataView(buffer)
      writeAscii(view, 0, 'RIFF')
      view.setUint32(4, 36 + dataLength, true)
      writeAscii(view, 8, 'WAVE')
      writeAscii(view, 12, 'fmt ')
      view.setUint32(16, 16, true)
      view.setUint16(20, 1, true) // PCM
      view.setUint16(22, 1, true) // mono
      view.setUint32(24, sampleRate, true)
      view.setUint32(28, sampleRate * 2, true) // byteRate = rate * channels * 2
      view.setUint16(32, 2, true) // blockAlign
      view.setUint16(34, 16, true) // bits per sample
      writeAscii(view, 36, 'data')
      view.setUint32(40, dataLength, true)
      let offset = 44
      for (let i = 0; i < samples.length; i += 1) {
        const sample = Math.max(-1, Math.min(1, samples[i]))
        view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true)
        offset += 2
      }
      return new Uint8Array(buffer)
    }

    // ---------------------------------------------------------------------
    // Recording.
    // ---------------------------------------------------------------------

    function releaseRecorder(recorder) {
      if (recorder.meterRaf !== 0) cancelAnimationFrame(recorder.meterRaf)
      recorder.meterRaf = 0
      if (recorder.autoStop !== undefined) clearTimeout(recorder.autoStop)
      recorder.autoStop = undefined
      if (recorder.pending === true) return // claimed but never initialized
      try {
        recorder.processor.onaudioprocess = null
        recorder.source.disconnect()
        recorder.processor.disconnect()
        recorder.silent.disconnect()
      } catch {
        // Graph teardown is best effort.
      }
      for (const track of recorder.stream.getTracks()) track.stop()
      try {
        recorder.audioContext.close()
      } catch {
        // Closing an already-closed context is harmless.
      }
    }

    /**
     * Begin capturing microphone audio for one Session.
     * @param {string} sessionId - owning Session.
     * @returns {Promise<void>}
     */
    async function startRecording(sessionId) {
      if (recorders.has(sessionId)) return
      // Claim the slot synchronously — before the first await — so a fast
      // double-click can never start two captures and leak a live microphone.
      const claim = { pending: true, meterRaf: 0 }
      recorders.set(sessionId, claim)

      // Reveal the panel immediately: the click itself is the feedback, and the
      // meter appears the moment the capture is running.
      openPanelTab(sessionId)

      let stream
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        })
      } catch (error) {
        if (recorders.get(sessionId) === claim) recorders.delete(sessionId)
        throw error
      }

      const AudioCtor = window.AudioContext ?? window.webkitAudioContext
      const audioContext = new AudioCtor({ sampleRate: TARGET_SAMPLE_RATE })
      // The context may start suspended; the getUserMedia await can drop the
      // user-gesture activation that would have kept it running.
      if (audioContext.state === 'suspended') {
        try {
          await audioContext.resume()
        } catch {
          // A suspended context delivers silent buffers; transcription will say so.
        }
      }

      // Anything from here to the final `recorders.set` can throw; the claim must
      // be released and the microphone freed rather than left running invisibly.
      try {
        const source = audioContext.createMediaStreamSource(stream)
        const processor = audioContext.createScriptProcessor(4096, 1, 1)
        const chunks = []
        processor.onaudioprocess = (event) => {
          chunks.push(new Float32Array(event.inputBuffer.getChannelData(0)))
        }
        // A ScriptProcessor only runs while connected to the graph; route it
        // through a muted gain node so nothing is played back into the microphone.
        const silent = audioContext.createGain()
        silent.gain.value = 0
        source.connect(processor)
        processor.connect(silent)
        silent.connect(audioContext.destination)

        // Live level meter. The AnalyserNode taps the same source; sampling runs on
        // the recorder (so it survives the panel unmounting), and the panel only
        // paints the ring buffer. React never re-renders at frame rate.
        const analyser = audioContext.createAnalyser()
        analyser.fftSize = 2048
        analyser.smoothingTimeConstant = 0.65
        source.connect(analyser)
        const timeDomain = new Uint8Array(analyser.fftSize)

        const recorder = {
          stream,
          audioContext,
          source,
          processor,
          silent,
          chunks,
          sampleRate: audioContext.sampleRate,
          analyser,
          levels: new Float32Array(LEVEL_BARS),
          levelCursor: 0,
          meterRaf: 0,
        }

        const sampleLevel = () => {
          if (recorders.get(sessionId) !== recorder) return
          analyser.getByteTimeDomainData(timeDomain)
          let sum = 0
          for (let i = 0; i < timeDomain.length; i += 1) {
            const value = (timeDomain[i] - 128) / 128
            sum += value * value
          }
          const rms = Math.sqrt(sum / timeDomain.length)
          // Conversational speech sits near RMS 0.02–0.2; scale so normal talking
          // fills the meter and shouting only just clips it.
          recorder.levels[recorder.levelCursor] = Math.min(1, rms * 4.5)
          recorder.levelCursor = (recorder.levelCursor + 1) % recorder.levels.length
          recorder.meterRaf = requestAnimationFrame(sampleLevel)
        }

        recorders.set(sessionId, recorder)
        recorder.meterRaf = requestAnimationFrame(sampleLevel)
        patch(sessionId, { recording: true, recordingSince: Date.now(), error: '' })
        log('record start', { sessionId, sampleRate: recorder.sampleRate })
        openPanelTab(sessionId)

        // The recogniser refuses audio beyond ~131s with an opaque size error;
        // stop on our own terms just before that, with the countdown on screen.
        recorder.autoStop = setTimeout(() => {
          if (recorders.get(sessionId) !== recorder) return
          log('record auto-stop', { sessionId, limitMs: MAX_RECORD_MS })
          finishRecording(sessionId).catch(() => {})
        }, MAX_RECORD_MS)
      } catch (error) {
        for (const track of stream.getTracks()) track.stop()
        try {
          await audioContext.close()
        } catch {
          // Best effort.
        }
        if (recorders.get(sessionId) === claim) recorders.delete(sessionId)
        throw error
      }
    }

    /** Abandon a live capture without producing a recording. */
    function cancelRecording(sessionId) {
      const recorder = recorders.get(sessionId)
      if (recorder === undefined) return
      recorders.delete(sessionId)
      releaseRecorder(recorder)
      patch(sessionId, { recording: false, recordingSince: 0 })
    }

    /**
     * Stop capturing and release every microphone resource.
     * @param {string} sessionId - owning Session.
     * @returns {Promise<{ audioBytes: Uint8Array, milliseconds: number } | null>} the recording, or null when none was live.
     */
    async function stopAndEncode(sessionId) {
      const recorder = recorders.get(sessionId)
      if (recorder === undefined || recorder.pending === true) return null
      recorders.delete(sessionId)
      releaseRecorder(recorder)

      let total = 0
      for (const chunk of recorder.chunks) total += chunk.length
      const merged = new Float32Array(total)
      let offset = 0
      for (const chunk of recorder.chunks) {
        merged.set(chunk, offset)
        offset += chunk.length
      }
      const samples = resampleLinear(merged, recorder.sampleRate, TARGET_SAMPLE_RATE)
      patch(sessionId, { recording: false, recordingSince: 0 })
      const audioBytes = encodeWav(samples, TARGET_SAMPLE_RATE)
      const milliseconds = Math.round((total / recorder.sampleRate) * 1000)
      log('record stop', { sessionId, milliseconds, chunks: recorder.chunks.length, bytes: audioBytes.length })
      return { audioBytes, milliseconds }
    }

    // ---------------------------------------------------------------------
    // Pipeline.
    // ---------------------------------------------------------------------

    /**
     * Transcribe one recording through the Host's speech registry.
     *
     * Deliberately a plain HTTP call to this package's own host half, so the
     * browser half keeps zero guarded-service dependencies: no `remote.*` keys,
     * no inject gating, works whether or not any other voice plugin is loaded.
     * The WAV goes up as the raw byte stream — base64 would inflate an already
     * large payload by a third for no reason.
     *
     * @param {Uint8Array} audioBytes - canonical 16 kHz mono PCM16 WAV bytes.
     * @returns {Promise<string>} the trimmed transcript.
     */
    async function transcribe(audioBytes) {
      const response = await fetch(TRANSCRIBE_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body: audioBytes,
        // A hung recogniser must not pin the panel on "转写中…" forever.
        signal: AbortSignal.timeout(150_000),
      })
      let body
      try {
        body = await response.json()
      } catch {
        throw new Error(`转写服务返回了非 JSON 响应（HTTP ${response.status}）`)
      }
      if (!body || body.ok !== true) throw new Error(body?.error?.message ?? `转写失败（HTTP ${response.status}）`)
      const text = body.value?.text
      if (typeof text !== 'string') throw new Error('转写服务返回了意外的结果')
      return text.trim()
    }

    /**
     * Ask the Host half to tidy one blob of transcript.
     * @param {object} request - transcript, style, Session id and optional instruction.
     * @returns {Promise<{ polished: string, tip: string, gaps: string[], model?: string }>}
     */
    async function requestPolish(request) {
      const response = await fetch(POLISH_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(request),
        // A hung model route must not pin the panel on "整理中…" forever.
        signal: AbortSignal.timeout(120_000),
      })
      let body
      try {
        body = await response.json()
      } catch {
        throw new Error(`整理服务返回了非 JSON 响应（HTTP ${response.status}）`)
      }
      if (!body || body.ok !== true) throw new Error(body?.error?.message ?? `整理失败（HTTP ${response.status}）`)
      const value = body.value
      if (!value || typeof value.polished !== 'string' || value.polished.length === 0) {
        throw new Error('整理服务返回了空结果')
      }
      return value
    }

    /**
     * Polish in the background while the raw text stays sendable.
     *
     * Edit-protection rules:
     *  - append mode (`appendPiece` set) merges onto the user's possibly-edited
     *    polished text and therefore must NOT reset `edited` — the dirty flag
     *    keeps gating style switches.
     *  - append is only valid when the current polished was generated from exactly
     *    the pre-append raw text; otherwise content could be dropped silently,
     *    so we fall back to a full repolish of the whole raw text.
     *
     * @param {string} sessionId - owning Session.
     * @param {string} raw - the full raw transcript to polish from.
     * @param {string} style - style preset id.
     * @param {string|null} appendPiece - the newest transcript only, or null for a full repolish.
     * @returns {Promise<void>}
     */
    async function runPolish(sessionId, raw, style, appendPiece) {
      // Declared OUTSIDE the try: the catch compares it against the live state,
      // and a try-scoped const is invisible there (that ReferenceError used to
      // escape unhandled and leave the panel stuck forever on any polish failure).
      const seq = ensureState(sessionId).seq + 1
      try {
        if (raw.trim().length === 0) return
        patch(sessionId, { polishing: true, polishError: '', seq })

        const payload = appendPiece !== null
          ? {
              text: appendPiece,
              style,
              sessionId,
              instruction: '只整理这一段新增内容，不要重复或合并前面已经整理好的部分。',
            }
          : { text: raw, style, sessionId }

        // Model routes hang or drop connections now and then; one automatic
        // retry absorbs the transient cases without the user doing anything.
        let value
        try {
          value = await requestPolish(payload)
        } catch (firstError) {
          const message = String(firstError?.message ?? firstError)
          if (!/timed?\s*out|network|failed to fetch|socket/i.test(message)) throw firstError
          if (ensureState(sessionId).seq !== seq) return
          patch(sessionId, { polishError: '请求超时，正在自动重试…' })
          value = await requestPolish(payload)
        }
        if (ensureState(sessionId).seq !== seq) return // a newer request already answered

        const current = ensureState(sessionId)
        // Models love airy paragraph spacing; in a CJK prompt box that reads as
        // half-blank filler. Collapse any run of newlines to a single one.
        const compact = String(value.polished).replace(/\r\n?/g, '\n').replace(/\n{2,}/g, '\n').trim()
        const merged =
          appendPiece !== null && current.polished.trim().length > 0
            ? `${current.polished.trimEnd()}\n${compact}`
            : compact

        patch(sessionId, {
          polished: merged,
          polishedSourceOf: raw,
          tip: typeof value.tip === 'string' ? value.tip : '',
          gaps: Array.isArray(value.gaps) ? value.gaps : [],
          model: typeof value.model === 'string' ? value.model : '',
          polishing: false,
          polishError: '',
          // Only a full repolish replaces the baseline the user may have edited.
          ...(appendPiece !== null ? {} : { edited: false }),
        })
        log('polished', { sessionId, append: appendPiece !== null, chars: merged.length, preview: merged.slice(0, 60) })
      } catch (error) {
        // A stale failure must not clobber a newer in-flight request's status.
        if (ensureState(sessionId).seq !== seq) return
        patch(sessionId, { polishing: false, polishError: String(error?.message ?? error) })
      }
    }

    /**
     * Fold one finished transcript into the panel.
     *
     * The raw text becomes readable and sendable IMMEDIATELY; the polish runs in
     * the background and fills the second editor whenever it is ready.
     */
    function absorb(sessionId, transcript) {
      const current = ensureState(sessionId)
      const firstLanding = current.raw.trim().length === 0
      const rawBefore = current.raw
      const raw = rawBefore.trim().length === 0 ? transcript : `${rawBefore.trimEnd()}\n${transcript}`
      const segments = current.segments.concat([transcript])
      patch(sessionId, { open: true, raw, segments, status: 'idle', error: '' })
      // Reveal the panel only on the FIRST landing of a cycle: after that the
      // tab is already on screen, and re-opening it on every segment would yank
      // focus away from whatever the user switched to (e.g. a file they opened).
      if (firstLanding) openPanelTab(sessionId)
      // Append only when the current polished was generated from exactly the
      // pre-append raw — otherwise fall back to polishing the whole raw text.
      const canAppend = current.polished.trim().length > 0 && current.polishedSourceOf === rawBefore
      log('absorb', { sessionId, segments: segments.length, canAppend, rawChars: raw.length })
      runPolish(sessionId, raw, current.style, canAppend ? transcript : null)
    }

    /**
     * Fold pasted text into the panel exactly like a spoken segment: it appends
     * to the raw text, is undoable, and triggers the same background polish.
     */
    function absorbPaste(sessionId, text) {
      const current = ensureState(sessionId)
      const raw = current.raw.trim().length === 0 ? text : `${current.raw.trimEnd()}\n${text}`
      const segments = current.segments.concat([text])
      patch(sessionId, { open: true, raw, segments, status: 'idle', error: '', pasteHint: false })
      openPanelTab(sessionId)
      log('absorb paste', { sessionId, chars: text.length, rawChars: raw.length })
      // The polished text came from the spoken raw, not this paste — always a
      // full repolish so the pasted content is actually included.
      runPolish(sessionId, raw, current.style, null)
    }

    /**
     * Toolbar paste entry: read the clipboard and polish it. When the clipboard
     * cannot be read (permission, or the window lost focus), open the panel and
     * ask for a manual Ctrl+V into the raw editor instead — it auto-polishes.
     */
    async function pasteAndPolish(sessionId) {
      let text = ''
      let readable = false
      try {
        text = String((await navigator.clipboard.readText()) ?? '').trim()
        readable = true
      } catch {
        // Clipboard read denied or unfocused — fall through to the manual path.
      }
      if (readable && text.length > 0) {
        absorbPaste(sessionId, text)
        return
      }
      patch(sessionId, { open: true, pasteHint: true, error: '', status: 'idle' })
    }

    /**
     * Retire the panel completely: clear every trace and bump `seq` so any
     * in-flight polish/transcribe lands nowhere. Used by ✕ close and by a
     * successful send (which must not leave the sent text editable for a
     * duplicate send).
     */
    function discard(sessionId) {
      const seq = ensureState(sessionId).seq + 1
      patch(sessionId, {
        open: false,
        raw: '',
        polished: '',
        polishedSourceOf: '',
        segments: [],
        polishing: false,
        polishError: '',
        tip: '',
        gaps: [],
        edited: false,
        status: 'idle',
        error: '',
        sending: false,
        pasteHint: false,
        starting: false,
        seq,
      })
    }

    /**
     * Stop, transcribe and absorb the live recording for one Session.
     * @param {string} sessionId - owning Session.
     * @returns {Promise<void>}
     */
    async function finishRecording(sessionId) {
      const recording = await stopAndEncode(sessionId)
      if (recording === null) return
      if (recording.milliseconds < MIN_RECORD_MS) {
        patch(sessionId, { open: true, status: 'error', error: '录音太短了，没听清。再点一次 🎤 说完整一点。' })
        return
      }
      patch(sessionId, { status: 'working', error: '' })
      try {
        const transcript = await transcribe(recording.audioBytes)
        log('transcribed', { sessionId, chars: transcript.length, preview: transcript.slice(0, 60) })
        if (transcript.length === 0) {
          patch(sessionId, { status: 'error', error: '没有识别到文字，再说一次试试。' })
          return
        }
        absorb(sessionId, transcript)
      } catch (error) {
        const raw = String(error?.message ?? error)
        // The recogniser's internal server rejects oversize audio with an opaque
        // message; translate it into something the user can act on.
        const friendly = raw.includes('Invalid speech audio size')
          ? '这段录音超过了识别服务的 2 分钟上限。长内容分两段说：先发一段，再点「继续说」录下一段。'
          : raw
        patch(sessionId, { status: 'error', error: friendly })
      }
    }

    /**
     * One microphone click: start capturing, or stop and process.
     * @param {string} sessionId - owning Session.
     * @returns {Promise<void>}
     */
    async function toggleRecording(sessionId) {
      try {
        if (!ensureState(sessionId).recording) {
          // `starting` covers the getUserMedia/AudioContext init window, so the
          // panel shows "starting the microphone" instead of flashing the two
          // editors before the recording view takes over.
          patch(sessionId, { open: true, error: '', starting: true })
          try {
            await startRecording(sessionId)
          } finally {
            patch(sessionId, { starting: false })
          }
          return
        }
        await finishRecording(sessionId)
      } catch (error) {
        patch(sessionId, { open: true, status: 'error', error: String(error?.message ?? error) })
      }
    }

    // ---------------------------------------------------------------------
    // Styles.
    // ---------------------------------------------------------------------

    const CSS = `
.dvp-card {
  margin: 0 0 8px; padding: 12px 14px 10px;
  border: 0.5px solid var(--dsw-alias-border-l1, rgba(128,128,128,.22));
  border-radius: 10px;
  background: var(--dsw-alias-bg-layer-1, rgba(128,128,128,.05));
  color: var(--dsw-alias-label-primary, inherit);
  font-size: 13px; line-height: 1.6;
  box-shadow: 0 1px 2px rgba(0,0,0,.04);
}
.dvp-head { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
.dvp-title { font-weight: 600; font-size: 13px; }
.dvp-meta { color: var(--dsw-alias-label-secondary, rgba(128,128,128,.9)); font-size: 12px; }
.dvp-spacer { flex: 1; }
.dvp-editor {
  width: 100%; box-sizing: border-box; resize: vertical;
  min-height: 96px; max-height: 40vh;
  padding: 10px 12px; border-radius: 8px;
  border: 0.5px solid var(--dsw-alias-border-l1, rgba(128,128,128,.22));
  background: var(--dvp-editor-bg, var(--dsw-alias-bg-layer-2, rgba(128,128,128,.06)));
  color: var(--dvp-editor-fg, var(--dsw-alias-label-primary, inherit));
  font: inherit; font-size: 13px; line-height: 1.7; white-space: pre-wrap;
  transition: border-color .12s ease;
}
.dvp-editor:hover { border-color: var(--dsw-alias-border-l2, rgba(128,128,128,.35)); }
.dvp-editor:focus { outline: none; border-color: var(--dsw-alias-brand-primary, #4d6bfe); }
.dvp-raw {
  margin-top: 8px; border-radius: 8px; overflow: hidden;
  border: 0.5px solid var(--dsw-alias-border-l1, rgba(128,128,128,.18));
  background: var(--dsw-alias-bg-layer-2, rgba(128,128,128,.05));
}
.dvp-raw-head {
  display: flex; align-items: center; gap: 6px;
  padding: 6px 10px; cursor: pointer; user-select: none;
  color: var(--dsw-alias-label-secondary, rgba(128,128,128,.9));
  font-size: 12px;
}
.dvp-raw-head:hover { color: var(--dsw-alias-label-primary, inherit); }
.dvp-raw-list { padding: 2px 10px 8px; }
.dvp-raw-item {
  padding: 6px 0; font-size: 12.5px; line-height: 1.6;
  color: var(--dsw-alias-label-secondary, rgba(128,128,128,.9));
  border-top: 0.5px solid var(--dsw-alias-border-l1, rgba(128,128,128,.12));
  white-space: pre-wrap;
}
.dvp-raw-item:first-child { border-top: none; }
.dvp-raw-item b {
  font-weight: 500; color: var(--dsw-alias-brand-primary, #4d6bfe);
  font-variant-numeric: tabular-nums; margin-right: 6px;
}
.dvp-tip {
  margin-top: 8px; padding: 8px 10px; border-radius: 8px;
  background: var(--dsw-alias-bg-layer-2, rgba(128,128,128,.06));
  border-left: 2px solid var(--dsw-alias-brand-primary, #4d6bfe);
  color: var(--dsw-alias-label-secondary, rgba(128,128,128,.95));
  font-size: 12.5px; line-height: 1.6;
}
.dvp-tip b { color: var(--dsw-alias-label-primary, inherit); font-weight: 500; }
.dvp-gaps {
  margin-top: 6px; font-size: 12.5px; line-height: 1.6;
  color: var(--dsw-alias-state-warn-primary, #b8860b);
}
.dvp-gaps ul { margin: 4px 0 0; padding-left: 18px; }
.dvp-gaps li { margin: 2px 0; }
.dvp-row { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-top: 10px; }
.dvp-btn {
  padding: 3px 10px; border-radius: 6px; cursor: pointer;
  border: 0.5px solid var(--dsw-alias-border-l1, rgba(128,128,128,.25));
  background: transparent; color: var(--dsw-alias-label-secondary, rgba(128,128,128,.95));
  font: inherit; font-size: 12px; line-height: 1.8; white-space: nowrap;
  transition: background-color .1s ease, color .1s ease, border-color .1s ease;
}
.dvp-btn:hover {
  background: var(--dsw-alias-bg-layer-2, rgba(128,128,128,.1));
  color: var(--dsw-alias-label-primary, inherit);
  border-color: var(--dsw-alias-border-l2, rgba(128,128,128,.35));
}
.dvp-btn:disabled { opacity: .4; cursor: default; }
.dvp-btn:disabled:hover { background: transparent; }
.dvp-btn[data-active="true"] {
  background: var(--dvp-brand, var(--dsw-alias-brand-primary, #4d6bfe)); color: var(--dvp-on-brand, #fff);
  border-color: var(--dvp-brand, var(--dsw-alias-brand-primary, #4d6bfe));
}
.dvp-btn[data-variant="primary"] {
  background: var(--dvp-brand, var(--dsw-alias-brand-primary, #4d6bfe)); color: var(--dvp-on-brand, #fff);
  border-color: var(--dvp-brand, var(--dsw-alias-brand-primary, #4d6bfe));
}
.dvp-btn[data-variant="primary"]:hover { filter: brightness(1.08); }
.dvp-btn[data-variant="ghost"] {
  border-color: transparent; color: var(--dsw-alias-label-secondary, rgba(128,128,128,.8));
}
.dvp-btn[data-recording="true"] {
  background: var(--dsw-alias-state-error-primary, #d9534f);
  color: var(--dvp-on-brand, #fff); border-color: transparent; font-variant-numeric: tabular-nums;
}
.dvp-block {
  margin-top: 10px; padding: 10px 12px;
  border: 0.5px solid var(--dsw-alias-border-l1, rgba(128,128,128,.18));
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-2, rgba(128,128,128,.04));
}
.dvp-model-list { display: flex; flex-direction: column; gap: 4px; max-height: 260px; overflow: auto; padding: 4px 2px; }
.dvp-model-group {
  margin: 6px 0 2px; font-size: 11.5px;
  color: var(--dsw-alias-label-secondary, rgba(128,128,128,.8));
}
.dvp-block-head { display: flex; align-items: baseline; gap: 8px; margin-bottom: 6px; }
.dvp-block-toggle { cursor: pointer; user-select: none; margin-bottom: 6px; }
.dvp-block-toggle:hover .dvp-block-title { color: var(--dsw-alias-brand-primary, #4d6bfe); }
.dvp-chev {
  font-size: 11px; color: var(--dsw-alias-label-secondary, rgba(128,128,128,.7));
  width: 12px; flex: none;
}
.dvp-block-title { font-weight: 600; font-size: 12.5px; }
.dvp-editor-raw { min-height: 64px; max-height: 28vh; background: var(--dsw-alias-bg-layer-1, rgba(128,128,128,.06)); }
.dvp-editor-vocab {
  min-height: 96px; max-height: 24vh;
  font-family: var(--dsw-font-mono, Consolas, monospace); font-size: 12.5px;
}
.dvp-editor-placeholder {
  min-height: 88px; display: flex; align-items: center; justify-content: center;
  color: var(--dsw-alias-label-secondary, rgba(128,128,128,.8));
  background: var(--dsw-alias-bg-layer-2, rgba(128,128,128,.06));
}
.dvp-status {
  margin-top: 8px; font-size: 12.5px;
  color: var(--dsw-alias-label-secondary, rgba(128,128,128,.85));
}
.dvp-meter {
  display: block; width: 100%; height: 48px; margin: 2px 0 6px;
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-2, rgba(128,128,128,.06));
  border: 0.5px solid var(--dsw-alias-border-l1, rgba(128,128,128,.15));
  color: var(--dsw-alias-brand-primary, #4d6bfe);
}
.dvp-starting { display: flex; flex-direction: column; gap: 2px; }
.dvp-meter-idle { border-style: dashed; }
.dvp-empty-hint { display: flex; flex-direction: column; gap: 6px; padding: 10px 0 4px; }
.dvp-error {
  margin-top: 8px; font-size: 12.5px; line-height: 1.6;
  color: var(--dsw-alias-state-error-primary, #d9534f);
}
.dvp-hint {
  margin-top: 8px; font-size: 12.5px; line-height: 1.6; opacity: .8;
  color: var(--dsw-alias-state-success-primary, var(--dsw-alias-label-primary, inherit));
}
`

    let styleInjected = false
    /** Guards applyBrandContrast against re-entry from its own style writes. */
    let brandProbeRunning = false

    /**
     * Resolve the on-brand foreground colour at runtime.
     *
     * DSH's dark theme defines `--dsw-alias-brand-primary` as the primary label
     * colour (near-white), so a hardcoded `color: #fff` on brand-background
     * buttons renders white-on-white. Sampling the resolved brand colour and
     * picking black/white by relative luminance keeps both themes readable.
     * Idempotent: repeated calls only refresh the two custom properties.
     */
    function applyBrandContrast() {
      if (typeof document === 'undefined') return
      // Re-entrancy guard: this function writes to documentElement's style, and
      // the theme watcher observes attribute changes on that same element. The
      // filter no longer includes 'style' (see watchBrandContrast), and this
      // guard makes a feedback loop structurally impossible either way.
      if (brandProbeRunning) return
      brandProbeRunning = true
      try {
        const probe = document.createElement('span')
      probe.style.display = 'none'
      probe.style.color = 'var(--dsw-alias-brand-primary, #4d6bfe)'
      document.body.appendChild(probe)
      const raw = getComputedStyle(probe).color
      probe.remove()
      const channels = raw.match(/\d+(?:\.\d+)?/g)?.map(Number) ?? []
      const [r = 77, g = 107, b = 254] = channels
      // Relative luminance (sRGB, WCAG): dark brand -> white text, light brand -> black text.
      const luminance = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255
      const root = document.documentElement
      root.style.setProperty('--dvp-brand', `var(--dsw-alias-brand-primary, #4d6bfe)`)
      root.style.setProperty('--dvp-on-brand', luminance > 0.55 ? '#0f1115' : '#ffffff')

      // Editors: pair a self-contained background with a matching foreground.
      // Textareas carry a UA default light background; when the theme scope does
      // not reach the panel, token fallbacks left light text on that light box.
      const labelProbe = document.createElement('span')
      labelProbe.style.display = 'none'
      labelProbe.style.color = 'var(--dsw-alias-label-primary, #0f1115)'
      document.body.appendChild(labelProbe)
      const labelRaw = getComputedStyle(labelProbe).color
      labelProbe.remove()
      const labelChannels = labelRaw.match(/\d+(?:\.\d+)?/g)?.map(Number) ?? []
      const [lr = 15, lg = 17, lb = 21] = labelChannels
      const labelLuminance = (0.2126 * lr + 0.7152 * lg + 0.0722 * lb) / 255
      if (labelLuminance > 0.55) {
        // Dark theme: near-white primary label.
        root.style.setProperty('--dvp-editor-bg', '#2c2c2e')
        root.style.setProperty('--dvp-editor-fg', '#f9fafb')
      } else {
        root.style.setProperty('--dvp-editor-bg', '#ffffff')
        root.style.setProperty('--dvp-editor-fg', '#0f1115')
      }
      } finally {
        brandProbeRunning = false
      }
    }

    // Theme switches swap CSS custom properties without a page reload; re-sample
    // when the light/dark attribute or colour-scheme changes.
    function watchBrandContrast() {
      if (typeof document === 'undefined' || typeof MutationObserver === 'undefined') return
      const observer = new MutationObserver(() => applyBrandContrast())
      observer.observe(document.documentElement, {
        attributes: true,
        // 'style' is deliberately NOT observed: applyBrandContrast writes to
        // documentElement's own style, so watching it would let the callback
        // re-trigger itself. Themes are signalled through the class and data-*
        // attributes anyway.
        attributeFilter: ['class', 'data-theme', 'data-color-scheme'],
      })
      if (typeof window.matchMedia === 'function') {
        try {
          window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => applyBrandContrast())
        } catch {
          // Older builds use addListener; the attribute observer above still covers them.
        }
      }
    }

    function injectStyles() {
      if (typeof document === 'undefined') return
      // Idempotent against HMR: the driver removes plugin-owned style tags on
      // reload, so membership is checked in the DOM rather than in module scope.
      if (styleInjected && document.getElementById('dsh-voice-polish-styles') !== null) return
      const existing = document.getElementById('dsh-voice-polish-styles')
      if (existing !== null) existing.remove()
      styleInjected = true
      const element = document.createElement('style')
      element.id = 'dsh-voice-polish-styles'
      element.setAttribute('data-plugin', 'dsh-voice-polish')
      element.setAttribute('data-plugin-css', 'dsh-voice-polish')
      element.textContent = CSS
      document.head.appendChild(element)
    }

    // ---------------------------------------------------------------------
    // Components.
    // ---------------------------------------------------------------------

    /**
     * One pill-shaped control.
     * @param {object} props - label, onClick, title and presentation flags.
     * @returns {object} a React element.
     */
    function Button(props) {
      return h(
        'button',
        {
          type: 'button',
          className: 'dvp-btn',
          title: props.title,
          disabled: props.disabled === true,
          'data-active': props.active === true ? 'true' : undefined,
          'data-recording': props.recording === true ? 'true' : undefined,
          'data-variant': props.variant,
          onMouseDown: (event) => event.preventDefault(),
          onClick: props.onClick,
        },
        props.label,
      )
    }

    /**
     * Seconds elapsed since a recording started, re-rendered on a timer.
     * @param {number} since - epoch ms, 0 when idle.
     * @returns {number} whole seconds.
     */
    function useElapsedSeconds(since) {
      const [now, setNow] = useState(() => Date.now())
      useEffect(() => {
        if (since === 0) return undefined
        const timer = setInterval(() => setNow(Date.now()), 500)
        return () => clearInterval(timer)
      }, [since])
      return since === 0 ? 0 : Math.max(0, Math.floor((now - since) / 1000))
    }

    /** `m:ss` for a whole-second count. */
    function clock(totalSeconds) {
      return `${Math.floor(totalSeconds / 60)}:${String(totalSeconds % 60).padStart(2, '0')}`
    }

    /**
     * Live waveform of the microphone input, so the user can see their voice is
     * actually being picked up.
     *
     * Drawing is imperative on purpose: a 60 fps React state update would
     * re-render the whole panel every frame. The recorder's sampling loop fills
     * the ring buffer; this component only paints it. Newest sample sits at the
     * right edge and scrolls left.
     *
     * @param {object} props - `{ sessionId }`.
     * @returns {object} a canvas element.
     */
    function LevelMeter(props) {
      const canvasRef = useRef(null)

      useEffect(() => {
        const canvas = canvasRef.current
        if (canvas === null) return undefined
        const paint = canvas.getContext('2d')
        if (paint === null) return undefined

        let frame = 0
        const draw = () => {
          frame = requestAnimationFrame(draw)
          const width = canvas.clientWidth
          const height = canvas.clientHeight
          if (width === 0 || height === 0) return

          const ratio = window.devicePixelRatio || 1
          if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)) {
            canvas.width = Math.round(width * ratio)
            canvas.height = Math.round(height * ratio)
          }
          paint.setTransform(ratio, 0, 0, ratio, 0, 0)
          paint.clearRect(0, 0, width, height)

          const recorder = recorders.get(props.sessionId)
          if (recorder === undefined || recorder.pending === true) return
          const { levels, levelCursor } = recorder
          // `color` carries the theme token from CSS, so the meter follows the
          // active theme without this code knowing any palette.
          paint.fillStyle = window.getComputedStyle(canvas).color || '#4d6bfe'

          const bars = levels.length
          const gap = 2
          const barWidth = Math.max(1, (width - gap * (bars - 1)) / bars)
          const radius = Math.min(barWidth / 2, 1.5)
          const middle = height / 2

          for (let i = 0; i < bars; i += 1) {
            // The cursor points at the oldest slot; walk forward for left-to-right.
            const level = levels[(levelCursor + i) % bars]
            const barHeight = Math.max(2, level * (height - 4))
            const x = i * (barWidth + gap)
            paint.globalAlpha = 0.3 + level * 0.7
            if (typeof paint.roundRect === 'function') {
              paint.beginPath()
              paint.roundRect(x, middle - barHeight / 2, barWidth, barHeight, radius)
              paint.fill()
            } else {
              paint.fillRect(x, middle - barHeight / 2, barWidth, barHeight)
            }
          }
          paint.globalAlpha = 1
        }

        frame = requestAnimationFrame(draw)
        return () => cancelAnimationFrame(frame)
      }, [props.sessionId])

      return h('canvas', { ref: canvasRef, className: 'dvp-meter' })
    }

    /**
     * This plugin's own microphone: click to start, click again to stop.
     * @param {object} props - injected `{ sessionId }`.
     * @returns {object|null} the button.
     */
    function MicButton(props) {
      const sessionId = props.sessionId ?? ''
      const state = useSessionState(sessionId)
      const elapsed = useElapsedSeconds(state.recordingSince)
      if (sessionId === '') return null
      const starting = state.starting === true
      return h(Button, {
        label: state.recording ? `⏺ ${clock(elapsed)}` : starting ? '⋯' : '🎤',
        title: state.recording
          ? '正在录音 —— 再点一次停止，原话马上就能发'
          : starting
            ? '麦克风正在启动…'
            : '语音整理：点一下开始说话，说完再点一下，自动整理成清晰表达',
        recording: state.recording,
        disabled: starting,
        onClick: () => {
          toggleRecording(props.sessionId).catch(() => {
            // toggleRecording funnels every failure into the panel.
          })
        },
      })
    }

    /**
     * Paste-to-polish entry, beside the microphone: reads the clipboard and runs
     * it through the same pipeline. Falls back to opening the panel for a
     * manual Ctrl+V when the clipboard cannot be read.
     * @param {object} props - injected `{ sessionId }`.
     * @returns {object|null} the button.
     */
    function PasteButton(props) {
      const sessionId = props.sessionId ?? ''
      const state = useSessionState(sessionId)
      if (sessionId === '') return null
      return h(Button, {
        label: '📋',
        title: '粘贴整理：把剪贴板里的文字整理成清晰表达（读不到剪贴板时会让你手动粘贴）',
        onClick: () => {
          pasteAndPolish(sessionId).catch((error) => {
            patch(sessionId, { open: true, error: String(error?.message ?? error) })
          })
        },
      })
    }

    /**
     * The dock fallback of the review panel. Exactly one host may draw the panel;
     * this seat is the LAST resort, so it stands down whenever a sidebar host owns
     * it (see currentHost) and takes over again if a reveal ever fails.
     * @param {object} props - injected `{ sessionId }`.
     * @returns {object|null} the panel, or null while another host owns it.
     */
    function PolishPanel(props) {
      // Render-time host check (never a cached flag): the moment a sidebar host
      // takes the panel, this seat stands down — no stale race can leave a second
      // copy blocking the composer.
      if (currentHost() !== 'dock') return null
      const sessionId = props.sessionId ?? ''
      // A session-scoped slot always passes one; without it there is no state to show.
      if (sessionId === '') return null
      return h(PanelBody, {
        sessionId,
        // The dock is the only host that hides itself while there is nothing to
        // show; sidebar hosts always render (see PanelBody's visibility rule).
        dockMode: true,
        send: (text) => sendVia(clientCtx, sessionId, text),
        notify: (level, text) => notifyVia(clientCtx, sessionId, level, text),
      })
    }

    /**
     * The legacy dsh-better-sidebar tab body: the same panel, living on the right.
     * Renders nothing while the OFFICIAL sidebar owns the panel, so the two hosts
     * can never both draw it.
     * @param {object} props - BetterSidebar `TabComponentProps`.
     * @returns {object|null} the panel, or null when the official host has it.
     */
    function SidebarPanelTab(props) {
      if (panelHost === 'official') return null
      const sessionId = props.scope?.sessionId ?? ''
      // Trace every mount of the tab body: if this line is absent from the
      // console while the tab is blank, the problem is upstream of rendering.
      log('tab render', { rev: CLIENT_REV, sessionId: sessionId === '' ? '(none)' : sessionId, visible: props.visible })
      if (sessionId === '') {
        return h('div', { className: 'dvp-status' }, '没有活动会话 —— 打开一个对话后这里就是你的语音整理面板。')
      }
      return h(PanelBody, {
        sessionId,
        // No `dockMode` here on purpose: a sidebar host always renders, idle or
        // not. Only the composer dock opts into hiding itself.
        send: (text) => sendVia(props.ctx, sessionId, text),
        notify: (level, text) => notifyVia(props.ctx, sessionId, level, text),
      })
    }

    /**
     * Read the framework-injected tab record for the official sidebar seat.
     *
     * `useTabInfo` is part of this seat's standard props — the framework injects it
     * for `sidebar.right.pane.tab`, and it is a React hook, so it is called
     * unconditionally in practice. The `typeof` guard exists only so a stripped-down
     * host degrades to "no tab info" instead of taking the whole panel down.
     * @param {object} props - slot props.
     * @returns {object|null} `{ sidebar, panel, tab }`, or null when unavailable.
     */
    function readTabInfo(props) {
      if (typeof props?.useTabInfo !== 'function') return null
      try {
        return props.useTabInfo() ?? null
      } catch {
        return null
      }
    }

    /**
     * First non-empty string of the candidates.
     * @param {unknown[]} candidates - values to test.
     * @returns {string} the first usable string, or ''.
     */
    function firstSessionId(candidates) {
      for (const candidate of candidates) {
        if (typeof candidate === 'string' && candidate !== '') return candidate
      }
      return ''
    }

    /**
     * The OFFICIAL right-sidebar tab body (`sidebar.right.pane.tab`, keyed by
     * OFFICIAL_TAB_ID). It renders the very same PanelBody the dock and the legacy
     * tab render — one component, three seats, so no copy can drift.
     * @param {object} props - composed slot props (`sessionId`, `useTabInfo`, …).
     * @returns {object} the panel.
     */
    function OfficialPanelTab(props) {
      const info = readTabInfo(props)
      // `sessionId` is a standard prop of this seat (the shipping deliverables tab
      // reads it the same way); the tab record is only a second chance, in case a
      // host variant carries it there instead.
      const sessionId = firstSessionId([props?.sessionId, info?.sessionId, info?.tab?.sessionId])
      // Trace every mount: if this line is missing from the console while the pane
      // is blank, the problem is upstream of rendering.
      log('official tab render', {
        rev: CLIENT_REV,
        sessionId: sessionId === '' ? '(none)' : sessionId,
        tabId: info?.tab?.id ?? '(unknown)',
      })
      if (sessionId === '') {
        return h('div', { className: 'dvp-status' }, '没有活动会话 —— 打开一个对话后这里就是你的语音整理面板。')
      }
      return h(PanelBody, {
        sessionId,
        // No `dockMode`: a sidebar host always renders. An idle panel that renders
        // nothing is the white-screen bug this contract exists to prevent.
        send: (text) => sendVia(clientCtx, sessionId, text),
        notify: (level, text) => notifyVia(clientCtx, sessionId, level, text),
      })
    }

    /**
     * The official tab's chip title (`sidebar.right.pane.tab.title`): the type's
     * title while the pane is empty, the tab's own title once it has one.
     * @param {object} props - composed slot props.
     * @returns {object} a span with the label.
     */
    function OfficialPanelTitle(props) {
      const info = readTabInfo(props)
      const title = info?.tab?.title
      return h('span', null, typeof title === 'string' && title !== '' ? title : '语音整理')
    }

    /**
     * The review panel's working body (hooks live here, behind the session guard).
     * @param {object} props - injected `{ sessionId, send, notify }`.
     * @returns {object|null} the panel, or null while there is nothing to review.
     */
    function PanelBody(props) {
      const sessionId = props.sessionId
      const state = useSessionState(sessionId)
      const elapsed = useElapsedSeconds(state.recordingSince)
      // Style switch asks twice when the user has hand edits on screen.
      const [confirmingStyle, setConfirmingStyle] = useState(null)
      // Per-block collapse: the header toggles the editor, the action row (with
      // the send buttons) always stays visible.
      const [rawOpen, setRawOpen] = useState(true)
      const [polishedOpen, setPolishedOpen] = useState(true)
      // The coach section (tip + gaps): visible by default, collapsible.
      const [tipsOpen, setTipsOpen] = useState(true)
      // The user's custom word list: loaded once per mount, saved explicitly.
      const [vocab, setVocab] = useState(null) // null = not loaded yet
      const [vocabDirty, setVocabDirty] = useState(false)
      const [vocabSaving, setVocabSaving] = useState(false)
      const [vocabNote, setVocabNote] = useState('')
      const [vocabOpen, setVocabOpen] = useState(false)
      // The polish model picker: enumerates every model DSH has configured.
      const [modelOpen, setModelOpen] = useState(false)
      const [modelCatalog, setModelCatalog] = useState(null) // { groups: [...] }
      const [modelCatalogNote, setModelCatalogNote] = useState('')
      const [override, setOverride] = useState(null) // { provider, model } | null = follow the session default
      const [overrideSaving, setOverrideSaving] = useState(false)
      const [overrideNote, setOverrideNote] = useState('')
      const rawEditorRef = useRef(null)

      useEffect(() => {
        let cancelled = false
        fetch('/dsh-voice-polish/config')
          .then((response) => response.json())
          .then((body) => {
            if (!cancelled && body?.ok === true) setOverride(body.value?.override ?? null)
          })
          .catch(() => {})
        return () => {
          cancelled = true
        }
      }, [])

      // Lazy-load the catalog the first time the picker opens.
      useEffect(() => {
        if (!modelOpen || modelCatalog !== null) return undefined
        let cancelled = false
        setModelCatalogNote('加载中…')
        fetch('/dsh-voice-polish/models')
          .then((response) => response.json())
          .then((body) => {
            if (cancelled) return
            if (body?.ok === true) setModelCatalog(body.value ?? { groups: [] })
            else setModelCatalogNote(body?.error?.message ?? '加载失败')
          })
          .catch((error) => {
            if (!cancelled) setModelCatalogNote(String(error?.message ?? error))
          })
        return () => {
          cancelled = true
        }
      }, [modelOpen, modelCatalog])

      /** Pick a polish model, or null to follow the session default again. */
      const pickModel = (next) => {
        if (overrideSaving) return
        setOverrideSaving(true)
        setOverrideNote('')
        fetch('/dsh-voice-polish/config', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(next ? { provider: next.provider, model: next.model } : { clear: true }),
        })
          .then((response) => response.json())
          .then((body) => {
            setOverrideSaving(false)
            if (body?.ok === true) {
              setOverride(next)
              setOverrideNote('已切换 —— 下一次整理生效')
            } else {
              setOverrideNote(body?.error?.message ?? '切换失败')
            }
          })
          .catch((error) => {
            setOverrideSaving(false)
            setOverrideNote(String(error?.message ?? error))
          })
      }

      useEffect(() => {
        let cancelled = false
        fetch(VOCAB_URL)
          .then((response) => response.json())
          .then((body) => {
            if (!cancelled && body?.ok === true) setVocab(String(body.value?.text ?? ''))
          })
          .catch(() => {
            if (!cancelled) setVocab('')
          })
        return () => {
          cancelled = true
        }
      }, [])

      const saveVocab = () => {
        if (vocabSaving) return
        setVocabSaving(true)
        setVocabNote('')
        fetch(VOCAB_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text: vocab ?? '' }),
        })
          .then((response) => response.json())
          .then((body) => {
            setVocabSaving(false)
            if (body?.ok === true) {
              setVocabDirty(false)
              setVocabNote('已保存 —— 下一次整理开始生效')
            } else {
              setVocabNote(body?.error?.message ?? '保存失败')
            }
          })
          .catch((error) => {
            setVocabSaving(false)
            setVocabNote(String(error?.message ?? error))
          })
      }
      // Keep both cards where the user put them: the polished result landing
      // must not auto-collapse the raw card. Toggling stays manual.

      // When the clipboard could not be read, the raw editor is the paste target:
      // put the caret there and say so.
      useEffect(() => {
        if (state.pasteHint === true) rawEditorRef.current?.focus()
      }, [state.pasteHint])

      // Clear a pending style confirmation after a short window.
      useEffect(() => {
        if (confirmingStyle === null) return undefined
        const timer = setTimeout(() => setConfirmingStyle(null), 3000)
        return () => clearTimeout(timer)
      }, [confirmingStyle])

      // NOTE: no unmount-cancel here on purpose. Switching sidebar tabs (e.g.
      // opening a file) unmounts this component, and killing the capture then
      // would silently abort a recording the user is mid-way through. The
      // recorder is module-owned: it keeps running, the 115s auto-stop bounds
      // it, and the always-visible toolbar 🎤 still stops it on demand.

      const busy = state.status === 'working'
      // Visibility is opt-IN for the dock only. Every sidebar host must render
      // something: a descriptor registered by an EARLIER instance of this module
      // carries no flags at all, and a blank tab tells the user nothing. So the
      // default is "render", and the dock explicitly opts into hiding.
      const visible = props.dockMode === true ? state.open || state.recording || busy : true
      if (!visible) return null

      const onStyle = (styleId) => {
        const current = ensureState(sessionId)
        if (current.raw.trim().length === 0) return
        // A style switch rewrites everything; with hand edits on screen it must
        // be a deliberate second click, never a slip.
        if (current.edited && confirmingStyle !== styleId) {
          setConfirmingStyle(styleId)
          return
        }
        setConfirmingStyle(null)
        patch(sessionId, { style: styleId })
        runPolish(sessionId, current.raw, styleId, null)
      }

      const onUndoSegment = () => {
        const current = ensureState(sessionId)
        if (current.segments.length === 0) return
        const removed = current.segments[current.segments.length - 1]
        const segments = current.segments.slice(0, -1)
        // Remove the appended piece from the raw text (last occurrence wins —
        // it is the one this undo targets).
        let raw = current.raw
        const at = raw.lastIndexOf(removed)
        if (at >= 0) raw = `${raw.slice(0, at)}${raw.slice(at + removed.length)}`.replace(/\n{2,}/g, '\n').trim()
        if (segments.length === 0 && raw.trim().length === 0) {
          // Full reset, including a seq bump so a still-flying polish of the
          // removed segment cannot land afterwards.
          discard(sessionId)
          return
        }
        // The polished text no longer corresponds to the raw: force a full repolish.
        patch(sessionId, { segments, raw, polishedSourceOf: '' })
        runPolish(sessionId, raw, current.style, null)
      }

      const copyText = (text, what) => {
        if (text.length === 0) return
        try {
          navigator.clipboard.writeText(text).then(
            () => flashHint(sessionId, `已复制${what}`),
            () => patch(sessionId, { status: 'error', error: '复制失败，请手动选中复制' }),
          )
        } catch {
          patch(sessionId, { status: 'error', error: '当前环境不支持自动复制，请手动选中复制' })
        }
      }

      /**
       * One shared send path for both buttons. A successful send retires the whole
       * panel, so nothing stays editable for an accidental duplicate send — and it
       * needs no toast: the text is in the conversation and the panel is gone.
       */
      const sendText = (text, what) => {
        const current = ensureState(sessionId)
        if (text.trim().length === 0 || current.sending) return
        patch(sessionId, { sending: true, error: '' })
        Promise.resolve()
          .then(() => props.send(text))
          .then(() => {
            discard(sessionId)
          })
          .catch((error) => {
            patch(sessionId, { sending: false, error: `发送失败：${String(error?.message ?? error)}` })
          })
      }

      const onSendRaw = () => sendText(ensureState(sessionId).raw.trim(), '原话')
      const onSendPolished = () => sendText(ensureState(sessionId).polished.trim(), '整理后的表述')

      const onClose = () => {
        if (state.recording) cancelRecording(sessionId)
        discard(sessionId)
      }

      const onMic = () => {
        toggleRecording(sessionId).catch(() => {
          // toggleRecording funnels every failure into the panel.
        })
      }

      const header = h(
        'div',
        { className: 'dvp-head' },
        h('span', { className: 'dvp-title' }, '🎤 语音整理'),
        h(
          'span',
          { className: 'dvp-meta' },
          state.recording
            ? `录音中 ${clock(elapsed)}`
            : state.raw.length > 0
              ? `${state.segments.length} 段 · ${state.raw.length} 字`
              : '',
        ),
        h('span', { className: 'dvp-spacer' }),
        h(Button, { label: '✕', title: '关闭面板（不发送任何内容）', variant: 'ghost', onClick: onClose }),
      )

      const starting = state.starting === true
      const hasContent = state.raw.length > 0 || state.polished.length > 0 || state.segments.length > 0
      const body = state.recording
        ? h(
            'div',
            null,
            h(LevelMeter, { sessionId }),
            h(
              'div',
              { className: 'dvp-status' },
              `🔴 正在录音 ${clock(elapsed)} ／ 上限 ${clock(RECORD_LIMIT_SECONDS)} —— 说完点「⏹ 停止并出文字」。`,
            ),
          )
        : starting
          ? h(
              'div',
              { className: 'dvp-status dvp-starting' },
              '🎤 正在启动麦克风…',
              h('div', { className: 'dvp-meter dvp-meter-idle' }),
            )
          : busy
          ? h('div', { className: 'dvp-status' }, '正在转写…')
          : !hasContent
          ? h(
              'div',
              null,
              h(
                'div',
                { className: 'dvp-status dvp-empty-hint' },
                h('div', null, '🎤 点输入框工具栏的 🎤 开始说话 —— 说完原话秒出。'),
                h('div', null, '📋 也可以点旁边的 📋 把剪贴板文字粘贴进来整理。'),
                h('div', { className: 'dvp-meta' }, `客户端 ${CLIENT_REV}`),
              ),
            )
          : h(
              'div',
              null,

              // ---- 原话：ready immediately, sendable as-is ----
              h(
                'div',
                { className: 'dvp-block' },
                h(
                  'div',
                  {
                    className: 'dvp-block-head dvp-block-toggle',
                    title: rawOpen ? '收起原话' : '展开原话',
                    onClick: () => setRawOpen(!rawOpen),
                  },
                  h('span', { className: 'dvp-chev' }, rawOpen ? '▾' : '▸'),
                  h('span', { className: 'dvp-block-title' }, '原话'),
                  h(
                    'span',
                    { className: 'dvp-meta' },
                    state.raw.length > 0 ? `${state.raw.length} 字 · 识别结果，可直接发` : '识别结果，说得没问题可直接发',
                  ),
                ),
                rawOpen
                  ? h('textarea', {
                      ref: rawEditorRef,
                      className: 'dvp-editor dvp-editor-raw',
                      value: state.raw,
                      spellCheck: false,
                      placeholder: state.pasteHint
                        ? '把要整理的文字粘贴（Ctrl+V）到这里，粘贴后自动整理。'
                        : '你说的原话会出现在这里。也可以直接把别处的文字粘贴进来整理。',
                      onChange: (event) => patch(sessionId, { raw: event.target.value, pasteHint: false }),
                      onPaste: (event) => {
                        const text = String(event.clipboardData?.getData('text') ?? '')
                        // Small pastes are part of ordinary editing; a substantial
                        // one is clearly "here is something to polish".
                        if (text.trim().length < 30) return
                        setTimeout(() => {
                          const current = ensureState(sessionId)
                          patch(sessionId, { pasteHint: false })
                          runPolish(sessionId, current.raw, current.style, null)
                        }, 0)
                      },
                    })
                  : null,
                h(
                  'div',
                  { className: 'dvp-row' },
                  h('span', { className: 'dvp-spacer' }),
                  h(Button, {
                    label: '📋 复制',
                    disabled: state.raw.length === 0 || state.sending,
                    onClick: () => copyText(ensureState(sessionId).raw, '原话'),
                  }),
                  h(Button, {
                    label: state.sending ? '发送中…' : '🚀 发原话',
                    title: '把识别出的原话直接发给 AI',
                    variant: 'primary',
                    disabled: state.sending || state.raw.trim().length === 0,
                    onClick: onSendRaw,
                  }),
                ),
              ),

              // ---- 整理后：fills in whenever the background polish lands ----
              h(
                'div',
                { className: 'dvp-block' },
                h(
                  'div',
                  {
                    className: 'dvp-block-head dvp-block-toggle',
                    title: polishedOpen ? '收起整理结果' : '展开整理结果',
                    onClick: () => setPolishedOpen(!polishedOpen),
                  },
                  h('span', { className: 'dvp-chev' }, polishedOpen ? '▾' : '▸'),
                  h('span', { className: 'dvp-block-title' }, '✨ 整理后'),
                  h(
                    'span',
                    { className: 'dvp-meta' },
                    state.polishing
                      ? '整理中…'
                      : state.polished.length > 0
                        ? `${state.polished.length} 字`
                        : state.model.length > 0
                          ? state.model
                          : '更清晰、更有条理的版本',
                  ),
                ),
                state.polishing && state.polished.trim().length === 0
                  ? h('div', { className: 'dvp-editor dvp-editor-placeholder' }, '正在整理… 原话不用等，可以直接先发。')
                  : polishedOpen
                    ? h('textarea', {
                        className: 'dvp-editor',
                        value: state.polished,
                        spellCheck: false,
                        placeholder: '整理结果会出现在这里，发送前你可以直接改。',
                        onChange: (event) => patch(sessionId, { polished: event.target.value, edited: true }),
                      })
                    : null,
                state.polishError.length > 0
                  ? h(
                      'div',
                      { className: 'dvp-error' },
                      state.polishing
                        ? `⏳ ${state.polishError}`
                        : `⚠ 整理失败：${state.polishError}（原话不受影响，可直接发） `,
                      h(Button, {
                        label: state.polishing ? '整理中…' : '↻ 重试',
                        disabled: state.polishing || state.raw.trim().length === 0,
                        onClick: () => {
                          const current = ensureState(sessionId)
                          runPolish(sessionId, current.raw, current.style, null)
                        },
                      }),
                    )
                  : null,
                h(
                  'div',
                  { className: 'dvp-row' },
                  h('span', { className: 'dvp-spacer' }),
                  h(Button, {
                    label: '📋 复制',
                    disabled: state.polishing || state.polished.length === 0 || state.sending,
                    onClick: () => copyText(ensureState(sessionId).polished, '整理结果'),
                  }),
                  h(Button, {
                    label: state.sending ? '发送中…' : '🚀 发整理后',
                    title: '把整理后的表述发给 AI',
                    variant: 'primary',
                    disabled: state.polishing || state.sending || state.polished.trim().length === 0,
                    onClick: onSendPolished,
                  }),
                ),
              ),

              state.tip.length > 0 || state.gaps.length > 0
                ? h(
                    'div',
                    { className: 'dvp-block' },
                    h(
                      'div',
                      {
                        className: 'dvp-block-head dvp-block-toggle',
                        title: tipsOpen ? '收起整理建议' : '展开整理建议',
                        onClick: () => setTipsOpen(!tipsOpen),
                      },
                      h('span', { className: 'dvp-chev' }, tipsOpen ? '▾' : '▸'),
                      h('span', { className: 'dvp-block-title' }, '💡 整理建议'),
                    ),
                    tipsOpen
                      ? h(
                          'div',
                          null,
                          state.tip.length > 0
                            ? h('div', { className: 'dvp-tip' }, h('b', null, '表达建议：'), state.tip)
                            : null,
                          state.gaps.length > 0
                            ? h(
                                'div',
                                { className: 'dvp-gaps' },
                                '建议补充：',
                                h('ul', null, state.gaps.map((gap, index) => h('li', { key: index }, gap))),
                              )
                            : null,
                        )
                      : null,
                  )
                : null,

              // ---- 📚 词表：custom vocabulary the polish pass corrects towards ----
              h(
                'div',
                { className: 'dvp-block' },
                h(
                  'div',
                  {
                    className: 'dvp-block-head dvp-block-toggle',
                    title: vocabOpen ? '收起词表' : '展开词表',
                    onClick: () => setVocabOpen(!vocabOpen),
                  },
                  h('span', { className: 'dvp-chev' }, vocabOpen ? '▾' : '▸'),
                  h('span', { className: 'dvp-block-title' }, '📚 词表'),
                  h(
                    'span',
                    { className: 'dvp-meta' },
                    vocab === null
                      ? '加载中…'
                      : `${vocab.split('\n').filter((line) => line.trim().length > 0).length} 个词 · 识别纠错`,
                  ),
                ),
                vocabOpen && vocab !== null
                  ? h(
                      'div',
                      null,
                      h('textarea', {
                        className: 'dvp-editor dvp-editor-vocab',
                        value: vocab,
                        spellCheck: false,
                        placeholder: '一行一个词，例如：\nsubagent\nagent teams\nDSH',
                        onChange: (event) => {
                          setVocab(event.target.value)
                          setVocabDirty(true)
                        },
                      }),
                      h(
                        'div',
                        { className: 'dvp-row' },
                        h(
                          'span',
                          { className: 'dvp-meta' },
                          vocabDirty ? '有未保存的修改' : vocabNote.length > 0 ? vocabNote : '识别错的专业词加在这里，整理时自动纠正',
                        ),
                        h('span', { className: 'dvp-spacer' }),
                        h(Button, {
                          label: vocabSaving ? '保存中…' : '💾 保存词表',
                          disabled: vocabSaving || !vocabDirty,
                          onClick: saveVocab,
                        }),
                      ),
                    )
                  : vocabOpen
                    ? h('div', { className: 'dvp-status' }, '词表加载中…')
                    : null,
              ),
            )

      const styleRow = state.recording || starting
        ? null
        : h(
            'div',
            { className: 'dvp-row' },
            h('span', { className: 'dvp-meta' }, '整理方式：'),
            STYLES.map((style) =>
              h(Button, {
                key: style.id,
                label: confirmingStyle === style.id ? '确认覆盖？' : style.label,
                title:
                  confirmingStyle === style.id
                    ? '再点一次确认：你的手改会被覆盖'
                    : state.edited
                      ? `${style.title}（会覆盖你的手改，需点两次）`
                      : style.title,
                active: state.style === style.id,
                recording: confirmingStyle === style.id,
                disabled: state.polishing || state.raw.trim().length === 0,
                onClick: () => onStyle(style.id),
              }),
            ),
          )

      const actionRow = h(
        'div',
        { className: 'dvp-row' },
        h(Button, {
          label: state.recording ? '⏹ 停止并出文字' : starting ? '启动中…' : '🎤 继续说',
          title: state.recording
            ? '停止录音，原话马上就能发'
            : starting
              ? '麦克风正在启动'
              : '再录一段，自动接到后面',
          recording: state.recording,
          disabled: starting,
          onClick: onMic,
        }),
        h(Button, {
          label: '↩ 撤销上一段',
          title: '丢掉最后一段语音，按剩下的重新整理',
          disabled: busy || state.recording || starting || state.segments.length === 0,
          onClick: onUndoSegment,
        }),
        h(Button, {
          label: state.polishing ? '整理中…' : '🔁 重新整理',
          title: '按当前方式把原话重新整理一遍',
          disabled: state.polishing || starting || state.raw.trim().length === 0,
          onClick: () => {
            const current = ensureState(sessionId)
            runPolish(sessionId, current.raw, current.style, null)
          },
        }),
      )

      const modelRowLabel = override ? `${override.provider} / ${override.model}` : '跟随会话默认'

      const modelBlock = state.recording || starting
        ? null
        : h(
            'div',
            { className: 'dvp-block' },
            h(
              'div',
              {
                className: 'dvp-block-head dvp-block-toggle',
                title: modelOpen ? '收起模型列表' : '换一个模型来整理',
                onClick: () => setModelOpen(!modelOpen),
              },
              h('span', { className: 'dvp-chev' }, modelOpen ? '▾' : '▸'),
              h('span', { className: 'dvp-block-title' }, '⚙ 整理模型'),
              h('span', { className: 'dvp-meta' }, modelRowLabel),
            ),
            modelOpen
              ? h(
                  'div',
                  { className: 'dvp-model-list' },
                  h(Button, {
                    label: '跟随会话默认模型',
                    title: '用当前会话的默认模型整理（在设置里改，这里自动跟随）',
                    active: override === null,
                    disabled: overrideSaving,
                    onClick: () => pickModel(null),
                  }),
                  modelCatalog === null
                    ? h('div', { className: 'dvp-status' }, modelCatalogNote.length > 0 ? modelCatalogNote : '加载中…')
                    : modelCatalog.groups.map((group) =>
                        h(
                          'div',
                          { key: group.provider },
                          h('div', { className: 'dvp-model-group' }, `${group.name}（${group.provider}）`),
                          group.models.map((model) =>
                            h(Button, {
                              key: `${group.provider}/${model.id}`,
                              label: model.name,
                              title: `${group.provider} / ${model.id}`,
                              active: override?.provider === group.provider && override?.model === model.id,
                              disabled: overrideSaving,
                              onClick: () => pickModel({ provider: group.provider, model: model.id }),
                            }),
                          ),
                        ),
                      ),
                  modelCatalogNote.length > 0 && modelCatalog !== null
                    ? h('div', { className: 'dvp-status' }, overrideNote.length > 0 ? overrideNote : modelCatalogNote)
                    : overrideNote.length > 0
                      ? h('div', { className: 'dvp-status' }, overrideNote)
                      : null,
                )
              : null,
          )

      return h(
        'div',
        { className: 'dvp-card' },
        header,
        body,
        state.status === 'error' && state.error.length > 0 ? h('div', { className: 'dvp-error' }, `⚠ ${state.error}`) : null,
        state.hint.length > 0 ? h('div', { className: 'dvp-hint' }, `✓ ${state.hint}`) : null,
        styleRow,
        actionRow,
        modelBlock,
        state.model.length > 0 ? h('div', { className: 'dvp-status' }, `整理模型：${state.model}`) : null,
      )
    }

    // ---------------------------------------------------------------------
    // Plugin entry.
    // ---------------------------------------------------------------------

    /**
     * Register the microphone button and the review panel.
     *
     * The whole body is guarded: the web shell fails its entire boot when a
     * plugin's `apply` throws, so a missing service or an undeclared slot must
     * degrade to a logged no-op instead.
     *
     * @param {object} ctx - client runtime context.
     */
    function apply(ctx) {
      try {
        // First line of the bundle: proves which build the browser actually ran.
        log('client bundle loaded', { rev: CLIENT_REV })
        injectStyles()
        try {
          applyBrandContrast()
          watchBrandContrast()
        } catch (error) {
          log('brand contrast probe failed; falling back to hardcoded white', { error: String(error) })
        }
        ctx.inject(['slots', 'sessions'], (slotsCtx) => {
          // Deferred callbacks run outside this try; each gets its own guard so
          // one bad slot registration can never take the whole shell down.
          try {
            const slots = slotsCtx.slots
            clientCtx = slotsCtx

            slots.inject('conversation.input.left', () =>
              slots.register(
                {
                  name: 'conversation.input.left',
                  id: 'voice-polish',
                  order: 40,
                  label: () => '语音整理',
                  inject: (sessionId) => ({ sessionId }),
                },
                MicButton,
              ),
            )

            slots.inject('conversation.input.left', () =>
              slots.register(
                {
                  name: 'conversation.input.left',
                  id: 'voice-polish-paste',
                  order: 41,
                  label: () => '粘贴整理',
                  inject: (sessionId) => ({ sessionId }),
                },
                PasteButton,
              ),
            )

            // Dock fallback: renders nothing while the BetterSidebar tab hosts
            // the panel (see the sidebar injection below).
            slots.inject('conversation.input.dock', () =>
              slots.register(
                {
                  name: 'conversation.input.dock',
                  id: 'voice-polish',
                  order: 15,
                  inject: (sessionId) => ({ sessionId }),
                },
                PolishPanel,
              ),
            )

            // Plugin unload (HMR / shutdown) is the ONLY outside event that may
            // cancel a live recording — sidebar tab switches must not.
            return () => {
              for (const sessionId of [...recorders.keys()]) cancelRecording(sessionId)
            }
          } catch (error) {
            console.error('[dsh-voice-polish] slot registration failed:', error)
          }
        })

        // OFFICIAL right sidebar — the preferred host, and the only one DSH itself
        // supports. The tab TYPE is contributed through `sidebarRightTabs.register`
        // (one registration per id, owned by an effect so it lives exactly as long
        // as this plugin), the BODY through the keyed `sidebar.right.pane.tab` seat,
        // and the chip title through `sidebar.right.pane.tab.title`. The `guide`
        // entry is the door users find the panel through.
        ctx.inject(['slots', 'sidebarRightTabs', 'sidebarRight'], (officialCtx) => {
          try {
            const tabs = officialCtx.sidebarRightTabs
            if (tabs === undefined || typeof tabs.register !== 'function') return undefined
            if (typeof officialCtx.effect !== 'function') {
              // Without effect() the registration cannot be owned by this plugin's
              // lifetime, and an unowned registration is what strands a reloaded
              // instance. Degrade to the dock instead of registering wrongly.
              log('official sidebar skipped: context has no effect() to own the registration', {})
              return undefined
            }

            // Reuse defence: the registry THROWS on an id it already holds, and this
            // module can be evaluated more than once per page (HMR, or a re-run of
            // apply). A previous instance owning the id is success, not a failure —
            // letting the throw escape would leave the panel with no host at all.
            if (typeof tabs.get === 'function' && tabs.get(OFFICIAL_TAB_KIND) !== undefined) {
              panelHost = 'official'
              revealFailed = false
              log('official sidebar type already registered by an earlier instance — reusing it', { kind: OFFICIAL_TAB_KIND })
              return undefined
            }

            const disposeType = officialCtx.effect(
              () =>
                officialCtx.sidebarRightTabs.register({
                  id: OFFICIAL_TAB_ID,
                  kind: OFFICIAL_TAB_KIND,
                  // Third-party contributions ride the `extension` band (the default);
                  // a `builtin` of the same kind would be shadowed by it, never broken.
                  priority: 'extension',
                  title: () => '语音整理',
                  // Keep the pane mounted across tab switches, so a recording started
                  // here is not torn down by the user looking at another file.
                  keepMounted: true,
                  // The discovery door: the guide lists this entry, and picking it
                  // opens this kind. `title`/`description` are called fresh on render,
                  // so they stay localizable.
                  guide: [
                    {
                      id: 'voice-polish',
                      order: 45,
                      title: () => '语音整理',
                      description: () => '把口述转成清晰表达 —— 右侧栏对照原话与整理结果',
                    },
                  ],
                }),
              'dsh-voice-polish: sidebar tab type',
            )

            // The body and the chip title are the SAME components the other hosts
            // render; an inline copy here is what previously drifted and blanked.
            officialCtx.slots.inject('sidebar.right.pane.tab', () =>
              officialCtx.slots.register(
                {
                  name: 'sidebar.right.pane.tab',
                  key: OFFICIAL_TAB_ID,
                },
                OfficialPanelTab,
              ),
            )
            officialCtx.slots.inject('sidebar.right.pane.tab.title', () =>
              officialCtx.slots.register(
                {
                  name: 'sidebar.right.pane.tab.title',
                  key: OFFICIAL_TAB_ID,
                },
                OfficialPanelTitle,
              ),
            )

            panelHost = 'official'
            revealFailed = false
            log('official sidebar tab registered', { id: OFFICIAL_TAB_ID, kind: OFFICIAL_TAB_KIND })
            return () => {
              try {
                disposeType?.()
              } catch {
                // Disposal is best effort.
              }
            }
          } catch (error) {
            console.error('[dsh-voice-polish] official sidebar registration failed:', error)
            return undefined
          }
        })

        // Legacy right-sidebar placement (dsh-better-sidebar). Only ever the SECOND
        // choice: when DSH's own sidebar is present this host never registers, so
        // the user never sees two panels in the same column.
        ctx.inject(['betterSidebar'], (bctx) => {
          try {
            if (officialSidebarAvailable(bctx)) {
              log('official right sidebar is present — the better-sidebar host stands down', {})
              return undefined
            }
            const service = bctx.betterSidebar
            if (service === undefined || typeof service.registerTab !== 'function') return undefined
            if (typeof bctx.effect !== 'function') {
              log('better-sidebar host skipped: context has no effect() to own the registration', {})
              return undefined
            }

            // The registry THROWS on a duplicate id, and this module can be
            // evaluated more than once per page (HMR, or a re-run of apply). A
            // previous instance may therefore already own the id: treat that as
            // success instead of letting the throw strand this instance.
            const existing = typeof service.getTab === 'function' ? service.getTab(VOICE_TAB_ID) : undefined
            if (existing !== undefined) {
              sidebarTabReady = true
              panelHost = 'better'
              revealFailed = false
              log('better-sidebar tab already registered by an earlier instance — reusing it', { id: VOICE_TAB_ID })
              return undefined
            }

            // The registration is owned by an effect, so it lives exactly as long as
            // this plugin instance and a reloaded instance cannot collide with its
            // own predecessor's id.
            bctx.effect(
              () =>
                bctx.betterSidebar.registerTab({
                  id: VOICE_TAB_ID,
                  title: () => '语音整理',
                  single: true,
                  order: 55,
                  // The shared tab component, never an inline copy: the inline
                  // version had drifted and lost its visibility rule, so an idle
                  // panel (no recording, nothing said yet) rendered blank.
                  component: (tabProps) => h(SidebarPanelTab, tabProps),
                }),
              'dsh-voice-polish: better-sidebar tab',
            )
            sidebarTabReady = true
            panelHost = 'better'
            revealFailed = false
            log('sidebar tab registered (dsh-better-sidebar)', { id: VOICE_TAB_ID })
            return undefined
          } catch (error) {
            console.error('[dsh-voice-polish] better-sidebar tab registration failed:', error)
            return undefined
          }
        })
      } catch (error) {
        console.error('[dsh-voice-polish] client apply failed:', error)
      }
    }

    exports.name = 'dsh-voice-polish/client'
    exports.apply = apply
    return module.exports
  },
})
