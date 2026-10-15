import test from 'node:test'
import assert from 'node:assert/strict'

import {
  createPluginUserMessage,
  assertPluginUserMessage,
  PLUGIN_NAME,
} from '../src/message.mjs'

test('createPluginUserMessage builds a frozen user message attributed as the user', () => {
  const message = createPluginUserMessage({ text: 'MiL;x' })
  assert.equal(message.role, 'user')
  assert.deepEqual(message.content, [{ type: 'text', text: 'MiL;x' }])
  // `kind: 'user'` is what makes the harness render a user row and allow
  // /rewind to target it (isHuman = sourceKind === 'user'). See qa-record §6.22.
  assert.deepEqual(message.source, { kind: 'user' })
  assert.match(message.id, /^1tempo-/)
  assert.equal(Object.isFrozen(message), true)
  assert.equal(Object.isFrozen(message.content), true)
  assert.equal(Object.isFrozen(message.source), true)
})

test('createPluginUserMessage honors an explicit id', () => {
  const message = createPluginUserMessage({ text: 'x', id: 'fixed-id' })
  assert.equal(message.id, 'fixed-id')
  assert.equal(message.source.kind, 'user')
})

test('createPluginUserMessage rejects bad input', () => {
  assert.throws(() => createPluginUserMessage({ text: '' }), TypeError)
  assert.throws(() => createPluginUserMessage({ text: '   ' }), TypeError)
  assert.throws(() => createPluginUserMessage({ text: 42 }), TypeError)
  assert.throws(() => createPluginUserMessage({ text: 'bad\u0000char' }), TypeError)
  assert.throws(() => createPluginUserMessage({ text: 'x', id: '' }), TypeError)
})

test('assertPluginUserMessage accepts a built message and rejects broken ones', () => {
  assert.deepEqual(assertPluginUserMessage(createPluginUserMessage({ text: 'x' })), { ok: true })
  assert.equal(assertPluginUserMessage(undefined).ok, false)
  assert.equal(assertPluginUserMessage({ id: 'a', role: 'assistant', content: [{ type: 'text', text: 'x' }], source: { kind: 'user' } }).ok, false)
  assert.equal(assertPluginUserMessage({ id: 'a', role: 'user', content: [], source: { kind: 'user' } }).ok, false)
  assert.equal(assertPluginUserMessage({ id: 'a', role: 'user', content: [{ type: 'reasoning', text: 'x' }], source: { kind: 'user' } }).ok, false)
  assert.equal(assertPluginUserMessage({ role: 'user', content: [{ type: 'text', text: 'x' }], source: { kind: 'user' } }).ok, false)
  // Any other kind becomes a context row and never reaches the conversation.
  assert.equal(assertPluginUserMessage({ id: 'a', role: 'user', content: [{ type: 'text', text: 'x' }], source: { kind: 'plugin:1tempo' } }).ok, false)
  assert.equal(assertPluginUserMessage({ id: 'a', role: 'user', content: [{ type: 'text', text: 'x' }], source: { kind: 'plugin', plugin: 'p' } }).ok, false)
})

test('the built message never carries a context form', () => {
  // Measured 2026-10-15: a `form` reclassifies the row as harness context on
  // some surfaces, and the row disappeared when `form: 'notice'` was added.
  const message = createPluginUserMessage({ text: '依頼: x\n\nMiL: goal:=x' })
  assert.equal(message.source.form, undefined)
  assert.equal(message.source.summary, undefined)
  assert.deepEqual(Object.keys(message.source), ['kind'])
})

test('assertPluginUserMessage refuses a context form', () => {
  const base = { id: 'a', role: 'user', content: [{ type: 'text', text: 'x' }] }
  assert.equal(assertPluginUserMessage({ ...base, source: { kind: 'user', form: 'notice', summary: 'ok' } }).ok, false)
  assert.equal(assertPluginUserMessage({ ...base, source: { kind: 'user', form: 'catalog' } }).ok, false)
  assert.equal(assertPluginUserMessage({ ...base, source: { kind: 'user' } }).ok, true)
})
