/**
 * Read-only inspector for one session log (`session.v4.jsonl.zstd`).
 *
 * The stored log is a concatenation of zstd frames (measured: 86 frames in
 * 395,945 bytes), and Node's `zstdDecompressSync` decodes only the first one,
 * so every frame is decoded individually.
 *
 * Usage:
 *   node tools/inspect-session-log.mjs <session.v4.jsonl.zstd> [--kind user/message] [--last 5]
 *
 * Prints each matching event's seq, type, source kind/form, and the first lines
 * of its content. No value is modified; nothing is written.
 */

import { readFileSync } from 'node:fs'
import process from 'node:process'
import { zstdDecompressSync } from 'node:zlib'

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

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

function decodeAll(buffer) {
  const offsets = frameOffsets(buffer)
  const parts = []
  for (let index = 0; index < offsets.length; index += 1) {
    const start = offsets[index]
    const end = index + 1 < offsets.length ? offsets[index + 1] : buffer.length
    parts.push(zstdDecompressSync(buffer.subarray(start, end)).toString('utf8'))
  }
  return { text: parts.join(''), frames: offsets.length }
}

const target = process.argv[2]
if (target === undefined) {
  process.stderr.write('使い方: node tools/inspect-session-log.mjs <session.v4.jsonl.zstd> [--kind user/message] [--last 5]\n')
  process.exit(2)
}
const kindIndex = process.argv.indexOf('--kind')
const kind = kindIndex === -1 ? undefined : process.argv[kindIndex + 1]
const lastIndex = process.argv.indexOf('--last')
const last = lastIndex === -1 ? 5 : Number.parseInt(process.argv[lastIndex + 1], 10)
const grepIndex = process.argv.indexOf('--grep')
const grep = grepIndex === -1 ? undefined : process.argv[grepIndex + 1]
const typesOnly = process.argv.includes('--types')

const { text, frames } = decodeAll(readFileSync(target))
const events = []
for (const line of text.split('\n')) {
  if (line.trim() === '') continue
  try {
    events.push(JSON.parse(line))
  } catch {
    events.push({ unparsable: true })
  }
}

const matching = events.filter((event) => (kind === undefined ? true : event.type === kind))
process.stdout.write(`frames=${frames} events=${events.length} matching=${matching.length} kind=${kind ?? '(all)'}\n\n`)

if (typesOnly) {
  const counts = new Map()
  for (const event of events) counts.set(event.type ?? '(unparsable)', (counts.get(event.type ?? '(unparsable)') ?? 0) + 1)
  for (const [type, count] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
    process.stdout.write(`${String(count).padStart(5)}  ${type}\n`)
  }
  process.exit(0)
}

if (grep !== undefined) {
  // Which events carry this text? A match inside a request/attempt record means
  // the model was sent it; a match only in user/message means it is just logged.
  let hits = 0
  for (const event of events) {
    const raw = JSON.stringify(event)
    if (!raw.includes(grep)) continue
    hits += 1
    const data = event.data ?? {}
    const where = event.type === 'user/message' || event.type === 'assistant/message'
      ? (Array.isArray(data.content) ? data.content.map((b) => b?.text ?? '').join('').includes(grep) : false)
      : 'whole-event'
    process.stdout.write(`seq ${String(event.seq).padStart(4)}  ${event.type}  (match in: ${where === true ? 'content' : where})\n`)
  }
  process.stdout.write(`\nmatches: ${hits}\n`)
  process.exit(0)
}

for (const event of matching.slice(-Math.max(1, last))) {
  const data = event.data
  const source = data?.source ?? data?.message?.source
  const content = data?.content ?? data?.message?.content
  const body = Array.isArray(content)
    ? content.map((block) => (typeof block?.text === 'string' ? block.text : `[${block?.type ?? '?'}]`)).join('\n')
    : JSON.stringify(content ?? null)
  process.stdout.write([
    `seq ${event.seq} ${event.type} ${event.ignorable === true ? '(ignorable)' : ''}`,
    `  source: ${source === undefined ? '(none)' : JSON.stringify(source)}`,
    `  text  : ${body.split('\n').slice(0, 6).map((row) => row.slice(0, 120)).join('\n          ')}`,
    '',
  ].join('\n'))
}
