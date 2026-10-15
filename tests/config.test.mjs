import test from 'node:test'
import assert from 'node:assert/strict'

import { CONFIG_DEFAULTS, normalizeConfig, rpmOf, MODELS, withExamples, stripCommentLines, CONVERT_INSTRUCTION_DEFAULT } from '../src/config.mjs'

test('normalizeConfig returns defaults for absent input', () => {
  const { config, warnings } = normalizeConfig(undefined)
  assert.equal(config.model, 'sarashina3-nano')
  assert.equal(config.backtranslate, 'off')
  assert.equal(config.atSymbol, 'ext:')
  assert.equal(config.failureMode, 'confirm')
  assert.equal(config.temperature, 0)
  assert.equal(warnings.length, 0)
})

test('normalizeConfig reports a non-object instead of guessing', () => {
  const { config, warnings } = normalizeConfig('nonsense')
  assert.equal(config.model, CONFIG_DEFAULTS.model)
  assert.equal(warnings.length, 1)
})

test('normalizeConfig accepts a valid override', () => {
  const { config, warnings } = normalizeConfig({ model: 'sarashina3-mini', backtranslate: 'always', temperature: 0.5 })
  assert.equal(config.model, 'sarashina3-mini')
  assert.equal(config.backtranslate, 'always')
  assert.equal(config.temperature, 0.5)
  assert.equal(warnings.length, 0)
})

test('normalizeConfig warns on an unknown model', () => {
  const { config, warnings } = normalizeConfig({ model: 'sarashina3-translate' })
  assert.equal(config.model, CONFIG_DEFAULTS.model)
  assert.match(warnings[0], /model/)
})

test('normalizeConfig rejects a poisoned atSymbol', () => {
  for (const bad of ['', 'x@y', 'a b', '#tag']) {
    const { config, warnings } = normalizeConfig({ atSymbol: bad })
    assert.equal(config.atSymbol, CONFIG_DEFAULTS.atSymbol, `atSymbol=${JSON.stringify(bad)}`)
    assert.equal(warnings.length, 1)
  }
})

test('normalizeConfig accepts a custom atSymbol', () => {
  const { config, warnings } = normalizeConfig({ atSymbol: 'EXT:' })
  assert.equal(config.atSymbol, 'EXT:')
  assert.equal(warnings.length, 0)
})

test('normalizeConfig validates numeric ranges', () => {
  assert.equal(normalizeConfig({ temperature: 3 }).config.temperature, CONFIG_DEFAULTS.temperature)
  assert.equal(normalizeConfig({ maxCompletionTokens: 9000 }).config.maxCompletionTokens, CONFIG_DEFAULTS.maxCompletionTokens)
  assert.equal(normalizeConfig({ maxCompletionTokens: 0 }).config.maxCompletionTokens, CONFIG_DEFAULTS.maxCompletionTokens)
  assert.equal(normalizeConfig({ seed: null }).config.seed, null)
  assert.equal(normalizeConfig({ seed: 1.5 }).config.seed, CONFIG_DEFAULTS.seed)
  assert.deepEqual(normalizeConfig({ retryWaitsMs: [1000] }).config.retryWaitsMs, [1000])
  assert.equal(normalizeConfig({ retryWaitsMs: [] }).config.retryWaitsMs, CONFIG_DEFAULTS.retryWaitsMs)
  assert.equal(normalizeConfig({ minIntervalMs: 0 }).config.minIntervalMs, 0)
  assert.equal(normalizeConfig({ minIntervalMs: -1 }).config.minIntervalMs, CONFIG_DEFAULTS.minIntervalMs)
})

test('normalizeConfig rejects empty instruction strings', () => {
  const { config, warnings } = normalizeConfig({ convertInstruction: '  ' })
  assert.equal(config.convertInstruction, CONFIG_DEFAULTS.convertInstruction)
  assert.equal(warnings.length, 1)
})

test('rpmOf reports the measured ceilings only', () => {
  assert.equal(rpmOf('sarashina3-mini'), 6)
  assert.equal(rpmOf('sarashina3-nano'), 60)
  assert.equal(rpmOf('unknown-model'), undefined)
  assert.equal(Object.keys(MODELS).length, 2)
})

test('the example and strip switches default to on and are validated', () => {
  assert.equal(CONFIG_DEFAULTS.includeFrozenExample, true)
  assert.equal(CONFIG_DEFAULTS.stripSpecClauses, true)
  assert.equal(normalizeConfig({ includeFrozenExample: false }).config.includeFrozenExample, false)
  assert.equal(normalizeConfig({ stripSpecClauses: false }).config.stripSpecClauses, false)
  const { config, warnings } = normalizeConfig({ includeFrozenExample: 'yes', stripSpecClauses: 1 })
  assert.equal(config.includeFrozenExample, true)
  assert.equal(config.stripSpecClauses, true)
  assert.equal(warnings.length, 2)
})

test('withExamples composes the base, the reference style, and the pairs', () => {
  const composed = withExamples('BASE', { referenceStyle: '# note\nproblem:={a:1}', examples: '依頼: x\nMiL: goal:=y' })
  assert.ok(composed.startsWith('BASE'))
  assert.match(composed, /形式の見本/u)
  assert.match(composed, /依頼 → MiL の見本/u)
  assert.ok(composed.includes('problem:={a:1}'))
  assert.equal(composed.includes('# note'), false)
  assert.equal(withExamples(CONVERT_INSTRUCTION_DEFAULT, {}), CONVERT_INSTRUCTION_DEFAULT)
  assert.equal(withExamples(CONVERT_INSTRUCTION_DEFAULT, { referenceStyle: '  ', examples: '' }), CONVERT_INSTRUCTION_DEFAULT)
})

test('stripCommentLines drops whole comment lines only', () => {
  assert.equal(stripCommentLines('# c\ndata\n# c2\nmore'), 'data\nmore')
  assert.equal(stripCommentLines('keep # inline'), 'keep # inline')
  assert.equal(stripCommentLines(''), '')
})

test('specPreamble defaults to off and is validated', () => {
  assert.equal(CONFIG_DEFAULTS.specPreamble, 'off')
  assert.equal(normalizeConfig({ specPreamble: 'prepend' }).config.specPreamble, 'prepend')
  const { config, warnings } = normalizeConfig({ specPreamble: 'yes' })
  assert.equal(config.specPreamble, 'off')
  assert.equal(warnings.length, 1)
})
