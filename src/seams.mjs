/**
 * Soft probes for optional dsh seams.
 *
 * Measured 2026-10-14: a REJECTED optional seam rolled back the whole plugin
 * activation (an invalid settings-section namespace took the command down with
 * it), so every optional service is probed here. A composition that does not
 * mount one returns `undefined` instead of throwing, and the caller reports it
 * in the activation log line rather than assuming it works.
 */

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {string} key
 * @returns {any | undefined}
 */
export function softGet(ctx, key) {
  try {
    const value = ctx.get(key, false)
    return value ?? undefined
  } catch {
    return undefined
  }
}
