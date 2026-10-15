/**
 * Construction of the plugin-sourced user message handed to the agent.
 *
 * Why this is built locally instead of with the package's own factory:
 * `@deepseek-ai/dsh-llm` exports `createUserMessage()`, but a bare specifier
 * cannot be resolved from this repository (measured: ERR_MODULE_NOT_FOUND,
 * because the dsh packages live under the dsh profile, not under this repo).
 * The runtime shape below is transcribed from the installed type definitions:
 *
 *   - `@deepseek-ai/dsh-llm` message.d.ts
 *       interface Message { readonly id: MessageId; readonly role: 'system'|'user'|'assistant';
 *                           readonly content: ContentBlock[]; readonly source: MessageSource }
 *       interface UserMessage extends Message { readonly role: 'user' }
 *       MessageSourceMap.plugin = { kind: 'plugin'; plugin: string } & ContextFormed
 *   - `@deepseek-ai/dsh-llm` types.d.ts
 *       interface TextBlock { type: 'text'; text: string }
 *       ContentBlockMap = { text, reasoning, image, 'tool-call', 'tool-result' }
 *   - `@deepseek-ai/dsh-llm` brand.d.ts
 *       type MessageId = Branded<'MessageId'>  (a TypeScript-only brand; a plain string at runtime)
 *
 * Re-verify these shapes against the installed package after a dsh upgrade.
 */

import { randomUUID } from 'node:crypto'

/** Plugin identity used in the message id. Matches the registered command. */
export const PLUGIN_NAME = '1tempo'

/** Forbidden control characters; tab and newline are allowed. */
const FORBIDDEN_CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u

/**
 * Build one immutable user message for delivery.
 *
 * SOURCE SHAPE — `{ kind: 'user' }`, decided by the user on 2026-10-15.
 *
 * The harness draws the human/plugin line at exactly one place
 * (`dsh-adapter/trajectory/projection.js`):
 *
 *   const isHuman = sourceKind === 'user';
 *   // A direct human prompt is a USER row; everything else on the user-role
 *   // surface (skill bodies, file-change notices, goal continuations) is an
 *   // injected CONTEXT row
 *
 * `/rewind` uses the same test (`dsh-adapter/sessionTree.js`,
 * `session-lineage.js` exclude `source.kind !== 'user'`). A plugin-sourced
 * message (`plugin:<name>`) is therefore a CONTEXT row: it is not the user's
 * own message, cannot be recognised by their words, and cannot be a rewind
 * target. It is also not rendered as a normal conversation row, and adding a
 * context `form` to it (measured 2026-10-15) removes the row entirely.
 *
 * The plugin cannot put text in the input draft either (`actions.submit` is
 * `@internal`; `tuiPanels.sendToChat` is constantly `false`), so the only way
 * to make the delivered MiL appear as the user's own message — and to make
 * `/rewind` work — is to declare `kind: 'user'`.
 *
 * THE COST, stated plainly: the session log then attributes a plugin-written
 * message to the user. The conversion provenance lives in the plugin's own
 * storage log (original, MiL, wire, message id) and in the command's
 * notification instead. See qa-record.md §6.22 for the decision.
 *
 * @param {{ text: string, id?: string }} input
 * @returns {{ id: string, role: 'user', content: [{ type: 'text', text: string }],
 *             source: { kind: 'user' } }}
 */
export function createPluginUserMessage(input) {
  const text = input?.text
  if (typeof text !== 'string') throw new TypeError('createPluginUserMessage: text must be a string')
  if (text.trim().length === 0) throw new TypeError('createPluginUserMessage: text must not be empty')
  if (FORBIDDEN_CONTROL.test(text)) throw new TypeError('createPluginUserMessage: text contains control characters')

  const id = input.id ?? `${PLUGIN_NAME}-${randomUUID()}`
  if (typeof id !== 'string' || id.length === 0) {
    throw new TypeError('createPluginUserMessage: id must be a non-empty string')
  }

  const message = {
    id,
    role: /** @type {'user'} */ ('user'),
    content: [Object.freeze({ type: /** @type {'text'} */ ('text'), text })],
    source: Object.freeze({ kind: /** @type {'user'} */ ('user') }),
  }
  Object.freeze(message.content)
  return Object.freeze(message)
}

/**
 * Check that a value has the runtime shape the agent expects.
 *
 * Used before delivery so a wrong object fails loudly at this boundary instead
 * of being written into the session log.
 *
 * @param {unknown} message
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export function assertPluginUserMessage(message) {  if (message === null || typeof message !== 'object') return { ok: false, reason: 'メッセージがオブジェクトではありません。' }
  const value = /** @type {Record<string, unknown>} */ (message)
  if (typeof value.id !== 'string' || value.id.length === 0) return { ok: false, reason: 'id がありません。' }
  if (value.role !== 'user') return { ok: false, reason: `role が user ではありません: ${String(value.role)}` }
  if (!Array.isArray(value.content) || value.content.length === 0) return { ok: false, reason: 'content が空です。' }
  const block = value.content[0]
  if (block === null || typeof block !== 'object' || block.type !== 'text' || typeof block.text !== 'string') {
    return { ok: false, reason: '先頭の content ブロックが text ではありません。' }
  }
  const source = value.source
  if (source === null || typeof source !== 'object') {
    return { ok: false, reason: 'source がありません。' }
  }
  const kind = source.kind
  if (typeof kind !== 'string' || kind.length === 0) {
    return { ok: false, reason: 'source.kind が空です。' }
  }
  // `kind: 'user'` is what makes the harness treat this as the person's own
  // message (`isHuman = sourceKind === 'user'`) — a user row rather than a
  // context row, and a `/rewind` target. Any other kind would silently become
  // context (measured 2026-10-15).
  if (kind !== 'user') {
    return { ok: false, reason: `source.kind が user ではありません（context 行になり会話に出ません）: ${kind}` }
  }
  // A context form would reclassify the row as context on some surfaces.
  if (source.form !== undefined) {
    return { ok: false, reason: `source.form は使えません（context 行になるため）: ${String(source.form)}` }
  }
  return { ok: true }
}
