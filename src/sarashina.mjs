/**
 * Sarashina Chat Completions adapter.
 *
 * Measured contract (2026-10-14):
 *   - POST https://api.sarashina.ai/v1/chat/completions
 *   - models: sarashina3-mini (6 RPM), sarashina3-nano (60 RPM), sarashina3-guard
 *   - temperature default 0.7, seed accepted (best-effort deterministic)
 *   - max_completion_tokens: default 8000, hard cap 8000 (a larger value is 400)
 *   - 429 carries no Retry-After; the vendor recommends exponential backoff
 *   - parameters outside the documented set are rejected with 400
 *
 * Only documented parameters are sent. The API key is never logged and never
 * included in an error message.
 */

import { rpmOf } from './config.mjs'

export const DEFAULT_BASE_URL = 'https://api.sarashina.ai/v1'

export class SarashinaError extends Error {
  /**
   * @param {string} message
   * @param {{ kind: 'http' | 'network' | 'timeout' | 'shape' | 'auth', status?: number, body?: string }} info
   */
  constructor(message, info) {
    super(message)
    this.name = 'SarashinaError'
    this.kind = info.kind
    this.status = info.status
    this.body = info.body
  }
}

const BODY_EXCERPT_CHARS = 500

function excerpt(value) {
  const text = typeof value === 'string' ? value : ''
  if (text.length <= BODY_EXCERPT_CHARS) return text
  return `${text.slice(0, BODY_EXCERPT_CHARS)}…（${text.length} 文字中）`
}

/**
 * Client-side spacing so the plugin does not create its own 429s.
 *
 * The vendor counts a 60-second window and allows no burst, so requests are
 * started no closer than 60000/rpm milliseconds apart. The wait happens before
 * a request, never before the first one.
 *
 * @param {{ rpm?: number, minIntervalMs?: number | null, now?: () => number, sleep?: (ms: number) => Promise<void> }} options
 */
export function createRateGate(options = {}) {
  const now = options.now ?? (() => Date.now())
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  const derived = options.rpm === undefined ? undefined : Math.ceil(60000 / options.rpm)
  const interval = options.minIntervalMs ?? derived
  let lastStart = undefined

  return {
    intervalMs: interval,
    /** Wait for the next allowed start, then record it. */
    async acquire() {
      if (interval === undefined || interval <= 0) {
        lastStart = now()
        return 0
      }
      if (lastStart === undefined) {
        lastStart = now()
        return 0
      }
      const elapsed = now() - lastStart
      const waitMs = interval - elapsed
      if (waitMs > 0) await sleep(waitMs)
      lastStart = now()
      return waitMs > 0 ? waitMs : 0
    },
  }
}

/**
 * Exponential backoff schedule. `retryWaitsMs` holds the wait before each
 * retry, so its length is the retry budget (3 entries = up to 4 requests).
 */
export function computeRetryWaits(retryWaitsMs) {
  if (!Array.isArray(retryWaitsMs) || retryWaitsMs.length === 0) {
    throw new TypeError('computeRetryWaits: retryWaitsMs must be a non-empty array')
  }
  return [...retryWaitsMs]
}

function extractText(payload) {
  const choice = payload?.choices?.[0]
  const content = choice?.message?.content
  if (typeof content !== 'string') return undefined
  return content
}

/**
 * @param {{
 *   apiKey: string,
 *   baseUrl?: string,
 *   fetchImpl?: typeof fetch,
 *   sleep?: (ms: number) => Promise<void>,
 *   now?: () => number,
 *   retryWaitsMs?: number[],
 *   requestTimeoutMs?: number,
 *   minIntervalMs?: number | null,
 *   onEvent?: (event: { type: string, detail?: Record<string, unknown> }) => void,
 * }} options
 */
export function createSarashinaClient(options) {
  const apiKey = options?.apiKey
  if (typeof apiKey !== 'string' || apiKey.trim().length === 0) {
    throw new SarashinaError('SARASHINA_API_KEY が設定されていません。', { kind: 'auth' })
  }
  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/u, '')
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  if (typeof fetchImpl !== 'function') {
    throw new SarashinaError('fetch が利用できません。', { kind: 'network' })
  }
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  const retryWaits = computeRetryWaits(options.retryWaitsMs ?? [10000, 20000, 40000])
  const requestTimeoutMs = options.requestTimeoutMs ?? 60000
  const onEvent = options.onEvent ?? (() => {})
  const gates = new Map()

  /**
   * Strip the API key from anything that may reach a message. A server error
   * body could echo the request, so the value is removed before it is
   * excerpted anywhere.
   */
  const redact = (value) => {
    const text = typeof value === 'string' ? value : String(value ?? '')
    return text.split(apiKey).join('[REDACTED]')
  }
  const safeExcerpt = (value) => excerpt(redact(value))

  function gateFor(model) {
    if (!gates.has(model)) {
      gates.set(model, createRateGate({
        rpm: rpmOf(model),
        minIntervalMs: options.minIntervalMs ?? null,
        now: options.now ?? (() => Date.now()),
        sleep,
      }))
    }
    return gates.get(model)
  }

  /**
   * One chat completion.
   *
   * @param {{ model: string, messages: Array<{role: string, content: string}>, temperature: number,
   *           seed?: number | null, maxCompletionTokens: number, signal?: AbortSignal }} request
   */
  async function chat(request) {
    const { model, messages } = request
    if (typeof model !== 'string' || model.length === 0) {
      throw new SarashinaError('モデル名が指定されていません。', { kind: 'shape' })
    }
    if (!Array.isArray(messages) || messages.length === 0) {
      throw new SarashinaError('messages が空です。', { kind: 'shape' })
    }

    const body = {
      model,
      messages,
      temperature: request.temperature,
      max_completion_tokens: request.maxCompletionTokens,
      stream: false,
    }
    if (request.seed !== undefined && request.seed !== null) body.seed = request.seed

    const gate = gateFor(model)
    let attempts = 0
    let lastError

    for (let attempt = 0; attempt <= retryWaits.length; attempt += 1) {
      attempts += 1
      const waited = await gate.acquire()
      if (waited > 0) onEvent({ type: 'rate-gate', detail: { model, waitedMs: waited } })

      const timeoutSignal = AbortSignal.timeout(requestTimeoutMs)
      const signal = request.signal ? AbortSignal.any([request.signal, timeoutSignal]) : timeoutSignal

      let response
      try {
        response = await fetchImpl(`${baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify(body),
          signal,
        })
      } catch (error) {
        // A caller-requested abort must not be retried.
        if (request.signal?.aborted) {
          throw new SarashinaError('呼び出しを中止しました。', { kind: 'network' })
        }
        const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError'
        lastError = new SarashinaError(
          timedOut ? `要求が ${requestTimeoutMs}ms でタイムアウトしました。` : `ネットワークエラー: ${redact(error?.message ?? String(error))}`,
          { kind: timedOut ? 'timeout' : 'network' },
        )
        if (attempt === retryWaits.length) throw lastError
        onEvent({ type: 'retry', detail: { attempt: attempts, reason: lastError.kind, waitMs: retryWaits[attempt] } })
        await sleep(retryWaits[attempt])
        continue
      }

      const isRetryableHttp = response.status === 429 || (response.status >= 500 && response.status <= 504)
      if (isRetryableHttp) {
        const text = await response.text().catch(() => '')
        const reason = response.status === 429 ? 'http-429' : `http-${response.status}`
        const message = response.status === 429
          ? 'レート制限 (429) を受け取りました。Retry-After は返りません。'
          : `サーバーエラー (HTTP ${response.status}) を受け取りました。`
        lastError = new SarashinaError(
          message,
          { kind: 'http', status: response.status, body: safeExcerpt(text) },
        )
        if (attempt === retryWaits.length) throw lastError
        onEvent({ type: 'retry', detail: { attempt: attempts, reason, waitMs: retryWaits[attempt] } })
        await sleep(retryWaits[attempt])
        continue
      }

      if (!response.ok) {
        const text = await response.text().catch(() => '')
        const kind = response.status === 401 || response.status === 403 ? 'auth' : 'http'
        throw new SarashinaError(
          `API が失敗しました (HTTP ${response.status})。`,
          { kind, status: response.status, body: safeExcerpt(text) },
        )
      }

      let payload
      try {
        payload = await response.json()
      } catch (error) {
        throw new SarashinaError(`応答が JSON として読めません: ${error?.message ?? String(error)}`, { kind: 'shape' })
      }

      const text = extractText(payload)
      if (text === undefined) {
        throw new SarashinaError('応答に message.content がありません。', { kind: 'shape', body: safeExcerpt(JSON.stringify(payload ?? null)) })
      }

      return {
        text,
        model: typeof payload.model === 'string' ? payload.model : model,
        usage: {
          promptTokens: payload?.usage?.prompt_tokens,
          completionTokens: payload?.usage?.completion_tokens,
          totalTokens: payload?.usage?.total_tokens,
        },
        finishReason: payload?.choices?.[0]?.finish_reason,
        attempts,
      }
    }

    throw lastError ?? new SarashinaError('呼び出しに失敗しました。', { kind: 'network' })
  }

  return { chat, baseUrl, retryWaits }
}

/** UI-facing one-liner for a failure. Never includes the API key. */
export function describeSarashinaError(error) {
  if (error instanceof SarashinaError) {
    const parts = [error.message]
    if (error.body) parts.push(`応答: ${error.body}`)
    return parts.join('\n')
  }
  return `予期しないエラー: ${error?.message ?? String(error)}`
}
