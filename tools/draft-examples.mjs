#!/usr/bin/env node
/**
 * Draft MiL examples for the conversion prompt (案C, as agreed 2026-10-14).
 *
 * The generation is the model's; the accept/reject decision is the human's.
 * This tool only drafts. Nothing here is authoritative MiL specification, and
 * the output is written as a DRAFT that must be reviewed before any example is
 * frozen into `mil-spec/examples-*.md` and referenced by the conversion
 * instruction.
 *
 * The converter is fixed to Sarashina, like the plugin.
 *
 * Usage:
 *   node --env-file=.env tools/draft-examples.mjs [--count 3] [--out mil-spec/examples-draft.md]
 */

import { writeFile } from 'node:fs/promises'
import process from 'node:process'

import { normalizeConfig } from '../src/config.mjs'
import { completeExamples, parseExamples } from '../src/examples.mjs'
import { createSarashinaClient, describeSarashinaError } from '../src/sarashina.mjs'
import { loadPromptSpec, promptSpecLabel } from '../src/spec.mjs'
import { readCredentialsYaml } from '../src/credentials.mjs'

const CONVERTER = {
  base: 'https://api.sarashina.ai/v1',
  model: 'sarashina3-nano',
  keyEnv: 'SARASHINA_API_KEY',
}

const DRAFT_INSTRUCTION = [
  '上記の MiL 定義を手掛かりに、MiL の実例を作れ。',
  '',
  '守ること:',
  '- 「依頼」は自然語の一文にする。分類名や見出し語だけ（例:「ファイル操作」「文章の修正」）は不可。',
  '  良い形: 「ログを直近 100 行だけ確認して、エラーがあれば要約して」',
  '- 「MiL」はその依頼を MiL で表したものにする。依頼に含まれる対象・動作・条件が MiL から読み取れなければならない。',
  '- 上記の定義文そのもの、またはその一部を並べ替えただけのものを出力してはならない。定義は書き方の規則であり、例の内容ではない。',
  '- 定義に無い記号や語彙を勝手に作ってはならない。定義の ¬infer と amb→qmin に従え。',
  '',
  '出力は次の形式のみとし、説明・前置き・後書き・コードフェンスを付けない。',
  '',
  '### 例 1',
  '依頼: （自然語の一文）',
  'MiL: （その依頼を MiL で表したもの）',
  '',
  '（必要な数だけ同じ形式で続ける）',
].join('\n')

const HELP = '使い方: node --env-file=.env tools/draft-examples.mjs [--count 3] [--model sarashina3-nano] [--out mil-spec/examples-draft.md]'

function parseArgv(argv) {
  const options = { count: 3 }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const next = () => {
      index += 1
      const value = argv[index]
      if (value === undefined) throw new Error(`${arg} に値がありません。`)
      return value
    }
    if (arg === '--count') options.count = Number.parseInt(next(), 10)
    else if (arg === '--model') options.model = next()
    else if (arg === '--out') options.out = next()
    else if (arg === '--help' || arg === '-h') options.help = true
    else throw new Error(`未知の引数: ${arg}`)
  }
  return options
}

async function main() {
  const options = parseArgv(process.argv.slice(2))
  if (options.help) {
    process.stdout.write(`${HELP}\n`)
    return 0
  }

  const apiKey = process.env[CONVERTER.keyEnv] ?? readCredentialsYaml(CONVERTER.keyEnv)
  if (typeof apiKey !== 'string' || apiKey.trim().length === 0) {
    process.stderr.write(`前提が欠けているため下書きを作りませんでした（未実行）。\n- \`${CONVERTER.keyEnv}\` が未設定です。\n`)
    return 2
  }

  const model = options.model ?? CONVERTER.model
  const { config } = normalizeConfig({ model })
  const spec = await loadPromptSpec()
  const outPath = options.out ?? 'mil-spec/examples-draft.md'

  const client = createSarashinaClient({
    apiKey,
    baseUrl: CONVERTER.base,
    retryWaitsMs: [...config.retryWaitsMs],
    requestTimeoutMs: config.requestTimeoutMs,
    minIntervalMs: config.minIntervalMs,
    onEvent: (event) => {
      if (event.type === 'retry') process.stderr.write(`  再試行 ${event.detail.attempt} (${event.detail.reason}) ${event.detail.waitMs}ms 待機\n`)
    },
  })

  const count = Math.max(1, Math.min(5, options.count || 3))
  let response
  try {
    response = await client.chat({
      model,
      messages: [
        { role: 'system', content: spec },
        { role: 'user', content: `${DRAFT_INSTRUCTION}\n\n例の数: ${count}` },
      ],
      temperature: config.temperature,
      seed: config.seed,
      maxCompletionTokens: config.maxCompletionTokens,
    })
  } catch (error) {
    process.stderr.write(`生成に失敗しました（未実行）。\n${describeSarashinaError(error)}\n`)
    return 1
  }

  const examples = completeExamples(parseExamples(response.text))
  const lines = [
    '# MiL 実例の下書き（レビュー前）',
    '',
    `- 生成日時: ${new Date().toISOString()}`,
    `- 生成モデル: ${model}（変換器は Sarashina 固定）`,
    `- 手掛かり: ${promptSpecLabel()} のみ（原典の使用例画像は未取得）`,
    '- 状態: **下書き**。著者の仕様ではなく、モデルが定義から作った提案。',
    '- 採否は人間が決める。採用したものだけを `examples-v0.md` として固定し、変換指示から参照する。',
    `- 抽出できた例: ${examples.length} / 要求 ${count}`,
    '',
  ]
  for (const example of examples) {
    lines.push(`### 例 ${example.index}`)
    lines.push('')
    lines.push(`依頼: ${example.request}`)
    lines.push('')
    lines.push(`MiL: ${example.mil}`)
    lines.push('')
  }
  if (examples.length < count) {
    lines.push('## 抽出できなかった例')
    lines.push('')
    lines.push('モデルが指定形式に従わなかったため、次の生出力をそのまま残す。')
    lines.push('')
    lines.push('```text')
    lines.push(response.text)
    lines.push('```')
    lines.push('')
  }

  await writeFile(outPath, `${lines.join('\n')}\n`, 'utf8')
  process.stdout.write(`下書きを書き出しました: ${outPath}\n`)
  process.stdout.write(`抽出できた例: ${examples.length} / 要求 ${count}（呼び出し ${response.attempts} 回）\n`)
  return 0
}

try {
  process.exitCode = await main()
} catch (error) {
  process.stderr.write(`予期しない失敗: ${error?.stack ?? String(error)}\n`)
  process.exitCode = 1
}
