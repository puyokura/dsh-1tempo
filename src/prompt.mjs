/**
 * The reply-language system prompt section.
 *
 * Measured contract (`@deepseek-ai/dsh-system-prompt` index.d.ts):
 *   ctx.systemPrompt.section({ name, order, text, complete? }) → disposer
 *   PromptSection = { name (unique), order, text, complete? }
 *   Order convention from the same file: -100 harness identity, 0 deployment
 *   persona, tool guidance 100–199, other negative orders render before the
 *   persona.
 *
 * This section carries a plugin-side requirement that is NOT part of the MiL
 * specification: the target model should answer in natural Japanese rather
 * than mirroring the compressed notation (architecture.md §5, Q7).
 */

/** Unique section name. A duplicate registration throws, so it is namespaced. */
export const REPLY_SECTION_NAME = '1tempo:reply-language'

/**
 * Order 190: inside the documented 100–199 band, after ordinary tool guidance,
 * so the deployment persona and the harness identity keep their precedence.
 */
export const REPLY_SECTION_ORDER = 190

/**
 * Build the section, or undefined when it is disabled or empty.
 *
 * @param {{ replyLanguageSectionEnabled?: boolean, replyLanguageSection?: string }} config
 * @returns {{ name: string, order: number, text: string } | undefined}
 */
export function buildReplyLanguageSection(config) {
  if (config?.replyLanguageSectionEnabled !== true) return undefined
  const text = typeof config.replyLanguageSection === 'string' ? config.replyLanguageSection.trim() : ''
  if (text.length === 0) return undefined
  return { name: REPLY_SECTION_NAME, order: REPLY_SECTION_ORDER, text }
}
