/**
 * Conversion log, stored through dsh's `storage.local` surface.
 *
 * Measured contract (`@deepseek-harness-tui/dsh-tui` plugin-storage.d.ts):
 *   ctx.tuiPluginStorage.open(pluginCtx) → { get({key}), set({key,value}), delete({key}) }
 *   backend: ~/.dsh-tui/plugin-storage/<namespace>.json, one flat JSON object
 *   quota: 256 keys AND 256 KiB serialized per namespace
 *   grants: get needs storage.local.read, set/delete need storage.local.write
 *   values must be exact JSON values (undefined/NaN/class instances are rejected)
 *
 * The quota forbids an unbounded append, so the log is one bounded ring under a
 * single key plus a counter. A failed write is reported, never silently
 * swallowed: the caller shows it and the in-memory copy keeps the session's
 * records for the report.
 */

/** Key holding the bounded record array. */
export const LOG_KEY = 'entries'
/** Key holding the cumulative record count. */
export const LOG_COUNTER_KEY = 'total'
/** Ring size. Kept small because the namespace shares a 256 KiB quota. */
export const MAX_RECORDS = 50
/** Per-record byte ceiling. */
export const MAX_RECORD_BYTES = 4096

/**
 * Build one JSON-safe record. Values are exact JSON scalars only.
 *
 * @param {{
 *   original: string, mil: string, wire: string, backtranslation?: string | null,
 *   model: string, attempts: number, approved: boolean, delivered: boolean,
 *   messageId?: string | null, at?: string,
 * }} input
 */
export function makeRecord(input) {
  return {
    at: input.at ?? new Date().toISOString(),
    original: input.original,
    mil: input.mil,
    wire: input.wire,
    backtranslation: input.backtranslation ?? null,
    model: input.model,
    attempts: input.attempts,
    approved: input.approved,
    delivered: input.delivered,
    messageId: input.messageId ?? null,
  }
}

/**
 * @param {{
 *   handle?: { get: (input: { key: string }) => Promise<{ value: unknown }>,
 *              set: (input: { key: string, value: unknown }) => Promise<{ stored: true }> } | undefined,
 *   resolveHandle?: () => Promise<typeof options.handle>,
 *   maxRecords?: number,
 *   maxRecordBytes?: number,
 * }} options
 */
export function createLogStore(options = {}) {
  let handle = options.handle
  const resolveHandle = options.resolveHandle
  const maxRecords = options.maxRecords ?? MAX_RECORDS
  const maxRecordBytes = options.maxRecordBytes ?? MAX_RECORD_BYTES
  /** Session copy, also the fallback when storage is unavailable or failing. */
  let memory = []
  let total = 0
  let lastFailure

  /**
   * Resolve the storage handle at most once per store.
   *
   * The store is created once per plugin activation, so a session keeps one
   * in-memory ring across commands when storage is unavailable. Resolving
   * lazily keeps `apply()` synchronous.
   */
  async function ensureHandle() {
    if (handle !== undefined) return handle
    if (typeof resolveHandle !== 'function') return undefined
    try {
      handle = await resolveHandle()
    } catch {
      handle = undefined
    }
    return handle
  }

  async function readEntries() {
    const active = await ensureHandle()
    if (active === undefined) return { entries: memory }
    try {
      const result = await active.get({ key: LOG_KEY })
      const value = result?.value
      if (value === null || value === undefined) return { entries: [] }
      if (!Array.isArray(value)) {
        return { entries: memory, error: '保存済みのログが配列ではありません。上書きせず、セッション内の記録のみ保持します。' }
      }
      return { entries: value }
    } catch (error) {
      return { entries: memory, error: `保存済みログの読み出しに失敗: ${error?.code ?? error?.message ?? String(error)}` }
    }
  }

  return {
    get available() {
      return handle !== undefined || typeof resolveHandle === 'function'
    },
    get lastFailure() {
      return lastFailure
    },
    /** Records held in this session (successfully persisted or not). */
    get sessionEntries() {
      return [...memory]
    },
    entries: readEntries,
    /**
     * Append one record. Never throws; a failure is returned with its reason so
     * the caller can show it instead of implying the log was written.
     *
     * Without a storage handle this reports `ok: false`: keeping a session copy
     * is not the same as saving, and the caller prints the result to the user.
     */
    async append(record) {
      let json
      try {
        json = JSON.stringify(record)
      } catch (error) {
        return { ok: false, reason: `記録を JSON 化できません: ${error?.message ?? String(error)}` }
      }
      if (json === undefined) return { ok: false, reason: '記録が JSON 化できません（undefined を含む）。' }
      const bytes = Buffer.byteLength(json, 'utf8')
      if (bytes > maxRecordBytes) {
        return { ok: false, reason: `記録が大きすぎます (${bytes} > ${maxRecordBytes} バイト)。` }
      }

      const active = await ensureHandle()
      if (active === undefined) {
        memory = [...memory, record].slice(-maxRecords)
        lastFailure = 'storage.local が使えないため未保存（セッション内保持）'
        return { ok: false, reason: lastFailure, sessionOnly: true }
      }

      const current = await readEntries()
      if (current.error) {
        memory = [...current.entries, record].slice(-maxRecords)
        lastFailure = current.error
        return { ok: false, reason: current.error }
      }

      const next = [...current.entries, record].slice(-maxRecords)
      try {
        await active.set({ key: LOG_KEY, value: next })
        await active.set({ key: LOG_COUNTER_KEY, value: total + 1 })
      } catch (error) {
        memory = next
        lastFailure = `storage への書き込みに失敗: ${error?.code ?? error?.message ?? String(error)}`
        return { ok: false, reason: lastFailure }
      }
      memory = next
      total += 1
      lastFailure = undefined
      return { ok: true, count: next.length, total, bytes }
    },
  }
}
