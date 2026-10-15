/**
 * Web-host persistence: `ctx.storageDomain` (the dsh server-side storage stack).
 *
 * Measured 2026-10-15 against dsh-storage-domain 0.2.0-rc.2:
 *   ctx.storageDomain.open(spec) → domain; domain.table(name) → KvTable
 *   KvTable: get(key) synchronous from memory | put(key, value) durable |
 *            entries() | delete(key) | update(key, fn)
 *   The stored value is validated at the durable read boundary with
 *   `tableSpec.valueSchema.parse(raw)` (lib/index.js:371), and `domainTable(schema)`
 *   is literally `{ valueSchema: schema }` (lib/index.js:47) — a schema is any
 *   object with `parse`. This module therefore builds the spec literally instead
 *   of importing `@deepseek-ai/dsh-storage-domain`: a local plugin file is loaded
 *   by path, so bare specifiers do not resolve from here (measured 2026-10-14,
 *   the same reason the message objects are built locally).
 *   Domain and table names must match /^[a-z][a-z0-9_]*$/ (dsh-storage lib:80).
 *   `@deepseek-ai/dsh-base` mounts the `json` backend with
 *   `root: dshHomePath('storages')`, so a `single`-layout domain lands in
 *   `<dsh home>/storages/<name>.json`.
 *
 * Host split (both measured): the TUI's `tuiPluginStorage` does not exist in the
 * web host, and `storageDomain` is not mounted by the TUI host (no dsh-storage
 * rows in dsh-tui's cordis.yml), so the two are alternatives, not a hierarchy.
 */

import { softGet } from './seams.mjs'

/** Domain name; doubles as the backend unit name and the on-disk file name. */
export const DOMAIN_NAME = 'tempo_bridge'
/** Table holding this plugin's values. */
export const TABLE_NAME = 'entries'
/** Schema version of the domain declaration. */
export const DOMAIN_VERSION = 1

/**
 * The table's value schema: the log store writes an array under `entries` and a
 * number under `total`. Both are plain JSON values, and `createLogStore` owns
 * the ring/byte limits, so the schema only rejects what the store cannot read
 * back (anything that is neither an array nor a number).
 */
function tempoLogSchema() {
  return {
    parse(raw) {
      if (Array.isArray(raw) || typeof raw === 'number') return raw
      throw new TypeError('1tempo: 保存された値が配列でも数値でもありません。')
    },
  }
}

/** The domain declaration passed to `storageDomain.open()`. */
export function tempoLogSpec() {
  return {
    name: DOMAIN_NAME,
    version: DOMAIN_VERSION,
    // A record this build cannot read is moved aside by the backend instead of
    // blocking `open()` (dsh-storage-domain spec: `invalidRecords`).
    invalidRecords: 'backup-and-skip',
    tables: { [TABLE_NAME]: { valueSchema: tempoLogSchema() } },
  }
}

/**
 * Open the domain and adapt its table to the handle shape `createLogStore`
 * expects (`get({key})` / `set({key, value})`).
 *
 * Returns `undefined` when the service is absent or the open fails, so the
 * caller reports "not saved" instead of implying success.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @returns {Promise<{ get: Function, set: Function, close: () => Promise<void> } | undefined>}
 */
export async function openStorageDomainHandle(ctx) {
  const facility = softGet(ctx, 'storageDomain')
  if (!facility || typeof facility.open !== 'function') return undefined

  let domain
  try {
    domain = await facility.open(tempoLogSpec())
  } catch {
    return undefined
  }
  if (!domain || typeof domain.table !== 'function') return undefined

  let table
  try {
    table = domain.table(TABLE_NAME)
  } catch {
    return undefined
  }
  if (!table || typeof table.get !== 'function' || typeof table.put !== 'function') return undefined

  return {
    // KvTable reads are synchronous; the store's handle contract is async.
    async get({ key }) {
      const value = table.get(key)
      return { value: value === undefined ? null : value }
    },
    async set({ key, value }) {
      await table.put(key, value)
      return { stored: true }
    },
    async close() {
      await domain.close?.()
    },
  }
}
