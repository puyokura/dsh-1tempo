#!/usr/bin/env node
/**
 * Pre-flight measurement harness (architecture.md §11-1).
 *
 * Two roles:
 *
 *   converter  turns the request into MiL. FIXED to Sarashina: the product's
 *              conversion path is a recorded decision (architecture.md §2) and
 *              the Adapter's swap point is a contingency for a Sarashina
 *              shutdown (§11-6), not a measurement knob. There is deliberately
 *              no flag to change it.
 *   target     receives the MiL with no spec and is asked to restate the
 *              requirements (the plugin never contacts the target; this is a
 *              measurement-only call)
 *
 * Usage:
 *   node --env-file=.env tools/preflight-decode.mjs [options]
 *
 * Options:
 *   --count <n>                 samples to run (default 5, max 5)
 *   --target-base <url>         default https://api.deepseek.com
 *   --target-model <id>         default deepseek-chat
 *   --target-key-env <NAME>     default DEEPSEEK_API_KEY
 *   --prompt <text>             replace the sample list (repeatable)
 *   --instruction <name|text>   conversion instruction: `default`,
 *                               `self-example` (derive an example first, then
 *                               convert into a MIL: block), `example` (append
 *                               the frozen, human-adopted example), or inline
 *   --no-strip                  keep clauses that the spec contains verbatim
 *   --samples <path>            JSON array of strings or {label,prompt}
 *   --out <path>                report path (default preflight-report.md)
 *   --decode-only <path>        skip conversion; decode the payloads recorded
 *                               in an existing report (default out:
 *                               preflight-decode-report.md)
 *   --dry                       send nothing; print the payload that would be sent
 *
 * Exit codes: 0 measured, 2 a prerequisite is missing (nothing measured), 1 unexpected.
 */

import { readFile, writeFile } from 'node:fs/promises'
import process from 'node:process'

import { normalizeConfig, CONVERT_INSTRUCTION_PRESETS, withExamples } from '../src/config.mjs'
import { substituteAt, buildConvertMessages, extractMilSection, stripSpecClauses } from '../src/mil.mjs'
import { createSarashinaClient, describeSarashinaError } from '../src/sarashina.mjs'
import { decodableCases, extractCases } from '../src/report.mjs'
import { loadPromptSpec, promptSpecLabel, loadFrozenExamples, frozenExamplesLabel, loadReferenceStyle, referenceStyleLabel } from '../src/spec.mjs'
import { readCredentialsYaml } from '../src/credentials.mjs'

/**
 * Verification inputs. Test inputs for the measurement, not results.
 */
const DEFAULT_SAMPLES = [
  { label: '1', prompt: 'いい感じのログイン画面を作って。スマホでも見やすく' },
  { label: '2', prompt: '3Dモデルを作って' },
  { label: '3', prompt: 'この関数を速くして。あと読みやすく' },
  { label: '4', prompt: 'テストを書いて。足りないところは適当に補って' },
  { label: '5', prompt: 'READMEを直して。日本語で、簡潔に' },
]

const DECODE_INSTRUCTION = [
  '以下は MiL という圧縮記法で書かれた依頼である。',
  'この記法の仕様は与えられない。',
  '書かれている内容から依頼の要件を推定し、日本語の自然文で復唱せよ。',
  '推定できない項目は「不明」と明記せよ。',
].join('\n')

/** Waits before each target retry. The free tiers answer 429 intermittently. */
const TARGET_RETRY_WAITS_MS = [5000, 10000, 20000]

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** The converter is fixed: Sarashina Chat Completions, nano by default. */
const CONVERTER = {
  base: 'https://api.sarashina.ai/v1',
  model: 'sarashina3-nano',
  keyEnv: 'SARASHINA_API_KEY',
}

const TARGET_DEFAULTS = {
  base: 'https://api.deepseek.com',
  model: 'deepseek-chat',
  keyEnv: 'DEEPSEEK_API_KEY',
}

const HELP = `使い方: node tools/preflight-decode.mjs [--count n] [--target-model id] [--target-base url] [--target-key-env NAME] [--prompt text] [--samples path] [--out path] [--decode-only report.md] [--dry]

変換器は Sarashina 固定（変更フラグはありません）。対象モデルだけ差し替えられます。`

function parseArgv(argv) {
  const options = { prompts: [], dry: false, count: 5, target: {} }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const next = () => {
      index += 1
      const value = argv[index]
      if (value === undefined) throw new Error(`${arg} に値がありません。`)
      return value
    }
    if (arg === '--count') options.count = Number.parseInt(next(), 10)
    else if (arg === '--target-model') options.target.model = next()
    else if (arg === '--target-base') options.target.base = next()
    else if (arg === '--target-key-env') options.target.keyEnv = next()
    else if (arg === '--prompt') options.prompts.push({ label: String(options.prompts.length + 1), prompt: next() })
    else if (arg === '--instruction') options.instruction = next()
    else if (arg === '--preamble') options.preamble = next()
    else if (arg === '--no-strip') options.noStrip = true
    else if (arg === '--samples') options.samplesPath = next()
    else if (arg === '--out') options.out = next()
    else if (arg === '--decode-only') options.decodeOnly = next()
    else if (arg === '--dry') options.dry = true
    else if (arg === '--help' || arg === '-h') options.help = true
    else throw new Error(`未知の引数: ${arg}`)
  }
  return options
}

async function loadSamples(options) {
  if (options.samplesPath !== undefined) {
    const raw = await readFile(options.samplesPath, 'utf8')
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed) || parsed.length === 0) throw new Error('--samples の JSON は空でない配列が必要です。')
    return parsed.map((entry, index) => {
      if (typeof entry === 'string') return { label: String(index + 1), prompt: entry }
      if (entry !== null && typeof entry === 'object' && typeof entry.prompt === 'string') {
        return { label: String(entry.label ?? index + 1), prompt: entry.prompt }
      }
      throw new Error(`--samples の ${index + 1} 件目が不正です。`)
    })
  }
  if (options.prompts.length > 0) return options.prompts
  return DEFAULT_SAMPLES
}

async function loadSpec() {
  const text = await loadPromptSpec()
  if (text.trim().length === 0) throw new Error(`${promptSpecLabel()} が空です。`)
  return text
}

/**
 * Decode-only pass: reuse the payloads already recorded in a report instead of
 * converting again. The converter side is rate-limited and flaky, and the
 * question here is only whether a target model can read the payload without
 * the spec.
 */
async function runDecodeOnly({ options, target, targetKey, timeoutMs, outPath }) {
  if (!targetKey) {
    process.stderr.write(`前提が欠けているため復号テストを実行しませんでした（未実行）。\n- \`${target.keyEnv}\` が未設定です。\n`)
    return 2
  }
  const source = options.decodeOnly
  const markdown = await readFile(source, 'utf8')
  const cases = decodableCases(extractCases(markdown))
  if (cases.length === 0) {
    process.stderr.write(`${source} に復号できるペイロードがありません（未実行）。\n`)
    return 2
  }

  const lines = [
    '# 復号テスト（既存レポートのペイロードを再利用）',
    '',
    `- 実行日時: ${new Date().toISOString()}`,
    `- ペイロード元: ${source}`,
    `- 対象モデル: ${target.model} (${target.base}) / キー ${target.keyEnv}: あり`,
    '- 変換器: 再実行していない（元レポートのペイロードをそのまま使用）',
    '',
    '合格基準（architecture.md §11-1）: 原文を見せずに MiL から要件を復唱させ、',
    '原文の対象・範囲・条件・優先度と矛盾しない項目がそろうこと。',
    '判定欄は人間が埋める。',
    '',
  ]

  for (const entry of cases) {
    process.stderr.write(`[${entry.label}] 復号確認中… (${target.model})\n`)
    let decoded
    try {
      const result = await callChat({
        baseUrl: target.base,
        apiKey: targetKey,
        model: target.model,
        messages: [
          { role: 'system', content: DECODE_INSTRUCTION },
          { role: 'user', content: entry.wire },
        ],
        timeoutMs,
        onRetry: (attempt, waitMs, reason) => process.stderr.write(`  再試行 ${attempt}: ${waitMs}ms 待機 (${reason})\n`),
      })
      decoded = result.content
    } catch (error) {
      decoded = `未実行（呼び出しに失敗）: ${error?.message ?? String(error)}`
    }
    lines.push(`## 検証 ${entry.label}`)
    lines.push('')
    lines.push('**原文**')
    lines.push('')
    lines.push('```text')
    lines.push(entry.prompt ?? '(元レポートに原文なし)')
    lines.push('```')
    lines.push('')
    lines.push('**対象モデルが受け取ったペイロード**')
    lines.push('')
    lines.push('```text')
    lines.push(entry.wire)
    lines.push('```')
    lines.push('')
    lines.push('**復号**')
    lines.push('')
    lines.push('```text')
    lines.push(decoded)
    lines.push('```')
    lines.push('')
    lines.push('**判定（人間が記入）**')
    lines.push('')
    lines.push('- 対象・範囲・条件・優先度が原文と矛盾しない: 未記入')
    lines.push('- 落ちている要件: 未記入')
    lines.push('- 判定: 合格 / 不合格 / 保留')
    lines.push('')
  }

  await writeFile(outPath, `${lines.join('\n')}\n`, 'utf8')
  process.stdout.write(`レポートを書き出しました: ${outPath}\n`)
  process.stdout.write(`復号テスト件数: ${cases.length}\n`)
  return 0
}

/**
 * One OpenAI-compatible call, with retries for the transient failures a free
 * tier produces (429 and transport errors). A non-429 HTTP error is final: the
 * request itself is wrong and retrying would only repeat it.
 *
 * The key is never echoed into an error.
 *
 * @returns {Promise<{ content: string, attempts: number }>}
 */
async function callChat({ baseUrl, apiKey, model, messages, timeoutMs, retryWaitsMs = TARGET_RETRY_WAITS_MS, onRetry }) {
  let lastError
  for (let attempt = 0; attempt <= retryWaitsMs.length; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl.replace(/\/+$/u, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model, messages, stream: false }),
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (response.status === 429) {
        const body = await response.text().catch(() => '')
        throw Object.assign(new Error(`HTTP 429: ${body.slice(0, 300).split(apiKey).join('[REDACTED]')}`), { retryable: true })
      }
      if (!response.ok) {
        const body = await response.text().catch(() => '')
        throw new Error(`HTTP ${response.status}: ${body.slice(0, 300).split(apiKey).join('[REDACTED]')}`)
      }
      const payload = await response.json()
      const content = payload?.choices?.[0]?.message?.content
      if (typeof content !== 'string') throw new Error('応答に message.content がありません。')
      return { content, attempts: attempt + 1 }
    } catch (error) {
      lastError = error
      const retryable = error?.retryable === true || error?.name === 'TimeoutError' || error?.name === 'TypeError'
      if (!retryable || attempt === retryWaitsMs.length) break
      onRetry?.(attempt + 1, retryWaitsMs[attempt], error?.message ?? String(error))
      await sleep(retryWaitsMs[attempt])
    }
  }
  throw lastError ?? new Error('呼び出しに失敗しました。')
}

/**
 * Resolve the conversion instruction: `default`, `self-example`, `example`
 * (the frozen, human-adopted example appended to the default), or inline text.
 */
async function resolveInstruction(value) {
  if (value === undefined) return { name: 'default', text: CONVERT_INSTRUCTION_PRESETS.default }
  if (value === 'example') {
    const [referenceStyle, examples] = await Promise.all([loadReferenceStyle(), loadFrozenExamples()])
    return {
      name: `example (${referenceStyleLabel()} + ${frozenExamplesLabel()})`,
      text: withExamples(CONVERT_INSTRUCTION_PRESETS.default, { referenceStyle, examples }),
    }
  }
  if (Object.hasOwn(CONVERT_INSTRUCTION_PRESETS, value)) {
    return { name: value, text: CONVERT_INSTRUCTION_PRESETS[value] }
  }
  return { name: 'inline', text: value }
}

function identityLines({ converter, target, converterKey, targetKey, instructionName, preamble, dry }) {
  return [
    `- 変換器: ${converter.model} (${converter.base}) / キー ${converter.keyEnv}: ${converterKey ? 'あり' : 'なし'}`,
    `- 変換指示: ${instructionName}`,
    `- 定義行の前置: ${preamble}`,
    `- 対象モデル: ${target.model} (${target.base}) / キー ${target.keyEnv}: ${targetKey ? 'あり' : 'なし'}`,
    `- モード: ${dry ? 'dry（送信なし）' : '実測'}`,
  ].join('\n')
}

async function main() {
  const options = parseArgv(process.argv.slice(2))
  if (options.help) {
    process.stdout.write(`${HELP}\n`)
    return 0
  }

  const converter = { ...CONVERTER }
  const target = { ...TARGET_DEFAULTS, ...options.target }
  const { config } = normalizeConfig({ model: converter.model })
  const samples = (await loadSamples(options)).slice(0, Math.max(1, Math.min(5, options.count || 5)))
  const spec = await loadSpec()
  const converterKey = process.env[converter.keyEnv] ?? readCredentialsYaml(converter.keyEnv)
  const targetKey = process.env[target.keyEnv] ?? readCredentialsYaml(target.keyEnv)
  const outPath = options.out ?? 'preflight-report.md'

  if (options.decodeOnly !== undefined) {
    return runDecodeOnly({
      options,
      target,
      targetKey,
      timeoutMs: config.requestTimeoutMs,
      outPath: options.out ?? 'preflight-decode-report.md',
    })
  }

  const instruction = await resolveInstruction(options.instruction)
  const preamble = options.preamble ?? 'off'
  if (preamble !== 'off' && preamble !== 'prepend') throw new Error(`--preamble は off か prepend です: ${preamble}`)
  const header = [
    '# 事前実測レポート: spec なしで MiL を復号できるか',
    '',
    `- 実行日時: ${new Date().toISOString()}`,
    identityLines({ converter, target, converterKey, targetKey, instructionName: instruction.name, preamble, dry: options.dry }),
    '',
    '合格基準（architecture.md §11-1）: 原文を見せずに MiL から要件を復唱させ、',
    '原文の対象・範囲・条件・優先度と矛盾しない項目がそろうこと。',
    '判定欄は人間が埋める。未実行の項目は「未実行」と明記する。',
    '',
  ].join('\n')

  if (options.dry) {
    const messages = buildConvertMessages(spec, samples[0].prompt, config.convertInstruction)
    process.stdout.write(`${header}\n`)
    process.stdout.write('## dry 出力: 送信される payload（1 件目）\n\n')
    process.stdout.write(`- system 文字数: ${messages[0].content.length}\n`)
    process.stdout.write(`- user 先頭: ${messages[1].content.slice(0, 80)}…\n\n`)
    process.stdout.write('```json\n')
    process.stdout.write(`${JSON.stringify(messages, null, 2)}\n`)
    process.stdout.write('```\n')
    return 0
  }

  const missing = []
  if (!converterKey) missing.push(`- \`${converter.keyEnv}\` が未設定のため、MiL 変換を実行できません。`)
  if (missing.length > 0) {
    process.stderr.write('前提が欠けているため実測を実行しませんでした（未実行）。\n')
    for (const line of missing) process.stderr.write(`${line}\n`)
    process.stderr.write('\n環境変数を設定して再実行するか、`--dry` で送信 payload だけを確認してください。\n')
    return 2
  }

  const client = createSarashinaClient({
    apiKey: converterKey,
    baseUrl: converter.base,
    retryWaitsMs: [...config.retryWaitsMs],
    requestTimeoutMs: config.requestTimeoutMs,
    minIntervalMs: config.minIntervalMs,
    onEvent: (event) => {
      if (event.type === 'retry') process.stderr.write(`  再試行 ${event.detail.attempt} (${event.detail.reason}) ${event.detail.waitMs}ms 待機\n`)
      if (event.type === 'rate-gate') process.stderr.write(`  レート制限回避のため ${event.detail.waitedMs}ms 待機\n`)
    },
  })

  const rows = []
  for (const sample of samples) {
    process.stderr.write(`[${sample.label}] 変換中… ${sample.prompt}\n`)
    let mil
    let wire
    let extraction = false
    let removedCount = 0
    let converted
    try {
      converted = await client.chat({
        model: converter.model,
        messages: buildConvertMessages(spec, sample.prompt, instruction.text),
        temperature: config.temperature,
        seed: config.seed,
        maxCompletionTokens: config.maxCompletionTokens,
      })
      const section = extractMilSection(converted.text)
      extraction = section.extracted
      const cleaned = options.noStrip === true
        ? { text: section.text, removed: [] }
        : stripSpecClauses(section.text, spec)
      removedCount = cleaned.removed.length
      mil = cleaned.text.trim()
      wire = substituteAt(mil, config.atSymbol)
      if (preamble === 'prepend') wire = `${spec.trim()}\n\n${wire}`
    } catch (error) {
      rows.push({ ...sample, error: describeSarashinaError(error) })
      process.stderr.write('  変換に失敗しました。\n')
      continue
    }

    let decoded
    if (targetKey) {
      process.stderr.write(`[${sample.label}] 復号確認中… (${target.model})\n`)
      try {
        const result = await callChat({
          baseUrl: target.base,
          apiKey: targetKey,
          model: target.model,
          messages: [
            { role: 'system', content: DECODE_INSTRUCTION },
            { role: 'user', content: wire },
          ],
          timeoutMs: config.requestTimeoutMs,
          onRetry: (attempt, waitMs, reason) => process.stderr.write(`  再試行 ${attempt}: ${waitMs}ms 待機 (${reason})\n`),
        })
        decoded = result.content
      } catch (error) {
        decoded = `未実行（対象モデルの呼び出しに失敗）: ${error?.message ?? String(error)}`
      }
    } else {
      decoded = `未実行（\`${target.keyEnv}\` が未設定。dsh のセッションに MiL を貼り付けて手動で確認すること）`
    }

    rows.push({ ...sample, mil, wire, decoded, extraction, removedCount, attempts: converted.attempts, usage: converted.usage })
  }

  const lines = [header]

  for (const row of rows) {
    lines.push(`## 検証 ${row.label}`)
    lines.push('')
    lines.push('**原文**')
    lines.push('')
    lines.push('```text')
    lines.push(row.prompt)
    lines.push('```')
    lines.push('')
    if (row.error) {
      lines.push('**変換**: 失敗')
      lines.push('')
      lines.push('```text')
      lines.push(row.error)
      lines.push('```')
      lines.push('')
      continue
    }
    lines.push(`**MiL（変換結果）** — 呼び出し ${row.attempts} 回, tokens ${row.usage?.totalTokens ?? '不明'}, 二ブロック抽出: ${row.extraction ? 'あり' : 'なし'}, 定義逐語節の除去: ${row.removedCount ?? 0} 件${options.noStrip === true ? '（--no-strip）' : ''}`)
    lines.push('')
    lines.push('```text')
    lines.push(row.mil)
    lines.push('```')
    lines.push('')
    lines.push(`**ワイヤ表現（\`@\` → \`${config.atSymbol}\` 置換後、送信先に渡る形）**`)
    lines.push('')
    lines.push('```text')
    lines.push(row.wire)
    lines.push('```')
    lines.push('')
    lines.push('**復号（対象モデルは spec を受け取っていない）**')
    lines.push('')
    lines.push('```text')
    lines.push(row.decoded)
    lines.push('```')
    lines.push('')
    lines.push('**判定（人間が記入）**')
    lines.push('')
    lines.push('- 対象・範囲・条件・優先度が原文と矛盾しない: 未記入')
    lines.push('- 落ちている要件: 未記入')
    lines.push('- 判定: 合格 / 不合格 / 保留')
    lines.push('')
  }

  await writeFile(outPath, `${lines.join('\n')}\n`, 'utf8')
  process.stdout.write(`レポートを書き出しました: ${outPath}\n`)
  process.stdout.write(`検証件数: ${rows.length}（うち変換失敗 ${rows.filter((row) => row.error).length}）\n`)
  if (!targetKey) process.stdout.write(`注意: 対象モデルの復号確認は未実行です（\`${target.keyEnv}\` 未設定）。\n`)
  return 0
}

try {
  const code = await main()
  process.exitCode = code
} catch (error) {
  process.stderr.write(`予期しない失敗: ${error?.stack ?? String(error)}\n`)
  process.exitCode = 1
}
