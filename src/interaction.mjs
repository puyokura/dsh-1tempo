/**
 * User-interaction seams: one call shape over two hosts.
 *
 * Measured 2026-10-15 against the installed type definitions.
 *
 *   TUI (`@deepseek-harness-tui/dsh-tui`, dialogs.d.ts)
 *     ctx.tuiDialogs.input({ title, initial, timeoutMs })      → string | undefined
 *     ctx.tuiDialogs.confirm({ title, confirmLabel, … })       → boolean | undefined
 *     `initial` prefills the field and `undefined` means cancelled (Esc / Ctrl+C
 *     / timeout). These services exist ONLY in the TUI package.
 *
 *   web + TUI (`@deepseek-ai/dsh-user-questions`, types.d.ts)
 *     ctx.userQuestions.ask({ questions: [{ id, header, question, detail, options? }], signal })
 *       → { answers: [{ id, selected: string[], custom?: string }] }
 *     Free text rides `custom` (omit `options` and the client renders a textarea
 *     only). There is NO prefill field and NO timeout parameter: cancellation
 *     and abort REJECT, so the caller owns an AbortSignal and must bound it
 *     itself. `tuiDialogs` does not exist in the web host, and `userQuestions`
 *     is mounted by both hosts, so the question path is the host-neutral one.
 *
 * A seam that is absent returns `unavailable` instead of throwing: the caller
 * reports it, and the flow fails closed (no unreviewed send).
 */

import { softGet } from './seams.mjs'

/** Stable question id; the answer echoes it. */
const QUESTION_ID = 'mil'

/** Distinguishes the caller's own timeout from an answer. */
const TIMED_OUT = Symbol('1tempo-timeout')

/** `{ input, confirm }` when this host serves TUI dialogs. */
export function pickTuiDialogs(ctx) {
  const runtime = softGet(ctx, 'tuiDialogs')
  return runtime && typeof runtime.input === 'function' && typeof runtime.confirm === 'function'
    ? runtime
    : undefined
}

/** `{ ask }` when this host serves the user-questions waterfall. */
export function pickUserQuestions(ctx) {
  const runtime = softGet(ctx, 'userQuestions')
  return runtime && typeof runtime.ask === 'function' ? runtime : undefined
}

/**
 * Whether this host can ask the user anything at all.
 *
 * The flow fails closed without this: an unreviewed MiL is never sent.
 */
export function hasInteractionSeam(ctx) {
  return pickTuiDialogs(ctx) !== undefined || pickUserQuestions(ctx) !== undefined
}

function describe(error) {
  return error?.code ?? error?.message ?? String(error)
}

/**
 * Ask one free-text question and bound it with our own timer.
 *
 * `signal` is passed so the host can drop the pending request, and the race
 * guarantees the command cannot hang even if abort propagation changes.
 *
 * @returns {Promise<{ status: 'text', text: string, prefilled: boolean }
 *   | { status: 'cancelled', reason: string }
 *   | { status: 'timed-out' }
 *   | { status: 'unavailable', reason: string }>}
 */
async function askText(questions, { header, question, detail, timeoutMs }) {
  const controller = new AbortController()
  const asked = questions.ask({
    questions: [{ id: QUESTION_ID, header, question, detail }],
    signal: controller.signal,
  })
  // The race may return first; keep a late rejection from becoming unhandled.
  asked.catch(() => {})

  // One timer owns both the abort and the race budget, and it is always
  // cleared: a pending timer would keep the host process alive after the
  // command returned.
  let timer
  const budget = new Promise((resolve) => {
    timer = setTimeout(() => {
      controller.abort()
      resolve(TIMED_OUT)
    }, Math.max(1, timeoutMs))
  })

  let settled
  try {
    settled = await Promise.race([
      asked.then((value) => ({ ok: true, value }), (error) => ({ ok: false, error })),
      budget,
    ])
  } finally {
    clearTimeout(timer)
  }

  if (settled === TIMED_OUT) return { status: 'timed-out' }
  if (settled.ok !== true) {
    if (settled.error?.code === 'NO_PROVIDER') {
      return { status: 'unavailable', reason: 'このホストに回答 UI が接続されていません（NO_PROVIDER）。' }
    }
    return { status: 'cancelled', reason: describe(settled.error) }
  }
  const item = settled.value?.answers?.find((answer) => answer?.id === QUESTION_ID)
  const text = typeof item?.custom === 'string' ? item.custom : ''
  return { status: 'text', text, prefilled: false }
}

/**
 * Ask the user for text, prefilled when the host can prefill.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ title: string, header?: string, question: string, initial?: string,
 *           timeoutMs: number }} request
 */
export async function requestText(ctx, { title, header, question, initial, timeoutMs }) {
  const dialogs = pickTuiDialogs(ctx)
  if (dialogs) {
    try {
      const edited = await dialogs.input({ title, initial, timeoutMs })
      if (edited === undefined) return { status: 'cancelled', reason: 'ダイアログが取り消されました。' }
      return { status: 'text', text: typeof edited === 'string' ? edited : '', prefilled: true }
    } catch (error) {
      return { status: 'unavailable', reason: describe(error) }
    }
  }

  const questions = pickUserQuestions(ctx)
  if (!questions) {
    return { status: 'unavailable', reason: 'tuiDialogs も userQuestions もありません。' }
  }
  // No prefill exists on this seam, so the current value rides `detail` and the
  // user answers with the corrected text (an empty answer keeps the value).
  return askText(questions, {
    header: header ?? title,
    question,
    detail: initial,
    timeoutMs,
  })
}

/**
 * Yes/no. `confirmed` is returned only for an explicit confirmation: every
 * other outcome (cancel, timeout, no answerer, custom text) stays `declined`
 * or `unavailable`, which the caller treats as "do not send".
 *
 * @returns {Promise<{ status: 'confirmed' | 'declined' | 'timed-out' | 'unavailable', reason?: string }>}
 */
export async function requestDecision(ctx, { title, question, confirmLabel, cancelLabel, timeoutMs }) {
  const dialogs = pickTuiDialogs(ctx)
  if (dialogs) {
    try {
      const proceed = await dialogs.confirm({ title, confirmLabel, cancelLabel, timeoutMs })
      return proceed === true ? { status: 'confirmed' } : { status: 'declined' }
    } catch (error) {
      return { status: 'unavailable', reason: describe(error) }
    }
  }

  const questions = pickUserQuestions(ctx)
  if (!questions) {
    return { status: 'unavailable', reason: 'tuiDialogs も userQuestions もありません。' }
  }

  const controller = new AbortController()
  const asked = questions.ask({
    questions: [{
      id: QUESTION_ID,
      header: title,
      question,
      options: [{ label: cancelLabel }, { label: confirmLabel }],
    }],
    signal: controller.signal,
  })
  asked.catch(() => {})

  let timer
  const budget = new Promise((resolve) => {
    timer = setTimeout(() => {
      controller.abort()
      resolve(TIMED_OUT)
    }, Math.max(1, timeoutMs))
  })

  let settled
  try {
    settled = await Promise.race([
      asked.then((value) => ({ ok: true, value }), (error) => ({ ok: false, error })),
      budget,
    ])
  } finally {
    clearTimeout(timer)
  }

  if (settled === TIMED_OUT) return { status: 'timed-out' }
  if (settled.ok !== true) {
    if (settled.error?.code === 'NO_PROVIDER') {
      return { status: 'unavailable', reason: 'このホストに回答 UI が接続されていません（NO_PROVIDER）。' }
    }
    return { status: 'declined', reason: describe(settled.error) }
  }
  const item = settled.value?.answers?.find((answer) => answer?.id === QUESTION_ID)
  const selected = Array.isArray(item?.selected) ? item.selected : []
  return selected.includes(confirmLabel) ? { status: 'confirmed' } : { status: 'declined' }
}
