import test from 'node:test'
import assert from 'node:assert/strict'

import {
  NOTIFY_CELLS,
  candidateLine,
  cellWidth,
  composeDeliveryBody,
  fitsHost,
  flattenForHost,
  notification,
  resolveAgent,
} from '../src/delivery.mjs'

test('cellWidth measures visual columns correctly', () => {
  assert.equal(cellWidth(''), 0)
  assert.equal(cellWidth('abc 123'), 7)
  assert.equal(cellWidth('日本語'), 6)
  assert.equal(cellWidth('MiL: 日本語'), 11)
})

test('cellWidth follows the host rules for zero-width and emoji', () => {
  // Measured against the installed dsh-tui `stringWidth` with
  // tools/check-cell-width.mjs: controls, combining marks, ZW joiners and
  // variation selectors are 0; base+VS16 and emoji blocks are 2; ambiguous
  // characters and halfwidth kana are 1.
  assert.equal(cellWidth('e\u0301'), 1)
  assert.equal(cellWidth('a\u200bb'), 2)
  assert.equal(cellWidth('ab\tcd'), 4)
  assert.equal(cellWidth('⚠\ufe0f'), 2)
  assert.equal(cellWidth('⚠'), 1)
  assert.equal(cellWidth('🚀'), 2)
  assert.equal(cellWidth('→ ■'), 3)
  assert.equal(cellWidth('ｱｲｳ'), 3)
  assert.equal(cellWidth('　'), 2)
})

test('flattenForHost folds the layout the host folds', () => {
  // cleanRenderText replaces control bytes with spaces, collapses whitespace
  // runs and trims, so the host never measures the plugin's own line layout.
  assert.equal(flattenForHost('a\tb'), 'a b')
  assert.equal(flattenForHost('a\n\nb'), 'a b')
  assert.equal(flattenForHost('  a   b  '), 'a b')
  assert.equal(flattenForHost('a\u001b[31mb'), 'a [31mb')
  assert.equal(flattenForHost('日本語'), '日本語')
})

test('fitsHost measures the folded single line at the host budget', () => {
  assert.equal(fitsHost('あ'.repeat(100)), true)
  assert.equal(fitsHost('あ'.repeat(101)), false)
  // Folding can only shrink the measure, never grow it.
  assert.equal(fitsHost(`abc\n\n${'x'.repeat(10)}`), true)
  assert.equal(fitsHost('x'.repeat(200)), true)
  assert.equal(fitsHost('x'.repeat(201)), false)
})

test('notification leads with the MiL and fits the host cap in cell width', () => {
  const text = notification('送信しました（root で解決、id session-1）', 'goal:=x; amb→qmin{which?}', ['ログ: 保存しました（1 件）'])
  assert.match(text, /^1tempo: 送信しました/)
  assert.match(text, /MiL: goal:=x/)
  assert.match(text, /ログ: 保存しました/)
  assert.ok(cellWidth(text) <= NOTIFY_CELLS, `must fit ${NOTIFY_CELLS} cells: ${cellWidth(text)}`)
  assert.equal(NOTIFY_CELLS, 200)
})

test('notification rejects notes whose visual width exceeds budget even if length <= 200', () => {
  // 110 Japanese characters is length 110 (< 200), but visual width is 220 cells (> 200).
  const wideNote = 'あ'.repeat(110)
  assert.ok(wideNote.length < NOTIFY_CELLS)
  assert.ok(cellWidth(wideNote) > NOTIFY_CELLS)
  const text = notification('送信しました', 'goal:=x', [wideNote])
  assert.equal(text.includes(wideNote), false)
  assert.ok(cellWidth(text) <= NOTIFY_CELLS)
})

test('notification skips an oversized note while keeping subsequent notes that fit', () => {
  const long = 'あ'.repeat(NOTIFY_CELLS)
  const text = notification('送信しました', 'goal:=x', ['ログ: 保存しました', long])
  assert.equal(text, '1tempo: 送信しました\nMiL: goal:=x\nログ: 保存しました')
  const crowded = notification('送信しました', 'goal:=x', [long, 'ログ: 保存しました'])
  assert.equal(crowded.includes(long), false)
  assert.equal(crowded.includes('ログ: 保存しました'), true)
  assert.ok(cellWidth(crowded) <= NOTIFY_CELLS)
})

test('notification omits an empty MiL and accepts no notes', () => {
  assert.equal(notification('取り消しました', undefined), '1tempo: 取り消しました')
  assert.equal(notification('取り消しました', '   '), '1tempo: 取り消しました')
})

test('composeDeliveryBody sends the MiL alone by default', () => {
  assert.equal(composeDeliveryBody('goal:=x', '依頼文', false), 'goal:=x')
  assert.equal(composeDeliveryBody('goal:=x', '依頼文', undefined), 'goal:=x')
  assert.equal(composeDeliveryBody('goal:=x', '   ', true), 'goal:=x')
})

test('composeDeliveryBody prefixes the request only when asked', () => {
  assert.equal(composeDeliveryBody('goal:=x', '  依頼文  ', true), '依頼: 依頼文\n\nMiL: goal:=x')
})

test('resolveAgent prefers the inherited initiator', () => {
  const initiator = { id: 'init' }
  const registry = {
    currentInitiator: () => initiator,
    roots: () => [{ id: 'root' }],
    list: () => [{ id: 'a' }],
  }
  assert.deepEqual(resolveAgent(registry), { agent: initiator, how: 'initiator' })
})

test('resolveAgent falls back to a single root, then a single live agent', () => {
  const root = { id: 'root' }
  assert.deepEqual(
    resolveAgent({ currentInitiator: () => undefined, roots: () => [root], list: () => [] }),
    { agent: root, how: 'root' },
  )
  const live = { id: 'live' }
  assert.deepEqual(
    resolveAgent({ roots: () => [], list: () => [live] }),
    { agent: live, how: 'only-agent' },
  )
})

test('resolveAgent reports ambiguity and emptiness with candidates', () => {
  const a = { id: 'a' }
  const b = { id: 'b' }
  const ambiguous = resolveAgent({ roots: () => [a, b], list: () => [a, b] })
  assert.equal(ambiguous.how, 'ambiguous')
  assert.deepEqual(ambiguous.candidates, [a, b])
  assert.equal(ambiguous.agent, undefined)

  const none = resolveAgent({ roots: () => [], list: () => [] })
  assert.equal(none.how, 'none')
  assert.deepEqual(none.candidates, [])
})

test('resolveAgent survives a throwing currentInitiator', () => {
  const root = { id: 'root' }
  const registry = {
    currentInitiator() {
      throw new Error('no context')
    },
    roots: () => [root],
    list: () => [],
  }
  assert.deepEqual(resolveAgent(registry), { agent: root, how: 'root' })
})

test('candidateLine names unknown ids and models', () => {
  assert.equal(candidateLine([{ id: 'a', options: { model: 'm' } }, {}]).split('\n').length, 2)
  assert.match(candidateLine([{}]), /id: 不明 \/ model: 不明/)
})
