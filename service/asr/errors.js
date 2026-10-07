/**
 * dsh-voice-polish service — ASR error types.
 *
 * Kept in their own module so `cloud.js` and `index.js` can both throw and catch
 * them without an import cycle. They exist so callers can tell three genuinely
 * different situations apart instead of seeing one generic 500:
 *
 *   ASR_NOT_IMPLEMENTED  the provider exists but is not wired yet (local, P2)
 *   ASR_NOT_CONFIGURED   the provider is wired but its env vars are incomplete
 *   ASR_FAILED           the provider was called and the call failed
 *
 * @module dsh-voice-polish/service/asr/errors
 */

/** Base class for every ASR failure this service raises deliberately. */
export class AsrError extends Error {
  /**
   * @param {string} message - human-readable reason.
   * @param {{ provider?: string, phase?: string, code?: string }} [details] - machine-readable context.
   */
  constructor(message, { provider, phase, code = 'ASR_FAILED' } = {}) {
    super(message)
    this.name = 'AsrError'
    this.code = code
    this.provider = provider
    this.phase = phase
  }
}

/** The provider is known but its inference path is not wired yet. */
export class AsrUnavailableError extends AsrError {
  /**
   * @param {string} message - why it is unavailable, and which phase owns it.
   * @param {{ provider?: string, phase?: string }} [details] - context.
   */
  constructor(message, details = {}) {
    super(message, { ...details, code: 'ASR_NOT_IMPLEMENTED' })
    this.name = 'AsrUnavailableError'
  }
}

/** The provider is wired but its configuration is incomplete — never silent. */
export class AsrConfigError extends AsrError {
  /**
   * @param {string} message - which variable is missing and what to set.
   * @param {{ provider?: string, phase?: string, missing?: string[] }} [details] - context.
   */
  constructor(message, details = {}) {
    super(message, { ...details, code: 'ASR_NOT_CONFIGURED' })
    this.name = 'AsrConfigError'
    this.missing = details.missing ?? []
  }
}
