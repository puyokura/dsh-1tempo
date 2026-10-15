import test from 'node:test'
import assert from 'node:assert/strict'

import { buildSettingsSection, SETTINGS_NS, SETTINGS_TITLE } from '../src/settings.mjs'
import { buildReplyLanguageSection, REPLY_SECTION_NAME, REPLY_SECTION_ORDER } from '../src/prompt.mjs'
import { CONFIG_DEFAULTS } from '../src/config.mjs'

const ALLOWED_KINDS = new Set(['text', 'number', 'boolean', 'select'])

test('the settings section is keyed to a valid plugin namespace', () => {
  const section = buildSettingsSection()
  assert.equal(section.ns, SETTINGS_NS)
  assert.equal(section.ns, 'onetempo')
  // Measured rule (dsh-adapter/settings-sections.js registerSection):
  // a plugin-owned namespace must match /^[a-z][a-z0-9_-]*$/u. `1tempo` was
  // rejected at activation, so the namespace must never go back to a digit.
  assert.match(section.ns, /^[a-z][a-z0-9_-]*$/u)
  assert.equal(section.ns.startsWith('1'), false)
  assert.equal(section.title, SETTINGS_TITLE)
})

test('every settings field is a renderable descriptor', () => {
  const section = buildSettingsSection()
  assert.ok(section.fields.length >= 6)
  for (const field of section.fields) {
    assert.ok(Array.isArray(field.path) && field.path.length > 0, `path: ${JSON.stringify(field.path)}`)
    assert.equal(typeof field.label, 'string')
    assert.ok(ALLOWED_KINDS.has(field.kind), `kind: ${field.kind}`)
    if (field.kind === 'select') {
      assert.ok(Array.isArray(field.options) && field.options.length > 0, `options for ${field.label}`)
      for (const option of field.options) {
        assert.equal(typeof option.value, 'string')
        assert.equal(typeof option.label, 'string')
      }
    }
    if (field.kind === 'boolean') assert.equal(field.options, undefined)
  }
})

test('the settings paths match the config keys they edit', () => {
  const paths = buildSettingsSection().fields.map((field) => field.path.join('.'))
  for (const path of ['model', 'backtranslate', 'atSymbol', 'failureMode', 'replyLanguageSectionEnabled', 'replyLanguageSection']) {
    assert.ok(paths.includes(path), `missing settings path: ${path}`)
  }
  for (const path of paths) {
    assert.ok(Object.hasOwn(CONFIG_DEFAULTS, path), `settings path has no config key: ${path}`)
  }
})

test('the settings section never carries the API key', () => {
  const serialized = JSON.stringify(buildSettingsSection())
  assert.equal(serialized.includes('secret'), false)
  assert.equal(serialized.includes('apiKey'), false)
  assert.equal(serialized.includes('SARASHINA'), false)
})

test('the model field offers exactly the measured Chat Completions models', () => {
  const model = buildSettingsSection().fields.find((field) => field.path[0] === 'model')
  assert.deepEqual(model.options.map((option) => option.value).sort(), ['sarashina3-mini', 'sarashina3-nano'])
  assert.equal(JSON.stringify(model).includes('guard'), false)
  assert.equal(JSON.stringify(model).includes('translate'), false)
})

test('the reply-language section is absent unless enabled with text', () => {
  assert.equal(buildReplyLanguageSection({}), undefined)
  assert.equal(buildReplyLanguageSection({ replyLanguageSectionEnabled: false, replyLanguageSection: 'x' }), undefined)
  assert.equal(buildReplyLanguageSection({ replyLanguageSectionEnabled: true, replyLanguageSection: '   ' }), undefined)
  assert.equal(buildReplyLanguageSection({ replyLanguageSectionEnabled: true }), undefined)
})

test('the reply-language section carries a namespaced name and a documented order', () => {
  const section = buildReplyLanguageSection({ replyLanguageSectionEnabled: true, replyLanguageSection: '  日本語で返す  ' })
  assert.equal(section.name, REPLY_SECTION_NAME)
  assert.equal(section.name, '1tempo:reply-language')
  assert.equal(section.text, '日本語で返す')
  assert.equal(section.order, REPLY_SECTION_ORDER)
  assert.ok(section.order >= 100 && section.order <= 199, 'order must stay in the documented tool-guidance band')
})
