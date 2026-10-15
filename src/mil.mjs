/**
 * MiL text handling: the token-head `@` substitution, output validation, and
 * the two Chat Completions message builders.
 *
 * The substitution and the message shapes are plugin-side rules recorded in
 * architecture.md §2/§3 and mil-spec §4. They are NOT part of the MiL
 * specification itself.
 */

import { CONVERT_INSTRUCTION_DEFAULT, BACKTRANSLATE_INSTRUCTION_DEFAULT } from './config.mjs'

/**
 * One `@` that starts a whitespace-delimited token, mirroring dsh's own
 * mention lexing (`^` or whitespace before, non-whitespace after). A `@` in
 * the middle of a token (`hello@world`) is never a mention and is left alone.
 */
const AT_TOKEN = /(^|\s)@(?=\S)/gu

/** Control characters that must never reach the wire. Tab and newline allowed. */
const FORBIDDEN_CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u

/**
 * Replace every token-head `@` with the configured ASCII substitute.
 *
 * Runs on the text that will be sent to the target model, after the
 * Sarashina response is accepted. Never reversed: restoring `@` would make dsh
 * expand it as a file mention again.
 *
 * @param {string} text
 * @param {string} atSymbol
 * @returns {string}
 */
export function substituteAt(text, atSymbol) {
  if (typeof text !== 'string') throw new TypeError('substituteAt: text must be a string')
  if (typeof atSymbol !== 'string' || atSymbol.length === 0) throw new TypeError('substituteAt: atSymbol must be a non-empty string')
  if (atSymbol.includes('@')) throw new TypeError('substituteAt: atSymbol must not contain @')
  return text.replace(AT_TOKEN, (_match, lead) => `${lead}${atSymbol}`)
}

/**
 * Unwrap a single fenced code block that spans the whole text.
 *
 * Models often answer inside one fence. Only that exact shape is unwrapped;
 * prose around a fence is preserved verbatim so nothing is silently dropped.
 *
 * @param {string} text
 * @returns {string}
 */
export function unwrapSingleFence(text) {
  if (typeof text !== 'string') throw new TypeError('unwrapSingleFence: text must be a string')
  const trimmed = text.trim()
  const match = /^```[^\n]*\n([\s\S]*?)\n?```$/u.exec(trimmed)
  return match ? match[1] : text
}

/**
 * Structural validation of a converted MiL string.
 *
 * Only shape is checked. This function never claims the MiL is semantically
 * correct: meaning preservation is decided by the pre-flight measurement and by
 * the user's approval.
 *
 * @param {unknown} text
 * @param {{ maxChars?: number }} [options]
 * @returns {{ ok: true, text: string } | { ok: false, reason: string }}
 */
export function validateMil(text, options = {}) {
  const maxChars = options.maxChars ?? 20000
  if (typeof text !== 'string') return { ok: false, reason: 'MiL が文字列ではありません。' }
  const value = text.trim()
  if (value.length === 0) return { ok: false, reason: 'MiL が空です。' }
  if (value.length > maxChars) return { ok: false, reason: `MiL が長すぎます (${value.length} > ${maxChars})。` }
  if (FORBIDDEN_CONTROL.test(value)) return { ok: false, reason: 'MiL に制御文字が含まれています。' }
  return { ok: true, text: value }
}

/**
 * Messages for the conversion call: the spec alone is the system message; the
 * task instruction and the user's request share the user turn.
 *
 * Measured 2026-10-14: with the instruction in the system message the model
 * paraphrased the definition instead of encoding the request. The instruction
 * therefore rides the last user turn (preflight-report-run3.md records the
 * comparison). Both the instruction and the spec are plugin-side payloads; see
 * mil-spec §4.
 */
export function buildConvertMessages(spec, prompt, instruction = CONVERT_INSTRUCTION_DEFAULT) {
  return [
    { role: 'system', content: spec },
    { role: 'user', content: `${instruction}\n\n---\n\n${prompt}` },
  ]
}

/**
 * Messages for the back-translation call.
 *
 * The user's original request is deliberately absent: with it in context the
 * model would paraphrase the original instead of decoding the MiL, and the
 * comparison would stop being a check for dropped information
 * (architecture.md §2).
 */
export function buildBacktranslateMessages(spec, mil, instruction = BACKTRANSLATE_INSTRUCTION_DEFAULT) {
  return [
    { role: 'system', content: `${spec}\n\n---\n\n${instruction}` },
    { role: 'user', content: mil },
  ]
}

/**
 * Take only the MIL block of the two-block conversion protocol (案C).
 *
 * The example the model writes must never reach the wire, so the LAST `MIL:`
 * marker wins and everything before it is dropped. Text without a marker is
 * returned unchanged with `extracted: false`, so a model that ignores the
 * protocol is reported honestly instead of being silently truncated.
 *
 * @param {string} text
 * @returns {{ text: string, extracted: boolean }}
 */
export function extractMilSection(text) {
  if (typeof text !== 'string') throw new TypeError('extractMilSection: text must be a string')
  const lines = text.split('\n')
  let markerIndex = -1
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const head = lines[index].trim().replace(/^\*\*|\*\*$/gu, '')
    if (head === 'MIL:') {
      markerIndex = index
      break
    }
  }
  if (markerIndex >= 0) {
    const body = lines.slice(markerIndex + 1).join('\n').trim()
    return { text: unwrapSingleFence(body).trim(), extracted: true }
  }

  // Inline form, measured live 2026-10-14: the model answered
  // `request:={…}; MiL:goal:=make(…); …` — a label the plugin must not send.
  // The last marker wins, and only a marker that does not continue a word
  // counts (so `aMIL:` is not a marker).
  const pattern = /(^|[^A-Za-z])(MIL:)/giu
  let last
  let match
  while ((match = pattern.exec(text)) !== null) last = match
  if (last === undefined) return { text, extracted: false }
  const body = text.slice(last.index + last[0].length).trim()
  return { text: unwrapSingleFence(body).trim(), extracted: true }
}

/**
 * Whether a converted MiL carries only a question and no encoded content.
 *
 * Measured live 2026-10-14: the request 「以下のディレクトリを全て確認して」 (a real
 * task, only its target missing) came back as the bare `amb→qmin{intent?}`
 * fallback, which drops the request entirely. The caller surfaces this instead
 * of presenting it as a normal conversion.
 *
 * @param {string} mil
 * @returns {boolean}
 */
export function looksLikeQuestionOnly(mil) {
  if (typeof mil !== 'string') throw new TypeError('looksLikeQuestionOnly: mil must be a string')
  return mil
    .replace(/amb\s*→\s*qmin\s*\{[^}]*\}/gu, '')
    .replace(/[;\s]/gu, '')
    .length === 0
}

/**
 * Split text by a delimiter only at the top level (outside of {}, (), and []).
 *
 * @param {string} text
 * @param {string} [delimiter]
 * @returns {string[]}
 */
export function splitTopLevel(text, delimiter = ';') {
  if (typeof text !== 'string') throw new TypeError('splitTopLevel: text must be a string')
  const segments = []
  let depth = 0
  let start = 0
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (ch === '{' || ch === '(' || ch === '[') {
      depth += 1
    } else if (ch === '}' || ch === ')' || ch === ']') {
      if (depth > 0) depth -= 1
    } else if (ch === delimiter && depth === 0) {
      segments.push(text.slice(start, i))
      start = i + 1
    }
  }
  segments.push(text.slice(start))
  return segments
}

/**
 * Remove clauses that the spec itself contains verbatim.
 *
 * Measured 2026-10-14: the converter appends the definition's own clauses to
 * its answer (`tok:=active_tokenizer`, `@:=ext_only`, `IF:=cond`, …). That
 * padding is what made the target model decode the definition instead of the
 * request (qa-record.md §6.2), so it is removed before the text is sent.
 *
 * Only exact matches count, compared case-insensitively with all whitespace
 * removed (MiL is a dense notation where spacing carries no meaning, so a
 * model-written `tok := active_tokenizer` still matches the spec's
 * `tok:=active_tokenizer`). A clause the model adapted to the request
 * (`C:=argmin_tok{…}`, `R:=tie(error_present)→summarize`) differs from the
 * spec and survives; note the deliberate limit — a clause that keeps the
 * spec's left-hand side but changes only its right-hand side
 * (`¬infer:=¬supported_operation∧…`) is not an exact match and is kept.
 *
 * Top-level semicolons only: semicolons nested inside braces, brackets, or
 * parentheses are part of structured expressions and are not split in half.
 *
 * @param {string} text
 * @param {string} spec
 * @returns {{ text: string, removed: string[] }}
 */
export function stripSpecClauses(text, spec) {
  if (typeof text !== 'string') throw new TypeError('stripSpecClauses: text must be a string')
  if (typeof spec !== 'string' || spec.trim().length === 0) return { text, removed: [] }

  const normalize = (value) => value.replace(/\s+/gu, '').toLowerCase()
  const specNormalized = normalize(spec)

  const kept = []
  const removed = []
  for (const segment of splitTopLevel(text, ';')) {
    const value = segment.trim()
    if (value.length === 0) continue
    if (specNormalized.includes(normalize(value))) removed.push(value)
    else kept.push(value)
  }
  return { text: kept.join('; '), removed }
}

const USAGE = [
  '使い方: /onetempo [mini|nano] [back] <依頼文>',
  '  mini / nano  変換モデルの上書き（省略時は設定の既定）',
  '  back         逆翻訳も表示する（省略時は設定の既定）',
  '',
  '変換後の確認（ダイアログは MiL を表示する 1 つだけ）:',
  '  そのまま確定   表示中の MiL を送信',
  '  本文を編集して確定   修正した MiL を送信',
  '  Esc / Ctrl+C   送信を取り消す',
].join('\n')

/** Tokens accepted at the head of the command input. */
const MODEL_FLAGS = Object.freeze({ mini: 'sarashina3-mini', nano: 'sarashina3-nano' })
const BACK_FLAGS = Object.freeze(['back', 'backtranslate', '--back'])
const HELP_FLAGS = Object.freeze(['help', '--help', '-h'])

/**
 * Parse the raw command input.
 *
 * Flags are recognized only at the head, in either order. The first token that
 * is not a flag starts the request text, and everything after it is taken
 * verbatim (spaces preserved).
 *
 * @param {string} rawInput - text after the command name, separator included.
 * @param {{ defaultModel: string, defaultBacktranslate: boolean }} defaults
 * @returns {{ kind: 'help' } | { kind: 'error', reason: string } | { kind: 'request', model: string, backtranslate: boolean, prompt: string }}
 */
export function parseArgs(rawInput, defaults) {
  let text = typeof rawInput === 'string' ? rawInput.trimStart() : ''
  if (text.length === 0) return { kind: 'help' }

  let model = defaults.defaultModel
  let backtranslate = defaults.defaultBacktranslate

  const firstTokenMatch = /^[^\s]+/u.exec(text)
  if (firstTokenMatch && HELP_FLAGS.includes(firstTokenMatch[0].toLowerCase())) {
    return { kind: 'help' }
  }

  while (text.length > 0) {
    const match = /^([^\s]+)(\s*)/u.exec(text)
    if (!match) break
    const token = match[1].toLowerCase()
    if (Object.hasOwn(MODEL_FLAGS, token)) {
      model = MODEL_FLAGS[token]
      text = text.slice(match[0].length)
      continue
    }
    if (BACK_FLAGS.includes(token)) {
      backtranslate = true
      text = text.slice(match[0].length)
      continue
    }
    break
  }

  const prompt = text.trim()
  if (prompt.length === 0) return { kind: 'error', reason: '依頼文がありません。' }
  return { kind: 'request', model, backtranslate, prompt }
}

export { USAGE }
