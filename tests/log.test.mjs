import test from 'node:test'
import assert from 'node:assert/strict'

import { createLogStore, makeRecord, LOG_KEY, LOG_COUNTER_KEY, MAX_RECORDS } from '../src/log.mjs'

function makeHandle(initial = {}) {
  const data = { ...initial }
  const writes = []
  return {
    data,
    writes,
    async get({ key }) {
      return { value: Object.hasOwn(data, key) ? data[key] : null }
    },
    async set({ key, value }) {
      writes.push(key)
      data[key] = value
      return { stored: true }
    },
  }
}

const RECORD = makeRecord({
  original: '原文',
  mil: 'MiL;x',
  wire: 'ext:EN',
  model: 'sarashina3-nano',
  attempts: 1,
  approved: true,
  delivered: true,
  messageId: 'id-1',
})

test('makeRecord produces an exact JSON record with sane defaults', () => {
  const record = makeRecord({ original: 'a', mil: 'b', wire: 'c', model: 'm', attempts: 2, approved: false, delivered: false })
  assert.equal(record.backtranslation, null)
  assert.equal(record.messageId, null)
  assert.equal(typeof record.at, 'string')
  assert.deepEqual(Object.keys(record).sort(), [
    'approved',
    'at',
    'attempts',
    'backtranslation',
    'delivered',
    'messageId',
    'mil',
    'model',
    'original',
    'wire',
  ])
  assert.doesNotThrow(() => JSON.stringify(record))
})

test('append persists through the storage handle and counts writes', async () => {
  const handle = makeHandle()
  const store = createLogStore({ handle })
  assert.equal(store.available, true)

  const result = await store.append(RECORD)
  assert.equal(result.ok, true)
  assert.equal(result.count, 1)
  assert.equal(result.total, 1)
  assert.deepEqual(handle.data[LOG_KEY], [RECORD])
  assert.equal(handle.data[LOG_COUNTER_KEY], 1)
})

test('append keeps a bounded ring instead of growing without limit', async () => {
  const handle = makeHandle()
  const store = createLogStore({ handle, maxRecords: 3 })
  for (let index = 0; index < 5; index += 1) {
    await store.append(makeRecord({ original: `o${index}`, mil: 'm', wire: 'w', model: 'm', attempts: 1, approved: true, delivered: true }))
  }
  const entries = handle.data[LOG_KEY]
  assert.equal(entries.length, 3)
  assert.deepEqual(entries.map((entry) => entry.original), ['o2', 'o3', 'o4'])
  assert.equal(handle.data[LOG_COUNTER_KEY], 5)
  assert.ok(MAX_RECORDS >= 3)
})

test('append rejects an oversized record without writing', async () => {
  const handle = makeHandle()
  const store = createLogStore({ handle, maxRecordBytes: 64 })
  const result = await store.append(makeRecord({ original: 'x'.repeat(200), mil: 'm', wire: 'w', model: 'm', attempts: 1, approved: true, delivered: true }))
  assert.equal(result.ok, false)
  assert.match(result.reason, /大きすぎます/)
  assert.equal(Object.hasOwn(handle.data, LOG_KEY), false)
})

test('append surfaces a write failure instead of claiming success', async () => {
  const failing = {
    async get() {
      return { value: null }
    },
    async set() {
      const error = new Error('denied')
      error.code = 'PERMISSION_NOT_GRANTED'
      throw error
    },
  }
  const store = createLogStore({ handle: failing })
  const result = await store.append(RECORD)
  assert.equal(result.ok, false)
  assert.match(result.reason, /PERMISSION_NOT_GRANTED/)
  assert.equal(store.sessionEntries.length, 1)
  assert.match(store.lastFailure, /PERMISSION_NOT_GRANTED/)
})

test('append refuses to overwrite a corrupt stored value', async () => {
  const handle = makeHandle({ [LOG_KEY]: { not: 'an array' } })
  const store = createLogStore({ handle })
  const result = await store.append(RECORD)
  assert.equal(result.ok, false)
  assert.match(result.reason, /配列ではありません/)
  assert.deepEqual(handle.data[LOG_KEY], { not: 'an array' })
  assert.equal(store.sessionEntries.length, 1)
})

test('append without a storage handle reports a failure, never a save', async () => {
  // Keeping a session copy is not saving: the caller prints this result to the
  // user, so an absent handle must not read as "ログ: 保存しました".
  const store = createLogStore({})
  assert.equal(store.available, false)
  const result = await store.append(RECORD)
  assert.equal(result.ok, false)
  assert.equal(result.sessionOnly, true)
  assert.match(result.reason, /storage\.local が使えないため未保存/)
  assert.equal(store.sessionEntries.length, 1)
  const read = await store.entries()
  assert.equal(read.entries.length, 1)
})

test('append without a storage handle accumulates one session ring', async () => {
  const store = createLogStore({ maxRecords: 2 })
  for (let index = 0; index < 3; index += 1) {
    await store.append(makeRecord({ original: `o${index}`, mil: 'm', wire: 'w', model: 'm', attempts: 1, approved: true, delivered: true }))
  }
  const read = await store.entries()
  assert.deepEqual(read.entries.map((entry) => entry.original), ['o1', 'o2'])
})

test('resolveHandle is called once and its handle persists', async () => {
  const handle = makeHandle()
  let calls = 0
  const store = createLogStore({
    resolveHandle: async () => {
      calls += 1
      return handle
    },
  })
  assert.equal(store.available, true)
  const first = await store.append(RECORD)
  const second = await store.append(RECORD)
  assert.equal(first.ok, true)
  assert.equal(second.ok, true)
  assert.equal(calls, 1, 'the handle is resolved once per store')
  assert.equal(handle.data[LOG_KEY].length, 2)
})

test('a throwing resolveHandle degrades to the session ring', async () => {
  const store = createLogStore({
    resolveHandle: async () => {
      throw new Error('no storage in this composition')
    },
  })
  const result = await store.append(RECORD)
  assert.equal(result.ok, false)
  assert.match(result.reason, /storage\.local が使えないため未保存/)
  assert.equal(store.sessionEntries.length, 1)
})
