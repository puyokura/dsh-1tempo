/**
 * dsh plugin: `/onetempo` — MiL-Bridge (product name: 1tempo).
 *
 * Flow (architecture.md §1):
 *   /onetempo [mini|nano] [back] <依頼文>
 *     → Sarashina converts the request to MiL (spec in the system message)
 *     → the plugin substitutes the token-head `@`, validates the shape
 *     → the user approves (and may edit) through a managed dialog
 *     → the approved MiL is handed to the running agent as a user message;
 *       dsh's own model selection answers it
 *     → the conversion metadata is written to the plugin's storage namespace
 *
 * Seam status (measured against the installed type definitions):
 *   VERIFIED  ctx.agents (list/roots/get/currentInitiator, Agent.followup)
 *   VERIFIED  ctx.tuiDialogs.confirm/input (dialog shapes, INPUT_CELLS = 500)
 *   VERIFIED  ctx.tuiPluginStorage.open(ctx) → { get, set, delete }
 *   VERIFIED  apply(ctx, config) receives the loader entry's `config`
 *   Every optional seam is soft-probed and a missing one produces an explicit
 *   message instead of a crash.
 */

import { normalizeConfig, withExamples } from './src/config.mjs'
import {
  buildBacktranslateMessages,
  buildConvertMessages,
  looksLikeQuestionOnly,
  parseArgs,
  stripSpecClauses,
  substituteAt,
  unwrapSingleFence,
  USAGE,
  validateMil,
} from './src/mil.mjs'
import { createSarashinaClient, describeSarashinaError } from './src/sarashina.mjs'
import { cellWidth, composeDeliveryBody, deliver, flattenForHost, notification, recordConversion, resolveAgent } from './src/delivery.mjs'
import { hasInteractionSeam, requestDecision, requestText } from './src/interaction.mjs'
import { openStorageDomainHandle } from './src/storage-domain.mjs'
import { softGet } from './src/seams.mjs'
import { createLogStore, makeRecord } from './src/log.mjs'
import { resolveApiKey } from './src/credentials.mjs'
import { buildReplyLanguageSection } from './src/prompt.mjs'
import { buildSettingsSection } from './src/settings.mjs'
import { loadFrozenExamples, frozenExamplesLabel, loadPromptSpec, promptSpecLabel, loadReferenceStyle, referenceStyleLabel } from './src/spec.mjs'

export const name = '1tempo'
export const inject = ['commands']

/** The edit dialog's documented input bound. */
const INPUT_CELLS = 500

/**
 * Storage handle, in host order.
 *
 * TUI first (its own namespace + grant model), then the server-side storage
 * domain, which is what the web host mounts (see src/storage-domain.mjs for the
 * measured split). Resolved lazily by the log store, so `apply` stays sync.
 */
async function openStorageHandle(ctx) {
  const runtime = softGet(ctx, 'tuiPluginStorage')
  if (runtime && typeof runtime.open === 'function') {
    try {
      return runtime.open(ctx)
    } catch {
      // Fall through: a rejected TUI storage must not stop the web path.
    }
  }
  return openStorageDomainHandle(ctx)
}

/** One labelled text block for a diagnostic result. */
function section(title, body) {
  return [title, '', '```text', body, '```', ''].join('\n')
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {Record<string, unknown>} config
 * @param {ReturnType<typeof createLogStore>} store
 */
function createHandler(ctx, config, store) {
  return async function handle(invocation) {
    const notes = []
    const parsed = parseArgs(invocation?.rawInput ?? '', {
      defaultModel: config.model,
      defaultBacktranslate: config.backtranslate === 'always',
    })

    if (parsed.kind === 'help') return { kind: 'success', text: `1tempo\n\n${USAGE}` }
    if (parsed.kind === 'error') return { kind: 'error', text: `1tempo\n\n${parsed.reason}\n\n${USAGE}` }

    // The web host's question answerer is scoped to a live agent: a request
    // without an agent scope reaches no answerer and fails closed with
    // NO_PROVIDER, so the review dialog never appears in the browser
    // (dsh-user-questions README, "Agent-scoped Web answering"; measured
    // 2026-10-17). Resolve once, with the same preference order the delivery
    // uses, and hand it to every question.
    const agentRegistry = softGet(ctx, 'agents')
    const answerAgent = agentRegistry && typeof agentRegistry.list === 'function' ? resolveAgent(agentRegistry).agent : undefined

    const apiKey = await resolveApiKey(ctx, 'SARASHINA_API_KEY')
    if (typeof apiKey !== 'string' || apiKey.trim().length === 0) {
      return {
        kind: 'error',
        text: '1tempo\n\nAPI キー `SARASHINA_API_KEY` が設定されていません。`~/.dsh/.credentials.yaml` または環境変数に設定してください。',
      }
    }

    let spec
    try {
      spec = await loadPromptSpec()
    } catch (error) {
      return { kind: 'error', text: `1tempo\n\n変換用 spec (${promptSpecLabel()}) を読めません: ${error?.message ?? String(error)}` }
    }

    let instruction = config.convertInstruction
    if (config.includeFrozenExample) {
      try {
        const [referenceStyle, examples] = await Promise.all([loadReferenceStyle(), loadFrozenExamples()])
        instruction = withExamples(instruction, { referenceStyle, examples })
        // Which example files were attached is deliberately NOT a note: it is
        // constant, and the notification budget (200 cells) is for the MiL.
        ctx.logger?.info?.(`1tempo: 見本 ${referenceStyleLabel()} / ${frozenExamplesLabel()}`)
      } catch (error) {
        notes.push(`- 見本を読めなかったため未使用: ${error?.message ?? String(error)}`)
      }
    }

    const client = createSarashinaClient({
      apiKey,
      retryWaitsMs: [...config.retryWaitsMs],
      requestTimeoutMs: config.requestTimeoutMs,
      minIntervalMs: config.minIntervalMs,
      onEvent: (event) => {
        if (event.type === 'retry') notes.push(`- 再試行 ${event.detail.attempt} 回目（${event.detail.reason}）: ${event.detail.waitMs}ms 待機`)
        if (event.type === 'rate-gate') notes.push(`- レート制限回避のため ${event.detail.waitedMs}ms 待機`)
      },
    })

    let converted
    try {
      converted = await client.chat({
        model: parsed.model,
        messages: buildConvertMessages(spec, parsed.prompt, instruction),
        temperature: config.temperature,
        seed: config.seed,
        maxCompletionTokens: config.maxCompletionTokens,
      })
    } catch (error) {
      const message = describeSarashinaError(error)
      if (config.failureMode === 'abort') {
        return { kind: 'error', text: `1tempo\n\n変換に失敗しました。設定により原文は送信しません。\n\n${message}` }
      }
      const decision = await requestDecision(ctx, {
        // Labels carry the question; the TUI dialog panel is too narrow for a
        // sentence, and explanatory text belongs in the conversation. The web
        // path renders the labels as a menu over `question`.
        title: '1tempo: 変換に失敗しました',
        question: 'Sarashina の変換に失敗しました。原文をそのまま送りますか？',
        confirmLabel: '原文を送る',
        cancelLabel: '中止',
        timeoutMs: config.dialogTimeoutMs,
        agent: answerAgent,
      })
      if (decision.status === 'unavailable') {
        return {
          kind: 'error',
          text: `1tempo\n\n変換に失敗しました。原文をそのまま送るか判断してください（承認 UI が使えないため自動送信しません）。\n\n${message}\n\n${section('原文', parsed.prompt)}`,
        }
      }
      if (decision.status !== 'confirmed') {
        const why = decision.status === 'timed-out' ? '（応答がありませんでした）' : ''
        return { kind: 'error', text: `1tempo\n\n中止しました${why}。\n\n${message}` }
      }
      return deliver(ctx, {
        store,
        text: parsed.prompt,
        record: makeRecord({
          original: parsed.prompt,
          mil: '',
          wire: parsed.prompt,
          model: '(変換なし)',
          attempts: 0,
          approved: true,
          delivered: false,
        }),
      })
    }

    const unwrapped = unwrapSingleFence(converted.text)
    const stripped = config.stripSpecClauses ? stripSpecClauses(unwrapped, spec) : { text: unwrapped, removed: [] }
    if (stripped.removed.length > 0) notes.push(`- 定義と逐語一致する節を ${stripped.removed.length} 件除去しました。`)
    const validated = validateMil(stripped.text)
    if (!validated.ok) {
      return {
        kind: 'error',
        text: `1tempo\n\nMiL として受け付けられません: ${validated.reason}\n\n${section('sarashina の生の応答', converted.text)}`,
      }
    }

    const mil = validated.text
    const wire = substituteAt(mil, config.atSymbol)

    let backtranslation
    if (parsed.backtranslate) {
      try {
        const back = await client.chat({
          model: parsed.model,
          messages: buildBacktranslateMessages(spec, mil, config.backtranslateInstruction),
          temperature: config.temperature,
          seed: config.seed,
          maxCompletionTokens: config.maxCompletionTokens,
        })
        backtranslation = back.text.trim()
      } catch (error) {
        backtranslation = `（逆翻訳に失敗: ${describeSarashinaError(error)}）`
      }
    }

    if (looksLikeQuestionOnly(mil)) {
      notes.push('- MiL が質問のみで、依頼内容が符号化されていません。原文の要件が落ちていないか確認し、必要なら編集してください。')
    }

    // The back translation is the point of `back`, so it takes the first note
    // slot (the notification budget is spent on the MiL, then these).
    if (typeof backtranslation === 'string' && backtranslation.trim().length > 0) {
      notes.unshift(`逆翻訳: ${backtranslation.trim()}`)
    }

    const base = {
      original: parsed.prompt,
      mil,
      wire,
      backtranslation,
      model: parsed.model,
      attempts: converted.attempts,
      notes,
    }

    // What will be sent: the MiL, plus the definition lines when prepend is on.
    const candidate = config.specPreamble === 'prepend' ? `${spec.trim()}\n\n${wire}` : wire

    // The report CANNOT go into the conversation as a log-only session event.
    //
    // Measured 2026-10-14, the hard way: `Session.append()` builds the event
    // envelope from `sourceEventSeqs`/`surfaceOp` only (dsh-session lib
    // `append()`), so a plugin cannot set the envelope's `ignorable: true`
    // marker. An unknown event type without that marker is refused when the log
    // is READ (`dsh-session-persistence` `validateStoredEvents`), which makes
    // the whole session unresumable:
    //
    //   session "2d94603a-…" contains event type "onetempo/conversion" (seq 141)
    //   unknown to this harness and not marked ignorable; refusing to
    //   interpret the log
    //
    // So the append is removed. Until a supported path for plugin-owned
    // ignorable events exists, the report stays in the notification (clipped by
    // the host at COMMAND_RESULT_CELLS = 200) and in this plugin's storage log.
    if (!hasInteractionSeam(ctx)) {
      return {
        kind: 'success',
        text: notification('送信していません（編集ダイアログが使えません）', candidate, notes),
      }
    }

    // One dialog only. The confirm dialog was removed (2026-10-14): it asked
    // "send this MiL?" while the MiL itself was not on screen yet — the
    // command's output is printed only after the handler returns, so the edit
    // dialog's initial value is the first place the user can actually read it.
    //
    // The bound is in CELLS, not code units: the host caps the dialog's initial
    // value with `cleanScalarText(value, INPUT_CELLS)` = `cleanRenderText`,
    // which folds whitespace and truncates with an ellipsis at 500 cells
    // (dsh-adapter/dialogs.js, sanitize.js). Measuring `.length` let Japanese
    // text of ~490 code units (~980 cells) through, and the user then edited an
    // already-truncated MiL. The 10-cell margin keeps the value inside the cap
    // after the host's own folding.
    let payload = candidate
    let skippedReview = false
    if (cellWidth(flattenForHost(candidate)) <= INPUT_CELLS - 10) {
      const reviewed = await requestText(ctx, {
        // TUI: the initial value is the first place the user can actually read
        // the MiL. Web (userQuestions): no prefill exists, so the MiL rides
        // `detail` and an empty answer keeps it.
        title: '1tempo: MiL を修正',
        header: '1tempo: MiL を修正',
        question: 'MiL を確認してください。修正する場合は修正後の MiL を貼り付けてください（空のまま送ると、この MiL をそのまま送ります）。',
        initial: candidate,
        timeoutMs: config.dialogTimeoutMs,
        agent: answerAgent,
      })
      if (reviewed.status === 'unavailable') {
        return {
          kind: 'success',
          text: notification('送信していません（編集ダイアログが使えません）', candidate, notes),
        }
      }
      if (reviewed.status !== 'text') {
        // Cancel means STOP: sending the unedited MiL here would defeat the
        // review step. A timeout is treated the same way.
        await recordConversion(store, { ...base, approved: false, delivered: false, messageId: null })
        const why = reviewed.status === 'timed-out' ? '（応答がありませんでした）' : ''
        return {
          kind: 'success',
          text: notification(`取り消しました${why}`, candidate, notes),
        }
      }
      const edited = reviewed.text
      if (edited.trim().length > 0) {
        const revalidated = validateMil(edited)
        if (!revalidated.ok) {
          return { kind: 'error', text: notification('修正後の MiL が受け付けられません', undefined, [revalidated.reason]) }
        }
        // The edited text is the payload: substitute the at-symbol, and put the
        // definition lines back only when they are not already there.
        const substituted = substituteAt(revalidated.text, config.atSymbol)
        const withPreamble = config.specPreamble === 'prepend' && !substituted.startsWith(spec.trim())
          ? `${spec.trim()}\n\n${substituted}`
          : substituted
        payload = withPreamble
        if (withPreamble !== candidate) notes.push('- 修正された MiL を送信します。')
      }
    } else {
      // The note cannot survive the notification budget when the MiL itself is
      // longer than 200 cells (it fills the whole budget), so the reason also
      // rides the headline, which is measured first.
      notes.push(`- MiL が編集ダイアログの上限（${INPUT_CELLS} セル）を超えるため、インライン修正は行いません。`)
      skippedReview = true
    }

    if (config.specPreamble === 'prepend') notes.push('- 定義行を前置して送信します（specPreamble=prepend）。')

    const body = composeDeliveryBody(payload, parsed.prompt, config.includeOriginalInMessage)

    return deliver(ctx, {
      store,
      text: body,
      // The notification shows the MiL alone; `body` may also carry the user's
      // request, which the conversation row already shows.
      displayMil: payload,
      notes,
      headlineSuffix: skippedReview ? ` ※ MiL が長いため編集ダイアログを開いていません（会話の行には全文が出ます）` : undefined,
      record: makeRecord({
        original: parsed.prompt,
        mil,
        wire: body,
        backtranslation: backtranslation ?? null,
        model: parsed.model,
        attempts: converted.attempts,
        approved: true,
        delivered: false,
      }),
    })
  }
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {Record<string, unknown>} [pluginConfig]
 */
export function apply(ctx, pluginConfig = {}) {
  const { config, warnings } = normalizeConfig(pluginConfig)
  // One store per activation: the handle is resolved lazily (apply stays
  // synchronous) and the in-memory ring accumulates across commands when
  // storage.local is unavailable.
  const store = createLogStore({ resolveHandle: () => openStorageHandle(ctx) })
  const handler = createHandler(ctx, config, store)

  // The command name must match dsh-commands' /^[a-z][a-z0-9_-]*$/u. The
  // project's first choice, `1tempo`, was rejected by that rule at activation
  // (restart.log, 2026-10-14: command name "1tempo" must match ...), so the
  // command is `onetempo`. The product and plugin id stay `1tempo`.
  const definition = {
    definitionId: 'onetempo',
    name: 'onetempo',
    description: 'Convert a request to MiL via Sarashina, approve it, and hand it to the selected model',
    // The `input` hint is not decoration: the web composer derives Enter
    // adjudication from it. dsh-client-ui-commands' `matchEnter` runs a line
    // that carries arguments (`/name args`) only when the descriptor declares
    // `input`; without it the same line is submitted to the model as ordinary
    // text (measured 2026-10-17). That branch requires a non-empty hint, so the
    // usage string doubles as one.
    input: { hint: '[mini|nano] [back] <依頼文>' },
    handler: async (invocation) => {
      try {
        const result = await handler(invocation)
        if (typeof result?.text !== 'string') return { kind: 'error', text: '1tempo\n\n内部エラー: 応答テキストがありません。' }
        return result
      } catch (error) {
        return { kind: 'error', text: `1tempo\n\n内部エラー: ${error?.stack ?? String(error)}` }
      }
    },
  }

  ctx.effect(function* registerOneTempo() {
    const pluginHost = softGet(ctx, 'tuiPluginHost')
    const commands = softGet(ctx, 'commands')
    let registered = false

    if (pluginHost && typeof pluginHost.registerCommand === 'function') {
      try {
        // Mediated registration: the host stamps the verified component
        // identity, so per-owner command denies can be enforced.
        yield pluginHost.registerCommand(ctx, definition)
        registered = true
      } catch (error) {
        // Admission can refuse an unmanifested local plugin. Boot must not die
        // for that: fall through to the documented unattributed registration.
        ctx.logger?.warn?.(`1tempo: 帰属つき登録に失敗したため commands.register へフォールバックします: ${error?.message ?? String(error)}`)
      }
    }

    if (!registered) {
      if (!commands || typeof commands.register !== 'function') {
        throw new Error('1tempo: commands サービスがありません（registerCommand も commands.register も使えません）。')
      }
      // Documented C-070 boundary: a direct registration is unattributed.
      yield commands.register(definition)
    }

    if (warnings.length > 0) {
      for (const warning of warnings) ctx.logger?.warn?.(`1tempo: ${warning}`)
    }

    // Optional surfaces. A composition that does not serve one is reported in
    // the log line rather than silently assumed, and a REJECTED one must not
    // roll back the command: measured 2026-10-14, an invalid settings-section
    // namespace deactivated the whole plugin, command included.
    const skipped = []

    const settingsSections = softGet(ctx, 'tuiSettingsSections')
    if (settingsSections && typeof settingsSections.register === 'function') {
      try {
        yield settingsSections.register(buildSettingsSection())
      } catch (error) {
        skipped.push(`tuiSettingsSections(失敗: ${error?.message ?? String(error)})`)
        ctx.logger?.warn?.(`1tempo: 設定セクションを登録できませんでした（コマンドは継続します）: ${error?.message ?? String(error)}`)
      }
    } else {
      skipped.push('tuiSettingsSections')
    }

    const replySection = buildReplyLanguageSection(config)
    if (replySection !== undefined) {
      const systemPrompt = softGet(ctx, 'systemPrompt')
      if (systemPrompt && typeof systemPrompt.section === 'function') {
        try {
          yield systemPrompt.section(replySection)
        } catch (error) {
          skipped.push(`systemPrompt(失敗: ${error?.message ?? String(error)})`)
          ctx.logger?.warn?.(`1tempo: system prompt 段を登録できませんでした（コマンドは継続します）: ${error?.message ?? String(error)}`)
        }
      } else {
        skipped.push('systemPrompt')
      }
    }

    ctx.logger?.info?.(
      `1tempo: registered /onetempo (model=${config.model}, backtranslate=${config.backtranslate}, atSymbol=${config.atSymbol})`
      + (skipped.length > 0 ? ` / 未接続: ${skipped.join(', ')}` : ''),
    )
  }, '1tempo command')
}
