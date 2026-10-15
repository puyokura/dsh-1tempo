import test from 'node:test'
import assert from 'node:assert/strict'

import { extractMilSection } from '../src/mil.mjs'
import { parseExamples, completeExamples } from '../src/examples.mjs'
import { CONVERT_INSTRUCTION_PRESETS, CONVERT_INSTRUCTION_DEFAULT, CONVERT_INSTRUCTION_SELF_EXAMPLE } from '../src/config.mjs'

test('extractMilSection takes only the MIL block', () => {
  const raw = 'EXAMPLE:\nfoo;bar\n\nMIL:\nmk(x);qmin{y?}\n'
  assert.deepEqual(extractMilSection(raw), { text: 'mk(x);qmin{y?}', extracted: true })
})

test('extractMilSection uses the last marker and unwraps a fence', () => {
  const raw = 'EXAMPLE:\nMIL: not a marker\n\nMIL:\n```\nmk(a)\n```\n'
  assert.deepEqual(extractMilSection(raw), { text: 'mk(a)', extracted: true })
})

test('extractMilSection accepts a bold marker', () => {
  const raw = '**MIL:**\nvalue\n'
  assert.deepEqual(extractMilSection(raw), { text: 'value', extracted: true })
})

test('extractMilSection returns the text unchanged when the protocol was ignored', () => {
  const raw = 'そのままの出力'
  assert.deepEqual(extractMilSection(raw), { text: raw, extracted: false })
})

test('extractMilSection reports an empty MIL block as empty', () => {
  assert.deepEqual(extractMilSection('MIL:\n'), { text: '', extracted: true })
})

test('extractMilSection rejects a non-string', () => {
  assert.throws(() => extractMilSection(undefined), TypeError)
})

const DRAFT = `### 例 1
依頼: ログを確認して
MiL: chk(log)

### 例 2
依頼: 設定を書き換えて
MiL:
\`\`\`
set(cfg)
\`\`\`

### 例 3
依頼: 説明だけ
`

test('parseExamples reads every block and keeps malformed ones visible', () => {
  const examples = parseExamples(DRAFT)
  assert.equal(examples.length, 3)
  assert.equal(examples[0].index, 1)
  assert.equal(examples[0].request, 'ログを確認して')
  assert.equal(examples[0].mil, 'chk(log)')
  assert.equal(examples[1].mil, 'set(cfg)')
  assert.equal(examples[2].mil, undefined)
})

/** The shape actually produced on 2026-10-14: headings dropped. */
const HEADINGLESS = `依頼: ログを直近 100 行だけ確認して、エラーがあれば要約して
MiL: Cstr≫C; C:=argmin_tok{s:⟦s⟧_ctx=log∧len(s)≤100}; R:=tie(error_present)→summarize

依頼: 設定を既定値に戻して
MiL: set(cfg,default)
`

test('parseExamples accepts bare 依頼/MiL pairs without headings', () => {
  const examples = parseExamples(HEADINGLESS)
  assert.equal(examples.length, 2)
  assert.equal(examples[0].index, 1)
  assert.match(examples[0].request, /^ログを直近 100 行/u)
  assert.match(examples[0].mil, /argmin_tok/u)
  assert.equal(examples[1].request, '設定を既定値に戻して')
  assert.equal(examples[1].mil, 'set(cfg,default)')
})

test('a bare pair without a MiL line stays incomplete', () => {
  const examples = parseExamples('依頼: これだけ\n')
  assert.equal(examples.length, 1)
  assert.equal(examples[0].request, 'これだけ')
  assert.equal(examples[0].mil, undefined)
})

test('completeExamples keeps only examples with both halves', () => {
  const examples = completeExamples(parseExamples(DRAFT))
  assert.equal(examples.length, 2)
  assert.deepEqual(examples.map((entry) => entry.index), [1, 2])
})

test('parseExamples tolerates an empty or malformed document', () => {
  assert.deepEqual(parseExamples(''), [])
  assert.deepEqual(parseExamples('説明だけの文章'), [])
  assert.throws(() => parseExamples(null), TypeError)
})

test('the self-example preset is a distinct, reviewable instruction', () => {
  assert.notEqual(CONVERT_INSTRUCTION_SELF_EXAMPLE, CONVERT_INSTRUCTION_DEFAULT)
  assert.match(CONVERT_INSTRUCTION_SELF_EXAMPLE, /EXAMPLE:/u)
  assert.match(CONVERT_INSTRUCTION_SELF_EXAMPLE, /MIL:/u)
  assert.equal(CONVERT_INSTRUCTION_PRESETS.default, CONVERT_INSTRUCTION_DEFAULT)
  assert.equal(CONVERT_INSTRUCTION_PRESETS['self-example'], CONVERT_INSTRUCTION_SELF_EXAMPLE)
})
