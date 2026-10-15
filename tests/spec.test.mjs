import test from 'node:test'
import assert from 'node:assert/strict'

import { loadPromptSpec, loadDocumentedSpec, loadFrozenExamples, loadReferenceStyle, promptSpecLabel, frozenExamplesLabel, referenceStyleLabel, PROMPT_SPEC_NAME, FROZEN_EXAMPLES_NAME, REFERENCE_STYLE_NAME } from '../src/spec.mjs'
import { stripSpecClauses } from '../src/mil.mjs'

test('the conversion spec carries the author definition lines verbatim', async () => {
  const spec = await loadPromptSpec()
  assert.match(spec, /MiL;C\(m\):=argmin_tok\{s:⟦s⟧=m\}/u)
  assert.match(spec, /cstr≫C≫R;/u)
  assert.match(spec, /del\(x\)⇔recoverable\(x\|ctx\)/u)
  assert.match(spec, /@:=ext_only/u)
  assert.match(spec, /¬infer:=¬unsupported_fact∧¬intent_fill\(amb→qmin\)/u)
})

test('the conversion spec carries none of the plugin documentation', async () => {
  const spec = await loadPromptSpec()
  // Markdown structure and plugin-side prose must not ride the prompt. A bare
  // `|` is deliberately allowed: `recoverable(x|ctx)` is part of the definition.
  for (const forbidden of ['追加規則', '未取得', '返答言語', '本プラグイン', '置換', '##', '|---', '```']) {
    assert.equal(spec.includes(forbidden), false, `prompt spec must not contain: ${forbidden}`)
  }
})

test('the conversion spec is small enough not to dominate the call', async () => {
  const spec = await loadPromptSpec()
  assert.ok(spec.length < 1500, `prompt spec is ${spec.length} characters`)
  // Two definition lines only: no third line of commentary.
  const nonEmpty = spec.split('\n').filter((line) => line.trim().length > 0)
  assert.equal(nonEmpty.length, 2)
})

test('the documented snapshot is separate and never used as the prompt', async () => {
  const doc = await loadDocumentedSpec()
  assert.match(doc, /原典の引用/u)
  assert.match(doc, /未取得/u)
  const spec = await loadPromptSpec()
  assert.notEqual(doc, spec)
  assert.equal(spec.includes('原典の引用'), false)
})

test('the prompt spec label is a repo-relative path', () => {
  assert.equal(promptSpecLabel(), `mil-spec/${PROMPT_SPEC_NAME}`)
  assert.equal(promptSpecLabel().startsWith('/'), false)
})

test('the request→MiL pairs are this plugin\'s own material, not the author spec', async () => {
  const examples = await loadFrozenExamples()
  assert.match(examples, /^依頼: /mu)
  assert.match(examples, /^MiL: /mu)
  assert.match(examples, /本プラグインが作成/u)
  assert.match(examples, /原典の仕様ではなく/u)
  assert.equal(frozenExamplesLabel(), `mil-spec/${FROZEN_EXAMPLES_NAME}`)
})

test('no example MiL line carries a clause the spec has verbatim', async () => {
  const examples = await loadFrozenExamples()
  const spec = await loadPromptSpec()
  const mils = [...examples.matchAll(/^MiL: (.*)$/gmu)].map((match) => match[1])
  assert.ok(mils.length >= 3, `expected at least 3 pairs, found ${mils.length}`)
  for (const mil of mils) {
    assert.deepEqual(stripSpecClauses(mil, spec).removed, [], `example carries spec clauses: ${mil}`)
  }
})

test('the reference style file is the author transcription with its provenance', async () => {
  const reference = await loadReferenceStyle()
  assert.match(reference, /ユーザーが別途行った分析による転記/u)
  assert.match(reference, /独立検証していない/u)
  assert.match(reference, /本物ではない/u)
  assert.ok(reference.includes('problem:={tone:'), 'real example 1 missing')
  assert.ok(reference.includes('stance:={mockery'), 'real example 2 missing')
  assert.equal(referenceStyleLabel(), `mil-spec/${REFERENCE_STYLE_NAME}`)
})
