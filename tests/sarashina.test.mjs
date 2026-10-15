import test from 'node:test'
import assert from 'node:assert/strict'

import {
  createSarashinaClient,
  createRateGate,
  computeRetryWaits,
  describeSarashinaError,
  SarashinaError,
} from '../src/sarashina.mjs'

const KEY = 'test-key-do-not-log'
const MESSAGES = [
  { role: 'system', content: 'spec' },
  { role: 'user', content: '依頼文' },
]

function jsonResponse(status, payload) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return payload
    },
    async text() {
      return JSON.stringify(payload)
    },
  }
}

function textResponse(status, text) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      throw new Error('not json')
    },
    async text() {
      return text
    },
  }
}

function okPayload(content = 'MiL;x') {
  return {
    id: 'chatcmpl-test',
    object: 'chat.completion',
    model: 'sarashina3-nano',
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  }
}

/** Queue-based fetch double. Records every call. */
function makeFetch(responses) {
  const calls = []
  const queue = [...responses]
  const impl = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) })
    const next = queue.shift()
    if (next === undefined) throw new Error('fetch double exhausted')
    if (next instanceof Error) throw next
    return next
  }
  return { impl, calls }
}

function makeSleep() {
  const waits = []
  return { waits, sleep: async (ms) => { waits.push(ms) } }
}

function makeClient(fetchImpl, sleep, extra = {}) {
  return createSarashinaClient({
    apiKey: KEY,
    fetchImpl,
    sleep,
    minIntervalMs: 0,
    requestTimeoutMs: 1000,
    ...extra,
  })
}

const REQUEST = { model: 'sarashina3-nano', messages: MESSAGES, temperature: 0, seed: 20261014, maxCompletionTokens: 2000 }

test('createSarashinaClient rejects a missing key without calling the API', () => {
  assert.throws(() => createSarashinaClient({ apiKey: '' }), (error) => error instanceof SarashinaError && error.kind === 'auth')
  assert.throws(() => createSarashinaClient({}), (error) => error instanceof SarashinaError && error.kind === 'auth')
})

test('chat sends only documented parameters and returns text and usage', async () => {
  const { impl, calls } = makeFetch([jsonResponse(200, okPayload())])
  const { sleep } = makeSleep()
  const client = makeClient(impl, sleep)

  const result = await client.chat(REQUEST)
  assert.equal(result.text, 'MiL;x')
  assert.equal(result.attempts, 1)
  assert.deepEqual(result.usage, { promptTokens: 10, completionTokens: 5, totalTokens: 15 })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, 'https://api.sarashina.ai/v1/chat/completions')
  assert.equal(calls[0].init.headers.authorization, `Bearer ${KEY}`)
  assert.deepEqual(Object.keys(calls[0].body).sort(), [
    'max_completion_tokens',
    'messages',
    'model',
    'seed',
    'stream',
    'temperature',
  ])
  assert.deepEqual(calls[0].body.messages, MESSAGES)
  assert.equal(calls[0].body.stream, false)
})

test('chat omits seed when it is null', async () => {
  const { impl, calls } = makeFetch([jsonResponse(200, okPayload())])
  const { sleep } = makeSleep()
  await makeClient(impl, sleep).chat({ ...REQUEST, seed: null })
  assert.deepEqual(Object.keys(calls[0].body).sort(), [
    'max_completion_tokens',
    'messages',
    'model',
    'stream',
    'temperature',
  ])
})

test('chat honors a custom base URL', async () => {
  const { impl, calls } = makeFetch([jsonResponse(200, okPayload())])
  const { sleep } = makeSleep()
  await makeClient(impl, sleep, { baseUrl: 'https://example.test/v1/' }).chat(REQUEST)
  assert.equal(calls[0].url, 'https://example.test/v1/chat/completions')
})

test('chat retries a 429 with the configured wait, then succeeds', async () => {
  const { impl, calls } = makeFetch([jsonResponse(429, { error: 'too many requests' }), jsonResponse(200, okPayload())])
  const { waits, sleep } = makeSleep()
  const events = []
  const client = makeClient(impl, sleep, { onEvent: (event) => events.push(event) })

  const result = await client.chat(REQUEST)
  assert.equal(result.attempts, 2)
  assert.deepEqual(waits, [10000])
  assert.equal(calls.length, 2)
  assert.ok(events.some((event) => event.type === 'retry' && event.detail.reason === 'http-429'))
})

test('chat retries transient 5xx server errors (502, 503) and succeeds', async () => {
  const { impl, calls } = makeFetch([
    textResponse(503, 'Service Unavailable'),
    textResponse(502, 'Bad Gateway'),
    jsonResponse(200, okPayload()),
  ])
  const { waits, sleep } = makeSleep()
  const events = []
  const client = makeClient(impl, sleep, { onEvent: (event) => events.push(event) })

  const result = await client.chat(REQUEST)
  assert.equal(result.attempts, 3)
  assert.deepEqual(waits, [10000, 20000])
  assert.equal(calls.length, 3)
  assert.ok(events.some((event) => event.type === 'retry' && event.detail.reason === 'http-503'))
  assert.ok(events.some((event) => event.type === 'retry' && event.detail.reason === 'http-502'))
})

test('chat gives up after the retry budget and reports 429', async () => {
  const { impl, calls } = makeFetch([
    jsonResponse(429, { error: 'r1' }),
    jsonResponse(429, { error: 'r2' }),
    jsonResponse(429, { error: 'r3' }),
    jsonResponse(429, { error: 'r4' }),
  ])
  const { waits, sleep } = makeSleep()
  const client = makeClient(impl, sleep)

  await assert.rejects(
    () => client.chat(REQUEST),
    (error) => error instanceof SarashinaError && error.status === 429 && error.body.includes('r4'),
  )
  assert.deepEqual(waits, [10000, 20000, 40000])
  assert.equal(calls.length, 4)
})

test('chat retries a network failure but not a 400', async () => {
  const network = makeFetch([new TypeError('socket hang up'), jsonResponse(200, okPayload())])
  const { waits, sleep } = makeSleep()
  const result = await makeClient(network.impl, sleep).chat(REQUEST)
  assert.equal(result.attempts, 2)
  assert.deepEqual(waits, [10000])

  const bad = makeFetch([textResponse(400, 'Invalid JSON or disallowed fields')])
  const badSleep = makeSleep()
  await assert.rejects(
    () => makeClient(bad.impl, badSleep.sleep).chat(REQUEST),
    (error) => error instanceof SarashinaError && error.kind === 'http' && error.status === 400,
  )
  assert.equal(bad.calls.length, 1)
  assert.deepEqual(badSleep.waits, [])
})

test('chat classifies 401 as an auth failure', async () => {
  const { impl } = makeFetch([textResponse(401, 'unauthorized')])
  const { sleep } = makeSleep()
  await assert.rejects(
    () => makeClient(impl, sleep).chat(REQUEST),
    (error) => error instanceof SarashinaError && error.kind === 'auth',
  )
})

test('chat classifies a timeout and a non-JSON body', async () => {
  const timeoutError = Object.assign(new Error('timed out'), { name: 'TimeoutError' })
  const timed = makeFetch([timeoutError, timeoutError])
  const { sleep } = makeSleep()
  await assert.rejects(
    () => makeClient(timed.impl, sleep, { retryWaitsMs: [1000] }).chat(REQUEST),
    (error) => error instanceof SarashinaError && error.kind === 'timeout',
  )

  const notJson = makeFetch([textResponse(200, '<html>oops</html>')])
  await assert.rejects(
    () => makeClient(notJson.impl, sleep).chat(REQUEST),
    (error) => error instanceof SarashinaError && error.kind === 'shape',
  )
})

test('chat rejects a response without message.content', async () => {
  const { impl } = makeFetch([jsonResponse(200, { choices: [{ message: { role: 'assistant', content: null } }] })])
  const { sleep } = makeSleep()
  await assert.rejects(
    () => makeClient(impl, sleep).chat(REQUEST),
    (error) => error instanceof SarashinaError && error.kind === 'shape',
  )
})

test('chat stops immediately when the caller aborts', async () => {
  const controller = new AbortController()
  controller.abort()
  const { impl, calls } = makeFetch([Object.assign(new Error('aborted'), { name: 'AbortError' })])
  const { waits, sleep } = makeSleep()
  await assert.rejects(() => makeClient(impl, sleep).chat({ ...REQUEST, signal: controller.signal }))
  assert.equal(calls.length, 1)
  assert.deepEqual(waits, [])
})

test('chat never exposes the API key, even when the server echoes it', async () => {
  const { impl } = makeFetch([textResponse(400, `bad request for key ${KEY}`)])
  const { sleep } = makeSleep()
  await assert.rejects(
    () => makeClient(impl, sleep).chat(REQUEST),
    (error) => {
      const text = `${error.message}\n${error.body ?? ''}`
      assert.equal(text.includes(KEY), false)
      assert.match(text, /REDACTED/)
      return true
    },
  )
})

test('describeSarashinaError renders a body excerpt and never the key', () => {
  const error = new SarashinaError('失敗しました。', { kind: 'http', status: 400, body: '詳細' })
  const text = describeSarashinaError(error)
  assert.match(text, /失敗しました。/)
  assert.match(text, /詳細/)
  assert.match(describeSarashinaError(new Error('素の失敗')), /素の失敗/)
})

test('createRateGate spaces request starts from the model RPM', async () => {
  let clock = 0
  const waits = []
  const gate = createRateGate({
    rpm: 6,
    now: () => clock,
    sleep: async (ms) => {
      waits.push(ms)
      clock += ms
    },
  })
  assert.equal(gate.intervalMs, 10000)
  assert.equal(await gate.acquire(), 0)
  assert.equal(await gate.acquire(), 10000)
  assert.deepEqual(waits, [10000])

  clock += 10000
  assert.equal(await gate.acquire(), 0)

  const nano = createRateGate({ rpm: 60, now: () => clock, sleep: async () => {} })
  assert.equal(nano.intervalMs, 1000)

  const off = createRateGate({ rpm: 60, minIntervalMs: 0, now: () => clock, sleep: async () => {} })
  assert.equal(off.intervalMs, 0)
  assert.equal(await off.acquire(), 0)
  assert.equal(await off.acquire(), 0)
})

test('computeRetryWaits copies the schedule and rejects an empty one', () => {
  const schedule = [1000, 2000]
  const copy = computeRetryWaits(schedule)
  assert.deepEqual(copy, schedule)
  assert.notEqual(copy, schedule)
  assert.throws(() => computeRetryWaits([]), TypeError)
  assert.throws(() => computeRetryWaits(undefined), TypeError)
})
