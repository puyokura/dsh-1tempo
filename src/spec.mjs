/**
 * Spec loading.
 *
 * Two artifacts, deliberately separate:
 *
 *   prompt-v0-snapshot-2026-09-25.txt
 *     The conversion payload: the author's definition lines verbatim, nothing
 *     else. This is what goes into the system message of the Sarashina call.
 *
 *   v0-snapshot-2026-09-25.md
 *     The documented snapshot: sources, quotes, rules read off the quotes,
 *     plugin-side additions, and the explicit record of what could not be
 *     obtained. Human documentation only — never sent to a model.
 *
 * Why the split (measured 2026-10-14): sending the documentation file as the
 * system message made the model paraphrase the document back instead of
 * converting the request (see preflight-report-run1.md). The prompt payload is
 * therefore kept to the definition text alone.
 */

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

export const PROMPT_SPEC_NAME = 'prompt-v0-snapshot-2026-09-25.txt'
export const DOCUMENTED_SPEC_NAME = 'v0-snapshot-2026-09-25.md'
export const FROZEN_EXAMPLES_NAME = 'examples-v0.txt'
export const REFERENCE_STYLE_NAME = 'reference-style.txt'

const PROMPT_SPEC_URL = new URL(`../mil-spec/${PROMPT_SPEC_NAME}`, import.meta.url)
const DOCUMENTED_SPEC_URL = new URL(`../mil-spec/${DOCUMENTED_SPEC_NAME}`, import.meta.url)
const FROZEN_EXAMPLES_URL = new URL(`../mil-spec/${FROZEN_EXAMPLES_NAME}`, import.meta.url)
const REFERENCE_STYLE_URL = new URL(`../mil-spec/${REFERENCE_STYLE_NAME}`, import.meta.url)

let promptSpecPromise
let documentedSpecPromise
let frozenExamplesPromise
let referenceStylePromise

/** The conversion payload: the raw definition lines. Cached per process. */
export function loadPromptSpec() {
  promptSpecPromise ??= readFile(fileURLToPath(PROMPT_SPEC_URL), 'utf8')
  return promptSpecPromise
}

/** The human-readable snapshot. Never sent to a model. */
export function loadDocumentedSpec() {
  documentedSpecPromise ??= readFile(fileURLToPath(DOCUMENTED_SPEC_URL), 'utf8')
  return documentedSpecPromise
}

/**
 * The request→MiL pairs the converter imitates (案C). Written by this plugin:
 * the original posts contain no request-encoding example
 * (mil-spec/author-examples.md §5-3).
 */
export function loadFrozenExamples() {
  frozenExamplesPromise ??= readFile(fileURLToPath(FROZEN_EXAMPLES_URL), 'utf8')
  return frozenExamplesPromise
}

/**
 * The author's real MiL content, as a form reference. Transcribed from the
 * original image by the user's analysis; this agent cannot read the image, so
 * the transcription is not independently verified.
 */
export function loadReferenceStyle() {
  referenceStylePromise ??= readFile(fileURLToPath(REFERENCE_STYLE_URL), 'utf8')
  return referenceStylePromise
}

/** Path used in messages, without leaking an absolute host path. */
export function promptSpecLabel() {
  return `mil-spec/${PROMPT_SPEC_NAME}`
}

export function frozenExamplesLabel() {
  return `mil-spec/${FROZEN_EXAMPLES_NAME}`
}

export function referenceStyleLabel() {
  return `mil-spec/${REFERENCE_STYLE_NAME}`
}
