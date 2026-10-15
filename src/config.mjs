/**
 * Plugin configuration: defaults, model table, and honest validation.
 *
 * Every value here is either taken from the measured Sarashina documentation
 * (models, RPM, temperature/seed support, 8000-token completion cap) or is a
 * plugin-side choice recorded in architecture.md. Nothing is a guessed API
 * contract.
 */

/** Chat Completions supports exactly these models (measured 2026-10-14). */
export const MODELS = Object.freeze({
  'sarashina3-mini': Object.freeze({ rpm: 6 }),
  'sarashina3-nano': Object.freeze({ rpm: 60 }),
})

/** Back-translation default: off (architecture.md §5). */
export const BACKTRANSLATE_MODES = Object.freeze(['off', 'always'])

/** Failure default: ask before sending the original text (architecture.md §10). */
export const FAILURE_MODES = Object.freeze(['confirm', 'abort'])

/**
 * Plugin-side task framing. The MiL posts define the notation, not a
 * conversion protocol, so the plugin states the task itself. Kept in config so
 * the wording is adjustable without editing code (architecture.md §5, Q7).
 */
export const CONVERT_INSTRUCTION_DEFAULT = [
  '次の依頼文を、上記の MiL 仕様だけに従って MiL へ変換せよ。',
  '出力は MiL の本体のみとし、`MiL:` などのラベル・説明・前置き・後書きを付けない。',
  '見本は書き方の手掛かりにすぎない。見本の語・対象・値をそのまま写してはならない。',
  '依頼文に含まれない対象・値・目的を出力してはならない。',
  '依頼文から作業が特定できるなら、与えられた内容は必ず符号化せよ。不足は質問に回してよいが、出力を質問だけにしてはならない。',
  '  例: 「以下のディレクトリを全て確認して」→ `goal:=check(dir); scope:=all; amb→qmin{which_dir?}`',
  '依頼文から作業がまったく特定できない場合（挨拶・雑談など）だけ、`amb→qmin{intent?}` を返せ。',
  '仕様の ¬infer と amb→qmin に従い、推測で埋められない不足は MiL の中で最小限の質問として示せ。',
].join('\n')

export const BACKTRANSLATE_INSTRUCTION_DEFAULT = [
  '次の MiL を、上記の MiL 仕様だけに従って日本語の自然文へ復号せよ。',
  '原文は与えられない。MiL に書かれていない情報を補ってはならない。',
  '出力は復号した自然文のみとし、説明を付けない。',
].join('\n')

/**
 * Candidate conversion instruction (案C, measured 2026-10-14): the definition
 * alone gives the model no target form, so it is asked to derive an example
 * first and then convert against that example.
 *
 * The output is a two-block protocol so the example never rides the wire:
 * `extractMilSection()` takes only the MIL block. Not the default — it becomes
 * one only if the measurement shows it works (qa-record.md §6).
 */
export const CONVERT_INSTRUCTION_SELF_EXAMPLE = [
  '次の依頼文を、上記の MiL 仕様だけに従って MiL へ変換せよ。',
  '',
  '手順:',
  '1. 上記の定義だけを手掛かりに、MiL の短い例を 1 つ作る。内容は次の依頼文と無関係でよい。',
  '2. その例と同じ書き方で、次の依頼文を MiL へ変換する。',
  '',
  '出力は次の 2 ブロックだけにせよ。前後に説明・前置き・後書きを付けてはならない。',
  '',
  'EXAMPLE:',
  '（手順 1 の例）',
  '',
  'MIL:',
  '（手順 2 の変換結果。MiL だけを書く）',
  '',
  '仕様の ¬infer と amb→qmin に従い、推測で埋められない不足は MiL の中で最小限の質問として示せ。',
].join('\n')

/** Named conversion-instruction presets, for the measurement harness and settings. */
export const CONVERT_INSTRUCTION_PRESETS = Object.freeze({
  default: CONVERT_INSTRUCTION_DEFAULT,
  'self-example': CONVERT_INSTRUCTION_SELF_EXAMPLE,
})

/**
 * Drop `#` comment lines and collapse blank runs.
 *
 * The example and reference files are self-documenting (provenance headers), so
 * their comments must not ride the prompt. Only whole comment lines are
 * removed: anything after `#` inside a line is data.
 *
 * @param {string} text
 * @returns {string}
 */
export function stripCommentLines(text) {
  if (typeof text !== 'string') return ''
  return text
    .split('\n')
    .filter((line) => !line.startsWith('#'))
    .join('\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim()
}

/**
 * Compose the conversion instruction: the base wording, the author's real
 * usage as a form reference, and the request→MiL pairs to imitate (案C).
 *
 * The reference block is labelled as the author's *content* style, not as a
 * request-encoding example, because the original posts contain the former and
 * never the latter (mil-spec/author-examples.md §5-3).
 *
 * @param {string} baseInstruction
 * @param {{ referenceStyle?: string, examples?: string }} blocks
 * @returns {string}
 */
export function withExamples(baseInstruction, blocks = {}) {
  const parts = [baseInstruction]
  const reference = stripCommentLines(blocks.referenceStyle ?? '')
  const examples = stripCommentLines(blocks.examples ?? '')
  if (reference.length > 0) {
    parts.push('', '### 形式の見本（原典で実際に使われていた MiL の本文。依頼の変換例ではない）', '', reference)
  }
  if (examples.length > 0) {
    parts.push('', '### 依頼 → MiL の見本（この形に合わせて変換する）', '', examples)
  }
  return parts.length === 1 ? baseInstruction : parts.join('\n')
}

/** How the definition lines are treated on the wire to the target model. */
export const SPEC_PREAMBLE_MODES = Object.freeze(['off', 'prepend'])

export const CONFIG_DEFAULTS = Object.freeze({
  model: 'sarashina3-nano',
  backtranslate: 'off',
  atSymbol: 'ext:',
  failureMode: 'confirm',
  replyLanguageSectionEnabled: false,
  replyLanguageSection: 'MiL 記法で書かれた依頼を受け取ったときは、返答を日本語の自然文で返すこと。',
  convertInstruction: CONVERT_INSTRUCTION_DEFAULT,
  backtranslateInstruction: BACKTRANSLATE_INSTRUCTION_DEFAULT,
  /** Append the reference style and the request→MiL examples (案C). */
  includeFrozenExample: true,
  /** Remove clauses the prompt spec contains verbatim from the converter's answer. */
  stripSpecClauses: true,
  /** 'off' sends the MiL alone; 'prepend' puts the definition lines before it. */
  specPreamble: 'off',
  temperature: 0,
  seed: 20261014,
  maxCompletionTokens: 2000,
  retryWaitsMs: Object.freeze([10000, 20000, 40000]),
  requestTimeoutMs: 60000,
  /**
   * Deadline for each managed dialog. Passed explicitly because an omitted
   * timeout falls back to the host's 30s default, which would silently cancel
   * a dialog while the user is still typing. Kept short enough that a dialog
   * whose Esc is not delivered cannot wedge the session for long: a cancel
   * aborts the send rather than sending the unedited MiL.
   */
  dialogTimeoutMs: 180000,
  /** Minimum spacing between request starts. null derives it from the model RPM. */
  minIntervalMs: null,
  /**
   * Prefix the delivered message with the user's own request.
   *
   * Default OFF (decided 2026-10-15): the delivered `content` is BOTH what the
   * conversation shows and what the model reads — dsh has no field that
   * separates the two. Measured with `tools/inspect-session-log.mjs --grep`:
   * with this on, the original lands in `agent/inbox/spliced`, i.e. the model
   * receives the original alongside the MiL, and the whole point of sending a
   * compressed form is lost. So the MiL goes alone.
   *
   * Turning it on makes the conversation row start with 「依頼: <原文>」, which
   * is easier to recognise in `/rewind`, at the cost above.
   */
  includeOriginalInMessage: false,
})

function isPositiveInt(value) {
  return Number.isInteger(value) && value > 0
}

/**
 * Validate a config object and merge it over the defaults.
 *
 * Unknown or malformed values are reported, never silently guessed: the caller
 * shows the warnings so the user sees what was ignored.
 *
 * @param {unknown} input - partial config from the plugin's settings namespace.
 * @returns {{ config: typeof CONFIG_DEFAULTS, warnings: string[] }}
 */
export function normalizeConfig(input) {
  const warnings = []
  const config = { ...CONFIG_DEFAULTS }
  if (input === undefined || input === null) return { config, warnings }
  if (typeof input !== 'object' || Array.isArray(input)) {
    warnings.push('設定がオブジェクトではないため、既定値のみを使用します。')
    return { config, warnings }
  }

  const raw = /** @type {Record<string, unknown>} */ (input)

  if (raw.model !== undefined) {
    if (typeof raw.model === 'string' && Object.hasOwn(MODELS, raw.model)) config.model = raw.model
    else warnings.push(`model が未知のため既定 (${CONFIG_DEFAULTS.model}) を使用します: ${String(raw.model)}`)
  }

  if (raw.backtranslate !== undefined) {
    if (BACKTRANSLATE_MODES.includes(raw.backtranslate)) config.backtranslate = raw.backtranslate
    else warnings.push(`backtranslate が未知のため既定 (${CONFIG_DEFAULTS.backtranslate}) を使用します: ${String(raw.backtranslate)}`)
  }

  if (raw.failureMode !== undefined) {
    if (FAILURE_MODES.includes(raw.failureMode)) config.failureMode = raw.failureMode
    else warnings.push(`failureMode が未知のため既定 (${CONFIG_DEFAULTS.failureMode}) を使用します: ${String(raw.failureMode)}`)
  }

  if (raw.atSymbol !== undefined) {
    const value = raw.atSymbol
    if (typeof value !== 'string' || value.length === 0) {
      warnings.push(`atSymbol が空のため既定 (${CONFIG_DEFAULTS.atSymbol}) を使用します。`)
    } else if (value.includes('@')) {
      warnings.push(`atSymbol に @ を含められません。既定 (${CONFIG_DEFAULTS.atSymbol}) を使用します。`)
    } else if (/\s/.test(value)) {
      warnings.push(`atSymbol に空白を含められません。既定 (${CONFIG_DEFAULTS.atSymbol}) を使用します。`)
    } else if (value.startsWith('#')) {
      warnings.push(`atSymbol の先頭に # は使えません（dsh の行指定と衝突します）。既定 (${CONFIG_DEFAULTS.atSymbol}) を使用します。`)
    } else {
      config.atSymbol = value
    }
  }

  for (const key of ['replyLanguageSection', 'convertInstruction', 'backtranslateInstruction']) {
    const value = raw[key]
    if (value === undefined) continue
    if (typeof value === 'string' && value.trim().length > 0) config[key] = value
    else warnings.push(`${key} が空文字または文字列でないため既定を使用します。`)
  }

  if (raw.replyLanguageSectionEnabled !== undefined) {
    if (typeof raw.replyLanguageSectionEnabled === 'boolean') config.replyLanguageSectionEnabled = raw.replyLanguageSectionEnabled
    else warnings.push('replyLanguageSectionEnabled が真偽値でないため既定を使用します。')
  }

  for (const key of ['includeFrozenExample', 'stripSpecClauses']) {
    const value = raw[key]
    if (value === undefined) continue
    if (typeof value === 'boolean') config[key] = value
    else warnings.push(`${key} が真偽値でないため既定を使用します。`)
  }

  if (raw.specPreamble !== undefined) {
    if (SPEC_PREAMBLE_MODES.includes(raw.specPreamble)) config.specPreamble = raw.specPreamble
    else warnings.push(`specPreamble が未知のため既定 (${CONFIG_DEFAULTS.specPreamble}) を使用します: ${String(raw.specPreamble)}`)
  }

  if (raw.temperature !== undefined) {
    const value = raw.temperature
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 2) config.temperature = value
    else warnings.push(`temperature が 0〜2 の数値でないため既定 (${CONFIG_DEFAULTS.temperature}) を使用します: ${String(value)}`)
  }

  if (raw.seed !== undefined) {
    const value = raw.seed
    if (value === null || (Number.isInteger(value) && value >= 0)) config.seed = value
    else warnings.push(`seed が 0 以上の整数でも null でもないため既定 (${CONFIG_DEFAULTS.seed}) を使用します: ${String(value)}`)
  }

  if (raw.maxCompletionTokens !== undefined) {
    const value = raw.maxCompletionTokens
    if (isPositiveInt(value) && value <= 8000) config.maxCompletionTokens = value
    else warnings.push(`maxCompletionTokens は 1〜8000 の整数が必要です。既定 (${CONFIG_DEFAULTS.maxCompletionTokens}) を使用します: ${String(value)}`)
  }

  if (raw.retryWaitsMs !== undefined) {
    const value = raw.retryWaitsMs
    if (Array.isArray(value) && value.length > 0 && value.every(isPositiveInt)) config.retryWaitsMs = Object.freeze([...value])
    else warnings.push('retryWaitsMs は 1 つ以上の正の整数の配列が必要です。既定を使用します。')
  }

  if (raw.requestTimeoutMs !== undefined) {
    const value = raw.requestTimeoutMs
    if (isPositiveInt(value)) config.requestTimeoutMs = value
    else warnings.push(`requestTimeoutMs は正の整数が必要です。既定 (${CONFIG_DEFAULTS.requestTimeoutMs}) を使用します: ${String(value)}`)
  }

  if (raw.dialogTimeoutMs !== undefined) {
    const value = raw.dialogTimeoutMs
    if (isPositiveInt(value)) config.dialogTimeoutMs = value
    else warnings.push(`dialogTimeoutMs は正の整数が必要です。既定 (${CONFIG_DEFAULTS.dialogTimeoutMs}) を使用します: ${String(value)}`)
  }

  if (raw.minIntervalMs !== undefined) {
    const value = raw.minIntervalMs
    if (value === null) config.minIntervalMs = null
    else if (Number.isInteger(value) && value >= 0) config.minIntervalMs = value
    else warnings.push(`minIntervalMs は 0 以上の整数か null が必要です。既定 (モデルの RPM から算出) を使用します: ${String(value)}`)
  }

  if (raw.includeOriginalInMessage !== undefined) {
    const value = raw.includeOriginalInMessage
    if (typeof value === 'boolean') config.includeOriginalInMessage = value
    else warnings.push(`includeOriginalInMessage は真偽値が必要です。既定 (${CONFIG_DEFAULTS.includeOriginalInMessage}) を使用します: ${String(value)}`)
  }

  return { config, warnings }
}

/** Requests-per-minute ceiling for a model, or undefined when unknown. */
export function rpmOf(model) {
  const entry = Object.hasOwn(MODELS, model) ? MODELS[model] : undefined
  return entry?.rpm
}
