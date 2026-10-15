import test from 'node:test'
import assert from 'node:assert/strict'

import { extractCases, decodableCases } from '../src/report.mjs'

const FIXTURE = `# レポート

- 変換器: m1

## 検証 1

**原文**

\`\`\`text
原文1
\`\`\`

**MiL（変換結果）** — 呼び出し 1 回, tokens 10

\`\`\`text
MIL1;@x
\`\`\`

**ワイヤ表現（\`@\` → \`ext:\` 置換後、送信先に渡る形）**

\`\`\`text
MIL1;ext:x
\`\`\`

**復号（対象モデルは spec を受け取っていない）**

\`\`\`text
未実行
\`\`\`

## 検証 2

**原文**

\`\`\`text
原文2
\`\`\`

**変換**: 失敗

\`\`\`text
HTTP 429
\`\`\`
`

test('extractCases reads labels, prompts, MiL, and the wire form', () => {
  const cases = extractCases(FIXTURE)
  assert.equal(cases.length, 2)
  assert.equal(cases[0].label, '1')
  assert.equal(cases[0].prompt, '原文1')
  assert.equal(cases[0].mil, 'MIL1;@x')
  assert.equal(cases[0].wire, 'MIL1;ext:x')
})

test('a failed conversion yields a case with no payload', () => {
  const cases = extractCases(FIXTURE)
  assert.equal(cases[1].label, '2')
  assert.equal(cases[1].prompt, '原文2')
  assert.equal(cases[1].mil, undefined)
  assert.equal(cases[1].wire, undefined)
})

test('the wire form falls back to the MiL when substitution changed nothing', () => {
  // Remove the whole wire section (heading AND its fence): the parser must then
  // fall back to the MiL instead of borrowing the decode fence.
  const markdown = FIXTURE.replace(
    '**ワイヤ表現（`@` → `ext:` 置換後、送信先に渡る形）**\n\n```text\nMIL1;ext:x\n```\n\n',
    '',
  )
  const cases = extractCases(markdown)
  assert.equal(cases[0].mil, 'MIL1;@x')
  assert.equal(cases[0].wire, 'MIL1;@x')
})

test('decodableCases keeps only cases with a payload', () => {
  const cases = decodableCases(extractCases(FIXTURE))
  assert.equal(cases.length, 1)
  assert.equal(cases[0].label, '1')
})

test('extractCases rejects a non-string and tolerates an empty document', () => {
  assert.throws(() => extractCases(undefined), TypeError)
  assert.deepEqual(extractCases('no cases here'), [])
})
