#!/usr/bin/env node
/**
 * Freeze one adopted draft example into `mil-spec/examples-v0.*` (案C).
 *
 * SUPERSEDED (2026-10-14): the current `examples-v0.txt` is hand-curated in the
 * author's content style from a transcription of the original image, not a
 * frozen model draft. Running this tool would overwrite it, so it refuses
 * unless `--overwrite` is passed explicitly.
 *
 * Provenance discipline: a frozen example is NOT the author's specification.
 * It is a model-drafted example, reviewed and adopted by the human, and the
 * tool records both the original draft text and the clauses the stripper
 * removed, so the transformation is reproducible and auditable.
 *
 * The frozen file must not contain a clause that is verbatim in the prompt
 * spec: that padding is what made the target model decode the definition
 * instead of the request (qa-record.md §6.2). The tool enforces it by
 * construction, and `tests/spec.test.mjs` asserts it.
 *
 * Usage:
 *   node tools/freeze-example.mjs [--draft mil-spec/examples-draft.md] [--index 1] [--overwrite]
 */

import { readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import process from 'node:process'

import { completeExamples, parseExamples } from '../src/examples.mjs'
import { stripSpecClauses } from '../src/mil.mjs'
import { loadPromptSpec, promptSpecLabel, PROMPT_SPEC_NAME } from '../src/spec.mjs'

const HELP = '使い方: node tools/freeze-example.mjs [--draft mil-spec/examples-draft.md] [--index 1] [--overwrite]'

function parseArgv(argv) {
  const options = { index: 1, draft: 'mil-spec/examples-draft.md', overwrite: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const next = () => {
      index += 1
      const value = argv[index]
      if (value === undefined) throw new Error(`${arg} に値がありません。`)
      return value
    }
    if (arg === '--draft') options.draft = next()
    else if (arg === '--index') options.index = Number.parseInt(next(), 10)
    else if (arg === '--overwrite') options.overwrite = true
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

  const draftText = await readFile(options.draft, 'utf8')
  const examples = completeExamples(parseExamples(draftText))
  const adopted = examples.find((entry) => entry.index === options.index)
  if (adopted === undefined) {
    process.stderr.write(`${options.draft} に例 ${options.index} が見つかりません（抽出済み: ${examples.map((entry) => entry.index).join(', ') || 'なし'}）。\n`)
    return 2
  }

  const spec = await loadPromptSpec()
  if (existsSync('mil-spec/examples-v0.txt') && options.overwrite !== true) {
    process.stderr.write('mil-spec/examples-v0.txt は手作業で整備された実例です（このツールは下書きの凍結用で、現行の内容ではありません）。\n上書きするなら --overwrite を付けてください。\n')
    return 2
  }
  const stripped = stripSpecClauses(adopted.mil, spec)
  if (stripped.text.trim().length === 0) {
    process.stderr.write('定義逐語節を除いた結果が空になりました。この例は採用できません。\n')
    return 1
  }

  const generatedAt = (/生成日時: (.+)$/mu.exec(draftText)?.[1] ?? '').trim() || '不明'
  const generatedWith = (/生成モデル: (.+)$/mu.exec(draftText)?.[1] ?? '').trim() || '不明'

  const frozenTxt = [
    '# MiL 実例 v0（凍結）',
    '#',
    '# 状態: 著者の仕様ではない。モデルが定義から作った下書きを人間が採用したもの。',
    `# 出所: ${options.draft} の例 ${adopted.index}（生成 ${generatedAt} / ${generatedWith}）`,
    `# 手掛かり: mil-spec/${PROMPT_SPEC_NAME} のみ（原典の使用例画像は未取得）`,
    '# 変換: 定義と逐語一致する節を除去済み（stripSpecClauses）',
    '',
    `依頼: ${adopted.request}`,
    `MiL: ${stripped.text}`,
    '',
  ].join('\n')

  const removedLines = stripped.removed.length === 0
    ? ['（除去された節はない）']
    : stripped.removed.map((clause) => `- \`${clause}\``)

  const frozenMd = [
    '# MiL 実例 v0（凍結）',
    '',
    '| 項目 | 内容 |',
    '| --- | --- |',
    '| 状態 | **著者の仕様ではない。** モデルが定義から作った下書きを、人間がレビューして採用した実例 |',
    `| 出所 | \`${options.draft}\` の例 ${adopted.index} |`,
    `| 生成 | ${generatedAt} / ${generatedWith} |`,
    `| 手掛かり | \`mil-spec/${PROMPT_SPEC_NAME}\` のみ（原典の使用例画像は未取得） |`,
    '| 変換 | 定義と逐語一致する節を除去（`stripSpecClauses`） |',
    '',
    '## 採用した実例（凍結形）',
    '',
    '```text',
    `依頼: ${adopted.request}`,
    `MiL: ${stripped.text}`,
    '```',
    '',
    '## 下書きの原文',
    '',
    '```text',
    `依頼: ${adopted.request}`,
    `MiL: ${adopted.mil}`,
    '```',
    '',
    '## 除去された節（定義と逐語一致）',
    '',
    ...removedLines,
    '',
    '## 未確認',
    '',
    '- この例の書き方が著者の意図と一致するかは未確認。原典の使用例（定義本体に画像添付、未取得）と比較するまで確定しない。',
    `- 定義の左辺を保ったまま右辺だけ依頼に合わせた節（例 \`¬infer:=…\`）は逐語一致ではないため残る。`,
    '',
  ].join('\n')

  await writeFile('mil-spec/examples-v0.txt', frozenTxt, 'utf8')
  await writeFile('mil-spec/examples-v0.md', frozenMd, 'utf8')
  process.stdout.write('凍結しました: mil-spec/examples-v0.txt, mil-spec/examples-v0.md\n')
  process.stdout.write(`凍結形: ${stripped.text}\n`)
  process.stdout.write(`除去: ${stripped.removed.length} 節\n`)
  return 0
}

try {
  process.exitCode = await main()
} catch (error) {
  process.stderr.write(`予期しない失敗: ${error?.stack ?? String(error)}\n`)
  process.exitCode = 1
}
