/**
 * Repair one session log that an unknown-not-ignorable plugin event made
 * unresumable (incident 2026-10-14, session 2d94603a).
 *
 * The harness refuses to read a log containing an event type it does not know
 * unless the event's envelope carries `ignorable: true`
 * (`dsh-session-persistence` `validateStoredEvents`). A plugin cannot set that
 * marker through `Session.append`, so the only repair is to add the marker to
 * the offending rows in the stored log.
 *
 * The stored log is a CONCATENATION of zstd frames (measured: 86 frames in
 * 395,945 bytes), and Node's `zstdDecompressSync` decodes only the first one.
 * This tool therefore decodes every frame, patches the offending rows, and
 * rebuilds the same number of frames so the file keeps its original layout.
 *
 * Only the offending lines are re-serialized; every other line is preserved
 * byte-for-byte, and `seq` values are untouched (deleting a row would break the
 * `seq = log.length` contiguity contract).
 *
 * Usage:
 *   node tools/repair-session-log.mjs <session.v4.jsonl.zstd> [--apply]
 *
 * Without `--apply` it writes `<path>.repaired`, re-reads that file to verify
 * it, and reports. With `--apply` it first copies the original to
 * `<path>.bak-1tempo-<timestamp>`, then replaces it.
 */

import { copyFileSync, readFileSync, writeFileSync } from 'node:fs'
import process from 'node:process'
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib'

/** Event types this incident can have written. */
const REPAIRABLE_TYPES = ['onetempo/conversion']
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

const target = process.argv[2]
const apply = process.argv.includes('--apply')
if (target === undefined) {
  process.stderr.write('使い方: node tools/repair-session-log.mjs <session.v4.jsonl.zstd> [--apply]\n')
  process.exit(2)
}

/** Offsets of every zstd frame in the file. */
function frameOffsets(buffer) {
  const offsets = []
  for (let index = 0; index <= buffer.length - ZSTD_MAGIC.length; index += 1) {
    if (buffer[index] === ZSTD_MAGIC[0] && buffer[index + 1] === ZSTD_MAGIC[1]
      && buffer[index + 2] === ZSTD_MAGIC[2] && buffer[index + 3] === ZSTD_MAGIC[3]) {
      offsets.push(index)
    }
  }
  return offsets
}

/** Decode every frame and return the per-frame plaintext in file order. */
function decodeFrames(buffer) {
  const offsets = frameOffsets(buffer)
  if (offsets.length === 0) throw new Error('zstd フレームが見つかりません。')
  const texts = []
  for (let index = 0; index < offsets.length; index += 1) {
    const start = offsets[index]
    const end = index + 1 < offsets.length ? offsets[index + 1] : buffer.length
    texts.push(zstdDecompressSync(buffer.subarray(start, end)).toString('utf8'))
  }
  return texts
}

const original = readFileSync(target)
const frameTexts = decodeFrames(original)
const text = frameTexts.join('')
const trailingNewline = text.endsWith('\n')
const lines = text.split('\n')
if (trailingNewline) lines.pop()

let patched = 0
let unparsable = 0
const repaired = lines.map((line) => {
  if (line.trim() === '') return line
  let event
  try {
    event = JSON.parse(line)
  } catch {
    unparsable += 1
    return line
  }
  if (event === null || typeof event !== 'object') return line
  if (event.ignorable === true) return line
  if (!REPAIRABLE_TYPES.includes(event.type)) return line
  patched += 1
  return JSON.stringify({ ...event, ignorable: true })
})

const patchedText = repaired.join('\n') + (trailingNewline ? '\n' : '')

// Rebuild the same number of frames, slicing the patched text with the original
// per-frame character budget. Frame boundaries may shift by the patch length;
// that is harmless, the concatenation is what the reader decodes.
const frames = []
let cursor = 0
for (let index = 0; index < frameTexts.length; index += 1) {
  const budget = frameTexts[index].length
  const slice = index === frameTexts.length - 1 ? patchedText.slice(cursor) : patchedText.slice(cursor, cursor + budget)
  cursor += slice.length
  frames.push(zstdCompressSync(Buffer.from(slice, 'utf8')))
}
const rebuilt = Buffer.concat(frames)

// Verify the rebuilt candidate before touching the original.
const verifyText = decodeFrames(rebuilt).join('')
let stillBad = 0
let verified = 0
for (const line of verifyText.split('\n')) {
  if (line.trim() === '') continue
  let event
  try {
    event = JSON.parse(line)
  } catch {
    stillBad += 1
    continue
  }
  verified += 1
  if (REPAIRABLE_TYPES.includes(event.type) && event.ignorable !== true) stillBad += 1
}

process.stdout.write([
  `file        : ${target}`,
  `frames      : ${frameTexts.length} -> ${frames.length}`,
  `size        : ${original.length} -> ${rebuilt.length}`,
  `text equal  : ${verifyText === patchedText}`,
  `lines       : ${lines.length} (parsed ${verified}, unparsable ${unparsable})`,
  `patched     : ${patched}`,
  `still bad   : ${stillBad}`,
  `apply       : ${apply}`,
  '',
].join('\n'))

if (stillBad > 0 || patched === 0 || verifyText !== patchedText) {
  process.stderr.write('検証に失敗したか、修正対象がありませんでした。書き込みません。\n')
  process.exit(1)
}

if (!apply) {
  writeFileSync(`${target}.repaired`, rebuilt)
  process.stdout.write(`乾式: ${target}.repaired を書き出しました（元ファイルは未変更）。\n`)
  process.exit(0)
}

const stamp = new Date().toISOString().replace(/[:.]/gu, '-')
const backup = `${target}.bak-1tempo-${stamp}`
copyFileSync(target, backup)
writeFileSync(target, rebuilt)
process.stdout.write(`適用: ${backup} に複製してから ${target} を置き換えました。\n`)
