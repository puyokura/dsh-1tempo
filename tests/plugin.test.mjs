/**
 * Integration harness for the plugin entry point.
 *
 * This executes the real `apply()` / handler code in a real Node process with
 * stand-in cordis services. It verifies the plugin's own logic end to end:
 * argument parsing, the Sarashina call, substitution, approval, agent delivery,
 * and logging.
 *
 * The fetch double stays installed for the WHOLE test, including the handler
 * call, so no test can reach the network.
 *
 * What it does NOT verify: that the stand-in services match the live dsh
 * runtime (the plugin is not registered in a profile). That remains unverified
 * until the plugin is loaded by dsh.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'

import { apply, name } from '../index.mjs'

const KEY = 'test-key'
const MIL_RAW = 'C(m):=argmin_tok; @EN>abbr:ILU'
/** The mock answer after spec-verbatim clauses are stripped (the default). */
const MIL_STRIPPED = '@EN>abbr:ILU'
const MIL_WIRE = 'ext:EN>abbr:ILU'

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

function completion(content) {
  return {
    model: 'sarashina3-nano',
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  }
}

function makeStorage() {
  const data = {}
  return {
    data,
    open() {
      return {
        async get({ key }) {
          return { value: Object.hasOwn(data, key) ? data[key] : null }
        },
        async set({ key, value }) {
          data[key] = value
          return { stored: true }
        },
        async delete({ key }) {
          const had = Object.hasOwn(data, key)
          delete data[key]
          return { deleted: had }
        },
      }
    },
  }
}

/**
 * A stand-in for the web host's storage stack: `ctx.storageDomain.open(spec)`
 * → `domain.table(name)` → KvTable (synchronous `get`, async `put`).
 */
function makeDomainStorage() {
  const rows = new Map()
  const puts = []
  return {
    rows,
    puts,
    service: {
      async open() {
        return {
          table: () => ({
            get: (key) => rows.get(key),
            put: async (key, value) => {
              puts.push([key, value])
              rows.set(key, value)
            },
          }),
          async close() {},
        }
      },
    },
  }
}

function makeCtx(services) {
  const map = new Map(Object.entries(services).filter(([, value]) => value !== undefined))
  const ctx = {
    effects: [],
    warns: [],
    infos: [],
    get(key) {
      return map.get(key)
    },
    effect(generator) {
      const iterator = generator()
      let step = iterator.next()
      while (!step.done) {
        ctx.effects.push(step.value)
        step = iterator.next()
      }
      return () => {}
    },
    logger: {
      warn: (message) => ctx.warns.push(message),
      info: (message) => ctx.infos.push(message),
    },
  }
  return ctx
}

function makeAgents() {
  const delivered = []
  const appends = []
  const agent = {
    id: 'session-1',
    options: { model: 'deepseek-chat' },
    session: {
      append(type, payload) {
        appends.push({ type, payload })
      },
    },
    followup(message) {
      delivered.push(message)
    },
  }
  return {
    delivered,
    appends,
    agent,
    registry: {
      currentInitiator() {
        return undefined
      },
      roots() {
        return [agent]
      },
      list() {
        return [agent]
      },
    },
  }
}

function makeCommands() {
  const registered = []
  return {
    registered,
    service: {
      register(definition) {
        registered.push(definition)
        return () => {}
      },
    },
  }
}

/**
 * Install the fetch double and the API key, run `apply()`, and hand back the
 * registered definition plus a `restore()` that must run in a finally block.
 */
async function setup({
  responses = [],
  agents,
  dialogs,
  userQuestions,
  storageDomain,
  storage,
  withTuiStorage = true,
  commands,
  pluginConfig = {},
  withSettingsSection = true,
  withSystemPrompt = true,
} = {}) {
  const originalFetch = globalThis.fetch
  const calls = []
  const queue = [...responses]
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) })
    const next = queue.shift()
    if (next === undefined) throw new Error('fetch double exhausted')
    return next
  }

  const previousKey = process.env.SARASHINA_API_KEY
  process.env.SARASHINA_API_KEY = KEY

  const commandsBox = commands ?? makeCommands()
  const agentsBox = agents ?? makeAgents()
  const storageBox = storage ?? makeStorage()
  const settingsCalls = []
  const promptCalls = []
  const rendererCalls = []
  const ctx = makeCtx({
    commands: commandsBox.service,
    agents: agentsBox.registry,
    tuiPluginStorage: withTuiStorage ? storageBox : undefined,
    tuiDialogs: dialogs,
    userQuestions,
    storageDomain,
    tuiRenderers: {
      register: (type, renderer) => { rendererCalls.push({ type, renderer }); return () => {} },
    },
    tuiSettingsSections: withSettingsSection
      ? { register: (section) => { settingsCalls.push(section); return () => {} } }
      : undefined,
    systemPrompt: withSystemPrompt
      ? { section: (section) => { promptCalls.push(section); return () => {} } }
      : undefined,
  })

  apply(ctx, pluginConfig)
  const definition = commandsBox.registered[0]

  const restore = () => {
    globalThis.fetch = originalFetch
    if (previousKey === undefined) delete process.env.SARASHINA_API_KEY
    else process.env.SARASHINA_API_KEY = previousKey
  }

  return { definition, calls, ctx, commandsBox, agentsBox, storageBox, settingsCalls, promptCalls, rendererCalls, restore }
}

const APPROVING = {
  async confirm() {
    return true
  },
  async input() {
    return ''
  },
}

test('the plugin exports its identity and registers the command', async () => {
  const box = await setup()
  try {
    assert.equal(name, '1tempo')
    assert.equal(typeof box.definition.handler, 'function')
    // Two effects: the command registration and the settings-section
    // registration. The reply-language section is disabled by default.
    assert.equal(box.ctx.effects.length, 2)
  } finally {
    box.restore()
  }
})

test('the registered command declares an input hint', async () => {
  // Regression: dsh-client-ui-commands' `matchEnter` executes `/name args` only
  // when the descriptor declares `input`. Without the hint the web composer
  // submitted `/onetempo こんにちは` to the model as ordinary text (measured
  // 2026-10-17). The hint must stay a non-empty string: dsh-commands rejects an
  // empty one at registration.
  const box = await setup()
  try {
    const hint = box.definition?.input?.hint
    assert.equal(typeof hint, 'string')
    assert.ok(hint.trim().length > 0, 'input.hint must not be empty')
  } finally {
    box.restore()
  }
})

test('a full run converts, substitutes, delivers, and logs', async () => {
  const box = await setup({ responses: [jsonResponse(200, completion(MIL_RAW))], dialogs: APPROVING })
  try {
    const result = await box.definition.handler({ rawInput: '  3Dモデルを作って' })
    assert.equal(result.kind, 'success')
    // NEVER append to the session log (see the regression guard below). The
    // report stays in the command result, which the host renders in the
    // notification and clips at COMMAND_RESULT_CELLS = 200, so it must FIT.
    assert.equal(box.agentsBox.appends.length, 0)
    assert.match(result.text, /^1tempo: 送信しました/u)
    assert.match(result.text, /MiL: ext:EN>abbr:ILU/)
    assert.ok(result.text.length <= 200, `notification must fit 200 cells: ${result.text.length}`)
    assert.equal(box.calls.length, 1)
    assert.equal(box.calls[0].url, 'https://api.sarashina.ai/v1/chat/completions')
    assert.equal(box.calls[0].body.model, 'sarashina3-nano')

    assert.equal(box.agentsBox.delivered.length, 1)
    const message = box.agentsBox.delivered[0]
    assert.equal(message.role, 'user')
    // `kind: 'user'` is what makes the harness render a user row and let
    // /rewind target it (isHuman = sourceKind === 'user'). Decided by the user
    // on 2026-10-15; the conversion provenance lives in the plugin's storage
    // log instead. See qa-record §6.22.
    assert.deepEqual(message.source, { kind: 'user' })
    // Default: the MiL alone goes to the model (and therefore the row shows the
    // MiL). `includeOriginalInMessage: true` would prefix the request, but that
    // also hands the original to the model — see qa-record §6.24.
    assert.equal(message.content[0].text, MIL_WIRE)

    const entries = box.storageBox.data.entries
    assert.equal(entries.length, 1)
    assert.equal(entries[0].original, '3Dモデルを作って')
    assert.equal(entries[0].delivered, true)
    // The message id lives in the storage record; the 200-cell notification
    // budget is spent on the MiL and the log line.
    assert.equal(entries[0].messageId, message.id)
    assert.match(result.text, /ログ: 保存しました/)
  } finally {
    box.restore()
  }
})

test('the plugin registers no entry renderer: nothing emits a log-only event', async () => {
  // The renderer was removed with the append: a renderer for a type that is
  // never appended is dead code that also implies a working display path
  // (qa-record.md §6.15・§6.16). This test pins the removal.
  const box = await setup()
  try {
    assert.equal(box.rendererCalls.length, 0)
  } finally {
    box.restore()
  }
})

test('an unavailable storage seam never claims the log was saved', async () => {
  // Honesty at the boundary: the notification is the only place the user sees
  // the log outcome, so a session-only record must not read as a save.
  const box = await setup({
    responses: [jsonResponse(200, completion(MIL_RAW))],
    dialogs: APPROVING,
    storage: {
      open() {
        throw new Error('PERMISSION_NOT_GRANTED: storage.local')
      },
    },
  })
  try {
    const result = await box.definition.handler({ rawInput: '依頼' })
    assert.equal(result.kind, 'success')
    assert.match(result.text, /ログ: 保存できませんでした/)
    assert.match(result.text, /storage\.local が使えないため未保存/)
    assert.equal(result.text.includes('ログ: 保存しました'), false)
  } finally {
    box.restore()
  }
})

test('the plugin never appends to the session log', async () => {
  // Regression guard for 2026-10-14: appending an unknown event type made the
  // session unresumable ("contains event type onetempo/conversion ... not
  // marked ignorable"). No plugin content may be written to the log.
  const box = await setup({ responses: [jsonResponse(200, completion(MIL_RAW))], dialogs: APPROVING })
  try {
    const result = await box.definition.handler({ rawInput: '依頼' })
    assert.equal(result.kind, 'success')
    assert.equal(box.agentsBox.appends.length, 0)
    assert.match(result.text, /MiL: /)
    assert.ok(result.text.length <= 200, `notification must fit 200 cells: ${result.text.length}`)
  } finally {
    box.restore()
  }
})

test('the plugin asks with the edit dialog only, never a confirm dialog', async () => {
  // The confirm dialog was removed: it asked "send this MiL?" while the MiL
  // was not on screen, because the command's output prints after the handler
  // returns.
  let confirmCalls = 0
  const box = await setup({
    responses: [jsonResponse(200, completion(MIL_RAW))],
    dialogs: {
      async confirm() {
        confirmCalls += 1
        return true
      },
      async input() {
        return ''
      },
    },
  })
  try {
    const result = await box.definition.handler({ rawInput: '依頼' })
    assert.equal(result.kind, 'success')
    assert.equal(confirmCalls, 0)
    assert.equal(box.agentsBox.delivered.length, 1)
  } finally {
    box.restore()
  }
})

test('a cancelled edit dialog stops the send instead of sending unedited', async () => {
  // Esc / Ctrl+C / timeout resolve the dialog with undefined. Sending the
  // unedited MiL there would defeat the review step.
  const box = await setup({
    responses: [jsonResponse(200, completion(MIL_RAW))],
    dialogs: {
      async confirm() {
        return true
      },
      async input() {
        return undefined
      },
    },
  })
  try {
    const result = await box.definition.handler({ rawInput: '依頼' })
    assert.equal(result.kind, 'success')
    assert.match(result.text, /^1tempo: 取り消しました/u)
    assert.match(result.text, /MiL: ext:EN>abbr:ILU/)
    assert.equal(box.agentsBox.delivered.length, 0)
    assert.equal(box.storageBox.data.entries[0].approved, false)
    assert.equal(box.storageBox.data.entries[0].delivered, false)
  } finally {
    box.restore()
  }
})

test('a MiL wider than the dialog bound is not opened for editing', async () => {
  // The host caps the dialog's initial value with `cleanScalarText(value, 500)`
  // = cleanRenderText, which folds whitespace and truncates with an ellipsis at
  // 500 CELLS (dsh-adapter/dialogs.js `INPUT_CELLS`, sanitize.js). Measuring
  // `.length` here accepted Japanese text of ~490 code units = ~980 cells, so
  // the dialog opened with an already-truncated MiL.
  const wide = `goal:=x; f:=${'あ'.repeat(320)}`
  assert.ok(wide.length <= 490, `length stays under the old guard: ${wide.length}`)
  const inputCalls = []
  const box = await setup({
    responses: [jsonResponse(200, completion(wide))],
    dialogs: {
      async confirm() {
        return true
      },
      async input(request) {
        inputCalls.push(request)
        return undefined
      },
    },
  })
  try {
    const result = await box.definition.handler({ rawInput: '依頼' })
    assert.equal(inputCalls.length, 0, 'the host would truncate the initial value')
    assert.equal(result.kind, 'success')
    // The reason rides the headline: a MiL this long fills the whole 200-cell
    // notification, so a later note would be dropped by the host.
    assert.match(result.text, /※ MiL が長いため編集ダイアログを開いていません/)
    assert.equal(box.agentsBox.delivered.length, 1)
  } finally {
    box.restore()
  }
})

test('the edit dialog replaces the delivered MiL', async () => {
  const box = await setup({
    responses: [jsonResponse(200, completion(MIL_RAW))],
    dialogs: {
      async confirm() {
        return true
      },
      async input() {
        return 'EDITED'
      },
    },
  })
  try {
    const result = await box.definition.handler({ rawInput: '依頼' })
    assert.equal(box.agentsBox.delivered[0].content[0].text, 'EDITED')
    assert.equal(result.kind, 'success')
  } finally {
    box.restore()
  }
})

test('includeOriginalInMessage=true opts into sending the request too', async () => {
  // Off by default because the prefix rides the same `content` the model reads
  // (measured in `agent/inbox/spliced`), which would undo the MiL compression.
  const box = await setup({
    responses: [jsonResponse(200, completion(MIL_RAW))],
    dialogs: APPROVING,
    pluginConfig: { includeOriginalInMessage: true },
  })
  try {
    const result = await box.definition.handler({ rawInput: '3Dモデルを作って' })
    assert.equal(result.kind, 'success')
    assert.equal(box.agentsBox.delivered[0].content[0].text, `依頼: 3Dモデルを作って\n\nMiL: ${MIL_WIRE}`)
    assert.equal(box.storageBox.data.entries[0].wire, `依頼: 3Dモデルを作って\n\nMiL: ${MIL_WIRE}`)
  } finally {
    box.restore()
  }
})

test('a followup failure is reported instead of throwing', async () => {
  // Regression guard: this path used to call a removed helper and threw a
  // ReferenceError, so the user saw an internal error instead of the reason.
  const agents = makeAgents()
  agents.agent.followup = () => {
    throw new Error('driver is gone')
  }
  const box = await setup({ responses: [jsonResponse(200, completion(MIL_RAW))], agents, dialogs: APPROVING })
  try {
    const result = await box.definition.handler({ rawInput: '依頼' })
    assert.equal(result.kind, 'error')
    assert.match(result.text, /送信に失敗しました/)
    assert.match(result.text, /driver is gone/)
    assert.equal(box.storageBox.data.entries[0].delivered, false)
  } finally {
    box.restore()
  }
})

test('an ambiguous agent set refuses to deliver and lists candidates', async () => {
  const agents = {
    delivered: [],
    registry: {
      currentInitiator() {
        return undefined
      },
      roots() {
        return [
          { id: 'root-a', options: { model: 'deepseek-chat' }, followup() {} },
          { id: 'root-b', options: { model: 'other' }, followup() {} },
        ]
      },
      list() {
        return []
      },
    },
  }
  const box = await setup({ responses: [jsonResponse(200, completion(MIL_RAW))], agents, dialogs: APPROVING })
  try {
    const result = await box.definition.handler({ rawInput: '依頼' })
    assert.equal(result.kind, 'error')
    assert.match(result.text, /一意に決められません/)
    assert.match(result.text, /root-a/)
    assert.match(result.text, /root-b/)
    assert.equal(box.storageBox.data.entries[0].delivered, false)
  } finally {
    box.restore()
  }
})

test('a missing agents service reports the gap instead of crashing', async () => {
  const box = await setup({
    responses: [jsonResponse(200, completion(MIL_RAW))],
    agents: { delivered: [], registry: undefined },
    dialogs: APPROVING,
  })
  try {
    const result = await box.definition.handler({ rawInput: '依頼' })
    assert.equal(result.kind, 'error')
    assert.match(result.text, /ctx\.agents.*利用できません/)
  } finally {
    box.restore()
  }
})

test('a 429 is retried inside the handler and reported in the notes', async () => {
  const box = await setup({
    responses: [jsonResponse(429, { error: 'slow down' }), jsonResponse(200, completion(MIL_RAW))],
  })
  try {
    const result = await box.definition.handler({ rawInput: '依頼' })
    // No dialogs service in this run, so the flow stops after showing the MiL.
    assert.equal(result.kind, 'success')
    assert.match(result.text, /再試行/)
    assert.match(result.text, /編集ダイアログが使えません/)
    assert.equal(box.calls.length, 2)
  } finally {
    box.restore()
  }
})

test('the web host reviews the MiL through a free-text question', async () => {
  // Web host shape: no `tuiDialogs`, no `tuiPluginStorage`; `userQuestions` and
  // `storageDomain` are the seams (measured against the installed packages).
  const domain = makeDomainStorage()
  const asked = []
  const box = await setup({
    responses: [jsonResponse(200, completion(MIL_RAW))],
    withTuiStorage: false,
    storageDomain: domain.service,
    userQuestions: {
      async ask(request) {
        asked.push(request)
        return { answers: [{ id: 'mil', selected: [], custom: '' }] }
      },
    },
  })
  try {
    const result = await box.definition.handler({ rawInput: '依頼' })
    assert.equal(result.kind, 'success')
    assert.equal(box.agentsBox.delivered.length, 1)
    assert.equal(box.agentsBox.delivered[0].content[0].text, MIL_WIRE)
    // The MiL rides `detail` (this seam has no prefill field).
    assert.equal(asked.length, 1)
    assert.equal(asked[0].questions[0].detail, MIL_WIRE)
    assert.equal(asked[0].questions[0].options, undefined)
    // The shipped web answerer is Agent-scoped: a request without the live
    // agent reaches no answerer (NO_PROVIDER) and its card never renders.
    assert.equal(asked[0].agent, box.agentsBox.agent)
    // The log went through the storage domain, not the TUI namespace.
    assert.equal(domain.rows.get('entries').length, 1)
    assert.equal(box.storageBox.data.entries, undefined)
  } finally {
    box.restore()
  }
})

test('a free-text answer replaces the MiL in the web host', async () => {
  const box = await setup({
    responses: [jsonResponse(200, completion(MIL_RAW))],
    withTuiStorage: false,
    userQuestions: {
      async ask() {
        return { answers: [{ id: 'mil', selected: [], custom: 'EDITED' }] }
      },
    },
  })
  try {
    const result = await box.definition.handler({ rawInput: '依頼' })
    assert.equal(result.kind, 'success')
    assert.equal(box.agentsBox.delivered[0].content[0].text, 'EDITED')
  } finally {
    box.restore()
  }
})

test('a cancelled question cancels the send in the web host', async () => {
  const box = await setup({
    responses: [jsonResponse(200, completion(MIL_RAW))],
    withTuiStorage: false,
    userQuestions: {
      async ask() {
        throw Object.assign(new Error('cancelled'), { code: 'ASK_CANCELLED' })
      },
    },
  })
  try {
    const result = await box.definition.handler({ rawInput: '依頼' })
    assert.equal(result.kind, 'success')
    assert.match(result.text, /取り消しました/)
    assert.equal(box.agentsBox.delivered.length, 0)
  } finally {
    box.restore()
  }
})

test('an unanswered question times out instead of hanging', async () => {
  const box = await setup({
    responses: [jsonResponse(200, completion(MIL_RAW))],
    withTuiStorage: false,
    pluginConfig: { dialogTimeoutMs: 20 },
    userQuestions: { ask: () => new Promise(() => {}) },
  })
  try {
    const result = await box.definition.handler({ rawInput: '依頼' })
    assert.equal(result.kind, 'success')
    assert.match(result.text, /取り消しました（応答がありませんでした）/)
    assert.equal(box.agentsBox.delivered.length, 0)
  } finally {
    box.restore()
  }
})

test('a host with no answerer fails closed instead of sending unreviewed', async () => {
  const box = await setup({
    responses: [jsonResponse(200, completion(MIL_RAW))],
    withTuiStorage: false,
    userQuestions: {
      async ask() {
        throw Object.assign(new Error('no answerer'), { code: 'NO_PROVIDER' })
      },
    },
  })
  try {
    const result = await box.definition.handler({ rawInput: '依頼' })
    assert.equal(result.kind, 'success')
    assert.match(result.text, /送信していません（編集ダイアログが使えません）/)
    assert.equal(box.agentsBox.delivered.length, 0)
  } finally {
    box.restore()
  }
})

test('back translation is a second call and never carries the original', async () => {
  const box = await setup({
    responses: [jsonResponse(200, completion(MIL_RAW)), jsonResponse(200, completion('自然文の復号'))],
    dialogs: APPROVING,
  })
  try {
    const result = await box.definition.handler({ rawInput: 'back 3Dモデルを作って' })
    assert.equal(box.calls.length, 2)
    const backCall = box.calls[1]
    assert.equal(backCall.body.messages[1].content, MIL_STRIPPED)
    assert.equal(JSON.stringify(backCall.body).includes('3Dモデルを作って'), false)
    assert.match(result.text, /自然文の復号/)
    assert.equal(box.agentsBox.delivered.length, 1)
    // The delivered body is the MiL alone, never the back translation.
    assert.equal(box.agentsBox.delivered[0].content[0].text, MIL_WIRE)
  } finally {
    box.restore()
  }
})

test('a conversion failure asks before sending the original, and never auto-sends', async () => {
  const box = await setup({
    responses: [jsonResponse(401, { error: 'bad key' })],
    dialogs: {
      async confirm() {
        return false
      },
      async input() {
        return ''
      },
    },
  })
  try {
    const result = await box.definition.handler({ rawInput: '依頼文そのもの' })
    assert.equal(result.kind, 'error')
    assert.match(result.text, /中止しました/)
    assert.equal(box.agentsBox.delivered.length, 0)
  } finally {
    box.restore()
  }
})

test('a conversion failure with confirmation sends the original instead', async () => {
  const box = await setup({
    responses: [jsonResponse(401, { error: 'bad key' })],
    dialogs: APPROVING,
  })
  try {
    const result = await box.definition.handler({ rawInput: '依頼文そのもの' })
    assert.equal(result.kind, 'success')
    assert.equal(box.agentsBox.delivered[0].content[0].text, '依頼文そのもの')
    assert.match(result.text, /送信/)
  } finally {
    box.restore()
  }
})

test('a missing API key stops before any network call', async () => {
  const box = await setup()
  const prevEnv = process.env.SARASHINA_API_KEY
  const prevDshHome = process.env.DSH_HOME
  delete process.env.SARASHINA_API_KEY
  process.env.DSH_HOME = path.join(os.tmpdir(), `empty-dsh-home-${Date.now()}`)
  try {
    const result = await box.definition.handler({ rawInput: '依頼' })
    assert.equal(result.kind, 'error')
    assert.match(result.text, /SARASHINA_API_KEY/)
    assert.equal(box.calls.length, 0)
  } finally {
    if (prevEnv === undefined) delete process.env.SARASHINA_API_KEY
    else process.env.SARASHINA_API_KEY = prevEnv
    if (prevDshHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prevDshHome
    box.restore()
  }
})

test('API key is resolved from ctx.credentials when process.env is absent', async () => {
  const prevEnv = process.env.SARASHINA_API_KEY
  const prevDshHome = process.env.DSH_HOME
  delete process.env.SARASHINA_API_KEY
  process.env.DSH_HOME = path.join(os.tmpdir(), `empty-dsh-home-${Date.now()}`)
  const box = await setup({
    responses: [jsonResponse(200, completion(MIL_RAW))],
    dialogs: APPROVING,
  })
  box.ctx.get = (name, throws) => {
    if (name === 'credentials') {
      return {
        async resolve(ref) {
          if (ref === 'SARASHINA_API_KEY') return { value: 'service-key-resolved', source: 'cordis' }
          return undefined
        },
      }
    }
    return box.ctx[name]
  }
  try {
    const result = await box.definition.handler({ rawInput: '依頼' })
    assert.equal(result.kind, 'success')
    assert.equal(box.calls.length, 1)
    assert.equal(box.calls[0].init.headers.authorization, 'Bearer service-key-resolved')
  } finally {
    if (prevEnv === undefined) delete process.env.SARASHINA_API_KEY
    else process.env.SARASHINA_API_KEY = prevEnv
    if (prevDshHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prevDshHome
    box.restore()
  }
})

test('help and an empty request return usage without touching the network', async () => {
  const box = await setup()
  try {
    const help = await box.definition.handler({ rawInput: '' })
    assert.equal(help.kind, 'success')
    assert.match(help.text, /使い方/)
    const empty = await box.definition.handler({ rawInput: 'mini' })
    assert.equal(empty.kind, 'error')
    assert.match(empty.text, /依頼文がありません/)
    assert.equal(box.calls.length, 0)
  } finally {
    box.restore()
  }
})

test('a malformed registration target fails loudly at registration', () => {
  const ctx = makeCtx({})
  assert.throws(() => apply(ctx, {}), /commands サービスがありません/)
})

test('a refused mediated registration falls back instead of failing boot', async () => {
  const commands = makeCommands()
  const ctx = makeCtx({
    commands: commands.service,
    tuiPluginHost: {
      registerCommand() {
        throw new Error('PERMISSION_NOT_GRANTED: admission refused')
      },
    },
  })
  apply(ctx, {})
  assert.equal(commands.registered.length, 1)
  assert.equal(commands.registered[0].name, 'onetempo')
  assert.ok(ctx.warns.some((line) => line.includes('フォールバック')))
})

test('the registered command name satisfies dsh-commands\' name rule', async () => {
  // Measured rule (@deepseek-ai/dsh-commands normalizeDefinition):
  //   COMMAND_NAME = /^[a-z][a-z0-9_-]*$/u
  // The project's first choice `1tempo` failed it at activation, so the name
  // is guarded here: a leading digit must never come back.
  const box = await setup()
  try {
    const definitionName = box.commandsBox.registered[0].name
    assert.match(definitionName, /^[a-z][a-z0-9_-]*$/u)
    assert.equal(definitionName.startsWith('1'), false)
    assert.equal(definitionName, 'onetempo')
  } finally {
    box.restore()
  }
})

test('the settings section is registered against the plugin namespace', async () => {
  const box = await setup()
  try {
    assert.equal(box.settingsCalls.length, 1)
    assert.equal(box.settingsCalls[0].ns, 'onetempo')
    assert.ok(box.settingsCalls[0].fields.length > 0)
  } finally {
    box.restore()
  }
})

test('a rejected settings section does not stop the command from registering', async () => {
  // Measured 2026-10-14: an invalid settings-section namespace rolled back the
  // whole plugin activation, command included.
  const commands = makeCommands()
  const ctx = makeCtx({
    commands: commands.service,
    tuiSettingsSections: {
      register() {
        throw new TypeError('invalid TUI settings-section namespace: 1tempo')
      },
    },
  })
  apply(ctx, {})
  assert.equal(commands.registered.length, 1)
  assert.equal(commands.registered[0].name, 'onetempo')
  assert.ok(ctx.warns.some((line) => line.includes('設定セクションを登録できませんでした')))
  assert.ok(ctx.infos.some((line) => line.includes('未接続')))
})

test('a composition without the settings seam is reported, not assumed', async () => {
  const box = await setup({ withSettingsSection: false })
  try {
    assert.equal(box.settingsCalls.length, 0)
    assert.ok(box.ctx.infos.some((line) => line.includes('未接続') && line.includes('tuiSettingsSections')))
  } finally {
    box.restore()
  }
})

test('the reply-language section is registered only when enabled', async () => {
  const disabled = await setup()
  try {
    assert.equal(disabled.promptCalls.length, 0)
  } finally {
    disabled.restore()
  }

  const enabled = await setup({ pluginConfig: { replyLanguageSectionEnabled: true, replyLanguageSection: '日本語で返す' } })
  try {
    assert.equal(enabled.promptCalls.length, 1)
    assert.equal(enabled.promptCalls[0].name, '1tempo:reply-language')
    assert.equal(enabled.promptCalls[0].text, '日本語で返す')
  } finally {
    enabled.restore()
  }

  const noSeam = await setup({
    pluginConfig: { replyLanguageSectionEnabled: true, replyLanguageSection: '日本語で返す' },
    withSystemPrompt: false,
  })
  try {
    assert.equal(noSeam.promptCalls.length, 0)
    assert.ok(noSeam.ctx.infos.some((line) => line.includes('未接続') && line.includes('systemPrompt')))
  } finally {
    noSeam.restore()
  }
})

test('config warnings are logged and do not stop registration', async () => {
  const box = await setup({ pluginConfig: { model: 'sarashina3-translate', atSymbol: 'a b' } })
  try {
    assert.equal(box.commandsBox.registered.length, 1)
    assert.ok(box.ctx.warns.some((line) => line.includes('model')))
    assert.ok(box.ctx.warns.some((line) => line.includes('atSymbol')))
    // The invalid values fall back to the defaults, so the log line shows them.
    assert.ok(box.ctx.infos.some((line) => line.includes('model=sarashina3-nano')))
  } finally {
    box.restore()
  }
})
