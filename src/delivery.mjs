/**
 * Delivery of the approved MiL to the running agent.
 *
 * Kept out of index.mjs so the delivery rules — the notification budget, the
 * agent choice, the message body, the log outcome — are unit-testable without
 * the whole command handler.
 *
 * Measured boundaries this module encodes (2026-10-14/15):
 *   - a plugin command's result is rendered in the NOTIFICATION and clipped at
 *     `COMMAND_RESULT_CELLS = 200` (dsh-tui `screens/Chat.js`), so the result is
 *     built to FIT: the MiL first, then as many notes as the budget allows;
 *   - a `user/message` is the person's own row only when
 *     `source.kind === 'user'` (`dsh-adapter/trajectory/projection.js`), and
 *     `/rewind` uses the same test — any other kind is a context row that is
 *     not shown and cannot be rewound to;
 *   - the delivered `content` is both what the conversation shows and what the
 *     model reads, so nothing may be added to it "just for display".
 */

import { assertPluginUserMessage, createPluginUserMessage } from './message.mjs'
import { softGet } from './seams.mjs'

/** Host cap for one command result, in cells (dsh-tui `COMMAND_RESULT_CELLS`). */
export const NOTIFY_CELLS = 200

/**
 * Fold text exactly the way the host does before it measures and clips.
 *
 * Measured in dsh-tui `lib/types/sanitize.js` (`cleanRenderText`, which
 * `cleanScalarText` delegates to): ANSI sequences are removed, control bytes
 * become spaces, runs of whitespace collapse to one space, and the result is
 * trimmed into a SINGLE line. The host then measures that line, so a plugin
 * that wants nothing clipped has to budget on the same string: its own layout
 * (newlines, indentation) does not survive into the notification or the edit
 * dialog's initial value.
 *
 * @param {string} text
 * @returns {string}
 */
export function flattenForHost(text) {
  // eslint-disable-next-line no-control-regex -- deliberate: mirror the host's sanitizer
  return String(text).replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').replace(/\s+/g, ' ').trim()
}

/**
 * East Asian Wide/Fullwidth code points (UAX #11 W and F), which take 2 cells.
 *
 * Ambiguous-width characters count as 1: the host measures with
 * `get-east-asian-width` and `{ ambiguousAsWide: false }`.
 *
 * The emoji blocks are listed as whole blocks so the measure errs WIDE
 * (U+1F680 rocket, U+1F7E0 shapes, U+1FA70 symbols). Measured 2026-10-15 with
 * `tools/check-cell-width.mjs`: omitting them under-counted `🚀` as 1 cell where
 * the host paints 2, which would have let the host clip the notification.
 */
function isWideCodePoint(codePoint) {
  return (
    (codePoint >= 0x1100 && codePoint <= 0x115f) ||
    (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
    (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
    (codePoint >= 0xff01 && codePoint <= 0xff60) ||
    (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
    (codePoint >= 0x1f300 && codePoint <= 0x1f64f) ||
    (codePoint >= 0x1f680 && codePoint <= 0x1f6ff) ||
    (codePoint >= 0x1f7e0 && codePoint <= 0x1f7eb) ||
    (codePoint >= 0x1f900 && codePoint <= 0x1f9ff) ||
    (codePoint >= 0x1fa70 && codePoint <= 0x1faff) ||
    (codePoint >= 0x20000 && codePoint <= 0x3fffd)
  )
}

/** Zero-width code points the host excludes from its count (`isZeroWidth`). */
function isZeroWidthCodePoint(codePoint) {
  if (codePoint < 0x20 || (codePoint >= 0x7f && codePoint <= 0x9f)) return true
  if (codePoint === 0x00ad || codePoint === 0xfeff) return true
  if (codePoint >= 0x0300 && codePoint <= 0x036f) return true
  if (codePoint >= 0x200b && codePoint <= 0x200d) return true
  if (codePoint >= 0x2060 && codePoint <= 0x2064) return true
  if (codePoint >= 0xfe00 && codePoint <= 0xfe0f) return true
  if (codePoint >= 0xfe20 && codePoint <= 0xfe2f) return true
  return false
}

/**
 * Terminal cell width, mirroring the host's `stringWidth` rules.
 *
 * Measured 2026-10-15 against dsh-tui `lib/types/ink/stringWidth.js`:
 *   - East Asian Wide/Fullwidth = 2 cells, ambiguous as NARROW;
 *   - combining marks, ZW joiners, variation selectors and controls = 0;
 *   - a base character followed by VS16 renders as a wide emoji = 2 cells.
 * Measuring `.length` (UTF-16 code units) underestimates Japanese, so the host
 * truncated with `…` even when `.length <= 200`.
 *
 * @param {string} text
 * @returns {number}
 */
export function cellWidth(text) {
  if (typeof text !== 'string' || text.length === 0) return 0
  const characters = [...text]
  let width = 0
  for (let index = 0; index < characters.length; index += 1) {
    const codePoint = characters[index].codePointAt(0)
    if (codePoint === undefined || isZeroWidthCodePoint(codePoint)) continue
    if (index + 1 < characters.length && characters[index + 1].codePointAt(0) === 0xfe0f) {
      width += 2
      index += 1
      continue
    }
    width += isWideCodePoint(codePoint) ? 2 : 1
  }
  return width
}

/**
 * Whether the host would render this text without adding its own ellipsis.
 *
 * @param {string} text
 * @param {number} [maxCells]
 * @returns {boolean}
 */
export function fitsHost(text, maxCells = NOTIFY_CELLS) {
  return cellWidth(flattenForHost(text)) <= maxCells
}

/**
 * Build the command result (the notification text).
 *
 * Nothing here truncates: notes are added only while they fit within the
 * host's display-cell budget (200 cells), so what is shown is complete. The MiL
 * comes first because the budget may not fit everything. The comparison uses
 * the host's own folding and measurement (`fitsHost`), otherwise a Japanese
 * note passes here and is clipped by the host.
 *
 * @param {string} headline
 * @param {string | undefined} mil
 * @param {readonly string[]} notes
 * @returns {string}
 */
export function notification(headline, mil, notes = []) {
  const parts = [`1tempo: ${headline}`]
  if (typeof mil === 'string' && mil.trim().length > 0) parts.push(`MiL: ${mil.trim()}`)
  for (const note of notes) {
    if (!fitsHost([...parts, note].join('\n'))) continue
    parts.push(note)
  }
  return parts.join('\n')
}

/**
 * Compose the delivered message body.
 *
 * OFF by default: the delivered `content` is both what the conversation shows
 * and what the model reads, so prefixing the request also hands it to the model
 * (measured: it lands in `agent/inbox/spliced`) and the point of sending a
 * compressed form is lost. Turning it on makes the row start with
 * `依頼: <原文>`, which is easier to recognise in `/rewind`.
 *
 * @param {string} text - the MiL payload that is handed to the model.
 * @param {string} original - the request the user typed.
 * @param {boolean} includeOriginal
 * @returns {string}
 */
export function composeDeliveryBody(text, original, includeOriginal) {
  const bare = typeof original === 'string' ? original.trim() : ''
  if (includeOriginal !== true || bare.length === 0) return text
  return `依頼: ${bare}\n\nMiL: ${text}`
}

/** One candidate row for an ambiguous agent set. */
export function candidateLine(agents) {
  return agents
    .map((agent) => `  - id: ${agent?.id ?? '不明'} / model: ${agent?.options?.model ?? '不明'}`)
    .join('\n')
}

function getAgents(ctx) {
  const registry = softGet(ctx, 'agents')
  return registry && typeof registry.list === 'function' ? registry : undefined
}

/**
 * Pick the agent that should receive the MiL.
 *
 * Preference order: the inherited initiator, then a single root, then the only
 * live agent. Anything ambiguous is reported with its candidates rather than
 * guessed, because delivering to a subagent would be silently wrong.
 *
 * @returns {{ agent?: object, how: string, candidates?: object[] }}
 */
export function resolveAgent(registry) {
  try {
    const initiator = registry.currentInitiator?.()
    if (initiator) return { agent: initiator, how: 'initiator' }
  } catch {
    // No inherited initiator: fall through to the root scan.
  }

  const roots = typeof registry.roots === 'function' ? registry.roots() : []
  if (roots.length === 1) return { agent: roots[0], how: 'root' }
  if (roots.length > 1) return { how: 'ambiguous', candidates: roots }

  const live = registry.list() ?? []
  if (live.length === 1) return { agent: live[0], how: 'only-agent' }
  return { how: live.length === 0 ? 'none' : 'ambiguous', candidates: live }
}

/** Append one record to the plugin's log, reporting a failure instead of implying success. */
export async function recordConversion(store, record) {
  return store.append(record)
}

/**
 * Hand the text to the running agent and record the outcome.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ text: string, displayMil?: string, notes?: readonly string[],
 *           headlineSuffix?: string, record: object,
 *           store: { append: (record: object) => Promise<any> } }} input
 */
export async function deliver(ctx, { text, displayMil, notes = [], headlineSuffix, record, store }) {
  // The notification shows the MiL; `text` may also carry the user's request.
  const shown = typeof displayMil === 'string' && displayMil.trim().length > 0 ? displayMil : text
  const registry = getAgents(ctx)
  if (!registry) {
    await recordConversion(store, record)
    return {
      kind: 'error',
      text: notification('送信できませんでした（ctx.agents が利用できません）', shown, notes),
    }
  }

  const resolution = resolveAgent(registry)
  if (!resolution.agent) {
    const reason = resolution.how === 'none'
      ? '送信先のエージェントが見つかりません。'
      : '送信先のエージェントを一意に決められません。'
    const candidates = resolution.candidates?.length ? `候補: ${candidateLine(resolution.candidates).trim()}` : undefined
    await recordConversion(store, record)
    return {
      kind: 'error',
      text: notification(`送信できませんでした（${reason}）`, shown, candidates === undefined ? notes : [candidates, ...notes]),
    }
  }

  let message
  try {
    // `source.kind: 'user'` is what makes the harness render a user row and let
    // `/rewind` target it (`isHuman = sourceKind === 'user'`). No context form:
    // a form-carrying message is rendered as harness context, not a row
    // (measured 2026-10-15). The conversion provenance lives in this plugin's
    // storage log instead (qa-record.md §6.22).
    message = createPluginUserMessage({ text })
  } catch (error) {
    await recordConversion(store, record)
    return { kind: 'error', text: notification(`メッセージを組み立てられません（${error?.message ?? String(error)}）`, undefined) }
  }
  const shape = assertPluginUserMessage(message)
  if (!shape.ok) {
    await recordConversion(store, record)
    return { kind: 'error', text: notification(`メッセージの形が不正です（${shape.reason}）`, undefined) }
  }

  try {
    resolution.agent.followup(message)
  } catch (error) {
    await recordConversion(store, record)
    return {
      kind: 'error',
      text: notification(`送信に失敗しました (${resolution.how}): ${error?.message ?? String(error)}`, shown, notes),
    }
  }

  const logged = await recordConversion(store, { ...record, delivered: true, messageId: message.id })
  const logLine = logged.ok
    ? `ログ: 保存しました（${logged.count} 件）`
    : `ログ: 保存できませんでした（${logged.reason}）`
  // `headlineSuffix` rides the headline because a long MiL consumes the whole
  // 200-cell notification budget and would drop every note after it.
  const headline = `送信しました（${resolution.how} で解決、id ${resolution.agent.id ?? '不明'}）${headlineSuffix ?? ''}`
  return {
    kind: 'success',
    text: notification(headline, shown, [...notes, logLine]),
  }
}
