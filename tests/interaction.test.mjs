/**
 * Unit tests for the two host seams.
 *
 * `src/interaction.mjs` (TUI dialogs vs the user-questions waterfall) and
 * `src/storage-domain.mjs` (the web host's storage stack). The shapes asserted
 * here come from the installed type definitions, quoted in each module's header.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  hasInteractionSeam,
  pickTuiDialogs,
  pickUserQuestions,
  requestDecision,
  requestText,
} from '../src/interaction.mjs'
import { DOMAIN_NAME, TABLE_NAME, openStorageDomainHandle, tempoLogSpec } from '../src/storage-domain.mjs'

function makeCtx(services) {
  const map = new Map(Object.entries(services).filter(([, value]) => value !== undefined))
  return { get: (key) => map.get(key) }
}

const TUI = {
  async input({ initial }) {
    return `${initial}!`
  },
  async confirm() {
    return true
  },
}

test('the seam pickers require the methods they call', () => {
  assert.equal(pickTuiDialogs(makeCtx({})), undefined)
  assert.equal(pickTuiDialogs(makeCtx({ tuiDialogs: { input: () => {} } })), undefined)
  assert.equal(pickUserQuestions(makeCtx({ userQuestions: {} })), undefined)
  assert.equal(pickUserQuestions(makeCtx({ userQuestions: { ask: () => {} } })).ask !== undefined, true)
  assert.equal(hasInteractionSeam(makeCtx({})), false)
  assert.equal(hasInteractionSeam(makeCtx({ userQuestions: { ask: () => {} } })), true)
})

test('requestText prefers the TUI dialog and reports the prefill', async () => {
  const result = await requestText(makeCtx({ tuiDialogs: TUI }), {
    title: 't',
    question: 'q',
    initial: 'MIL',
    timeoutMs: 50,
  })
  assert.deepEqual(result, { status: 'text', text: 'MIL!', prefilled: true })
})

test('requestText treats an undefined dialog answer as cancelled', async () => {
  const dialogs = { input: async () => undefined, confirm: async () => true }
  const result = await requestText(makeCtx({ tuiDialogs: dialogs }), { title: 't', question: 'q', timeoutMs: 50 })
  assert.equal(result.status, 'cancelled')
})

test('requestText falls back to a free-text question with the value in detail', async () => {
  const requests = []
  const ctx = makeCtx({
    userQuestions: {
      async ask(request) {
        requests.push(request)
        return { answers: [{ id: 'mil', selected: [], custom: 'EDITED' }] }
      },
    },
  })
  const result = await requestText(ctx, {
    title: 'title',
    header: 'header',
    question: 'paste the MiL',
    initial: 'CURRENT',
    timeoutMs: 50,
  })
  assert.deepEqual(result, { status: 'text', text: 'EDITED', prefilled: false })
  assert.equal(requests.length, 1)
  const question = requests[0].questions[0]
  assert.equal(question.id, 'mil')
  assert.equal(question.header, 'header')
  assert.equal(question.question, 'paste the MiL')
  // No prefill field exists on this seam, so the current value rides `detail`.
  assert.equal(question.detail, 'CURRENT')
  assert.equal(question.options, undefined)
  // No agent was supplied here: the request goes to the unscoped waterfall.
  assert.equal(requests[0].agent, undefined)
})

test('requestText forwards the live agent so the agent-scoped web answerer receives it', async () => {
  const requests = []
  const agent = { id: 'root-agent' }
  const ctx = makeCtx({
    userQuestions: {
      async ask(request) {
        requests.push(request)
        return { answers: [{ id: 'mil', selected: [], custom: '' }] }
      },
    },
  })
  const result = await requestText(ctx, { title: 't', question: 'q', timeoutMs: 50, agent })
  assert.equal(result.status, 'text')
  assert.equal(requests.length, 1)
  assert.equal(requests[0].agent, agent)
})

test('requestDecision forwards the live agent too', async () => {
  const requests = []
  const agent = { id: 'root-agent' }
  const ctx = makeCtx({
    userQuestions: {
      async ask(request) {
        requests.push(request)
        return { answers: [{ id: 'mil', selected: ['原文を送る'] }] }
      },
    },
  })
  const result = await requestDecision(ctx, {
    title: 't',
    question: 'q',
    confirmLabel: '原文を送る',
    cancelLabel: '中止',
    timeoutMs: 50,
    agent,
  })
  assert.equal(result.status, 'confirmed')
  assert.equal(requests[0].agent, agent)
})

test('requestText returns empty text when the user leaves the answer blank', async () => {
  const ctx = makeCtx({
    userQuestions: {
      async ask() {
        return { answers: [{ id: 'mil', selected: [] }] }
      },
    },
  })
  const result = await requestText(ctx, { title: 't', question: 'q', timeoutMs: 50 })
  assert.deepEqual(result, { status: 'text', text: '', prefilled: false })
})

test('requestText maps a rejected ask onto cancelled and NO_PROVIDER onto unavailable', async () => {
  const rejected = makeCtx({
    userQuestions: {
      async ask() {
        throw Object.assign(new Error('cancelled'), { code: 'ASK_CANCELLED' })
      },
    },
  })
  assert.equal((await requestText(rejected, { title: 't', question: 'q', timeoutMs: 50 })).status, 'cancelled')

  const noProvider = makeCtx({
    userQuestions: {
      async ask() {
        throw Object.assign(new Error('no answerer'), { code: 'NO_PROVIDER' })
      },
    },
  })
  const unavailable = await requestText(noProvider, { title: 't', question: 'q', timeoutMs: 50 })
  assert.equal(unavailable.status, 'unavailable')
  assert.match(unavailable.reason, /NO_PROVIDER/)
})

test('requestText times out without waiting for the host', async () => {
  // The service has no timeout parameter: the plugin owns the bound.
  const ctx = makeCtx({ userQuestions: { ask: () => new Promise(() => {}) } })
  const started = Date.now()
  const result = await requestText(ctx, { title: 't', question: 'q', timeoutMs: 20 })
  assert.equal(result.status, 'timed-out')
  assert.ok(Date.now() - started < 2000)
})

test('requestText reports an unavailable seam when neither host service exists', async () => {
  const result = await requestText(makeCtx({}), { title: 't', question: 'q', timeoutMs: 50 })
  assert.equal(result.status, 'unavailable')
  assert.match(result.reason, /tuiDialogs も userQuestions もありません/)
})

test('requestDecision confirms only an explicit confirmation', async () => {
  const confirmed = await requestDecision(makeCtx({ tuiDialogs: TUI }), {
    title: 't',
    question: 'q',
    confirmLabel: '送る',
    cancelLabel: '中止',
    timeoutMs: 50,
  })
  assert.equal(confirmed.status, 'confirmed')

  const declined = await requestDecision(makeCtx({ tuiDialogs: { ...TUI, confirm: async () => false } }), {
    title: 't',
    question: 'q',
    confirmLabel: '送る',
    cancelLabel: '中止',
    timeoutMs: 50,
  })
  assert.equal(declined.status, 'declined')
})

test('requestDecision maps the question seam options onto confirmed/declined', async () => {
  const make = (selected) => makeCtx({
    userQuestions: {
      async ask(request) {
        assert.deepEqual(request.questions[0].options, [{ label: '中止' }, { label: '原文を送る' }])
        return { answers: [{ id: 'mil', selected, custom: '' }] }
      },
    },
  })
  const request = { title: 't', question: 'q', confirmLabel: '原文を送る', cancelLabel: '中止', timeoutMs: 50 }
  assert.equal((await requestDecision(make(['原文を送る']), request)).status, 'confirmed')
  assert.equal((await requestDecision(make(['中止']), request)).status, 'declined')
  // Custom text on a single-select question clears `selected`, so free text is
  // NOT an approval: it stays declined (fail closed).
  assert.equal((await requestDecision(make([]), request)).status, 'declined')
})

test('requestDecision fails closed when no answerer is mounted', async () => {
  const ctx = makeCtx({
    userQuestions: {
      async ask() {
        throw Object.assign(new Error('no answerer'), { code: 'NO_PROVIDER' })
      },
    },
  })
  const result = await requestDecision(ctx, {
    title: 't',
    question: 'q',
    confirmLabel: '送る',
    cancelLabel: '中止',
    timeoutMs: 50,
  })
  assert.equal(result.status, 'unavailable')
})

test('the storage-domain spec names the domain and validates the stored values', () => {
  const spec = tempoLogSpec()
  assert.equal(spec.name, DOMAIN_NAME)
  assert.equal(DOMAIN_NAME, 'tempo_bridge')
  // Domain and table names must match /^[a-z][a-z0-9_]*$/ (dsh-storage).
  assert.match(spec.name, /^[a-z][a-z0-9_]*$/)
  assert.match(TABLE_NAME, /^[a-z][a-z0-9_]*$/)
  assert.equal(spec.version, 1)
  assert.equal(spec.invalidRecords, 'backup-and-skip')
  const schema = spec.tables[TABLE_NAME].valueSchema
  assert.deepEqual(schema.parse([]), [])
  assert.equal(schema.parse(3), 3)
  assert.throws(() => schema.parse('nope'))
})

test('openStorageDomainHandle adapts the table to the log store handle', async () => {
  const rows = new Map()
  const puts = []
  let openedSpec
  const ctx = makeCtx({
    storageDomain: {
      async open(spec) {
        openedSpec = spec
        return {
          table(name) {
            assert.equal(name, TABLE_NAME)
            return {
              get: (key) => rows.get(key),
              put: async (key, value) => {
                puts.push([key, value])
                rows.set(key, value)
              },
            }
          },
          async close() {},
        }
      },
    },
  })

  const handle = await openStorageDomainHandle(ctx)
  assert.equal(openedSpec.name, DOMAIN_NAME)
  // A missing key reads as null, which the log store treats as "nothing stored".
  assert.deepEqual(await handle.get({ key: 'entries' }), { value: null })
  await handle.set({ key: 'entries', value: [1] })
  assert.deepEqual(puts, [['entries', [1]]])
  assert.deepEqual(await handle.get({ key: 'entries' }), { value: [1] })
})

test('openStorageDomainHandle stays undefined when the service or open fails', async () => {
  assert.equal(await openStorageDomainHandle(makeCtx({})), undefined)
  assert.equal(await openStorageDomainHandle(makeCtx({ storageDomain: {} })), undefined)
  const failing = makeCtx({
    storageDomain: {
      async open() {
        throw Object.assign(new Error('already-open'), { code: 'already-open' })
      },
    },
  })
  assert.equal(await openStorageDomainHandle(failing), undefined)
})
