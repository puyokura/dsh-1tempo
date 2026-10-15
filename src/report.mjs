/**
 * Parsing of a preflight report back into its cases.
 *
 * The converter side is rate-limited and flaky, so a decode-only pass reuses
 * the payloads already recorded in a report instead of converting again. The
 * parser is strict about shapes: a missing block yields a case with that field
 * undefined rather than a guessed value.
 */

/** Find the first ```text fence that starts after `fromIndex`. */
function fencedTextAfter(markdown, fromIndex) {
  const fence = markdown.indexOf('```text', fromIndex)
  if (fence < 0) return undefined
  const bodyStart = markdown.indexOf('\n', fence)
  if (bodyStart < 0) return undefined
  const bodyEnd = markdown.indexOf('\n```', bodyStart)
  if (bodyEnd < 0) return undefined
  return markdown.slice(bodyStart + 1, bodyEnd)
}

/**
 * Extract every `## 検証 <label>` case.
 *
 * @param {string} markdown
 * @returns {Array<{ label: string, prompt?: string, mil?: string, wire?: string }>}
 */
export function extractCases(markdown) {
  if (typeof markdown !== 'string') throw new TypeError('extractCases: markdown must be a string')
  const cases = []
  const sections = markdown.split(/^## 検証 /mu).slice(1)
  for (const section of sections) {
    const newline = section.indexOf('\n')
    const label = (newline < 0 ? section : section.slice(0, newline)).trim()
    const marker = newline < 0 ? section.length : newline
    const prompt = fencedTextAfter(section, section.indexOf('**原文**', marker))
    const milIndex = section.indexOf('**MiL（変換結果）**', marker)
    const mil = milIndex < 0 ? undefined : fencedTextAfter(section, milIndex)
    // The wire block is bounded by the decode block: a section that mentions
    // the wire heading without carrying the block must not borrow the decode
    // fence. Only a fence inside that window counts.
    let wire
    const wireIndex = section.indexOf('**ワイヤ表現', marker)
    if (wireIndex >= 0) {
      const decodeIndex = section.indexOf('**復号', wireIndex)
      const window = decodeIndex < 0 ? section.slice(wireIndex) : section.slice(wireIndex, decodeIndex)
      wire = fencedTextAfter(window, 0)
    }
    cases.push({ label, prompt, mil, wire: wire ?? mil })
  }
  return cases
}

/** Cases that actually carry a payload to decode. */
export function decodableCases(cases) {
  return cases.filter((entry) => typeof entry.wire === 'string' && entry.wire.trim().length > 0)
}
