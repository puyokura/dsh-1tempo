/**
 * Differential check: this plugin's `cellWidth` against the installed dsh-tui's
 * `stringWidth`.
 *
 * Why: the plugin budgets its notification (200 cells) and its edit-dialog
 * initial value (500 cells) so the host never has to clip. The host measures
 * with `lib/types/ink/stringWidth.js` and caps with
 * `cleanRenderText`/`cleanScalarText` (`lib/types/sanitize.js`). If our measure
 * UNDER-estimates, the host truncates with `…` and text the user needed to
 * review silently disappears; over-estimating only costs budget. So this check
 * fails on under-estimates and reports over-estimates as information.
 *
 * Usage:
 *   node tools/check-cell-width.mjs [--host <path to stringWidth.js>]
 *
 * The host path is discovered under the dsh profiles directory by default, so
 * the tool carries no machine-specific path. Nothing is executed from the
 * target beyond importing its measuring function.
 */

import { readdirSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { cellWidth, flattenForHost } from '../src/delivery.mjs'

/** Corpus: ASCII, CJK, punctuation, emoji, zero-width, controls, layout. */
const CORPUS = [
  '',
  'goal:=make(login_ui); usr:=mobile; f:=readable',
  '日本語',
  'MiL: 日本語',
  '編集ダイアログの上限（500 セル）を超えるため',
  'ｱｲｳｴｵ halfwidth',
  '　ideographic space　',
  '→ ■ ⚠ ± ambiguous-width',
  'e\u0301 combining acute',
  'a\u200bb zero width space',
  '⚠\ufe0f VS16 text-default emoji',
  '✳\ufe0f VS16 asterisk',
  '🚀 rocket',
  '🇯🇵 flag pair',
  '👨‍👩‍👧 ZWJ family',
  'ab\tcd\nef  gh',
  'esc\u001b[31mred\u001b[0m',
  '𠀀 CJK extension B',
  'nano/mini model names',
]

/** Locate the host's measuring module without hardcoding a machine path. */
function findHostStringWidth() {
  const explicit = process.env.DSH_TUI_STRING_WIDTH
  if (typeof explicit === 'string' && explicit.length > 0) return explicit
  const profiles = join(homedir(), '.dsh', 'profiles')
  if (!existsSync(profiles)) return undefined
  for (const profile of readdirSync(profiles)) {
    const base = join(profiles, profile, 'node_modules', '@deepseek-harness-tui', 'dsh-tui', 'lib')
    if (!existsSync(base)) continue
    for (const variant of ['types', '']) {
      const candidate = join(base, variant, 'ink', 'stringWidth.js')
      if (existsSync(candidate)) return candidate
    }
  }
  return undefined
}

const hostFlag = process.argv.indexOf('--host')
const hostPath = hostFlag === -1 ? findHostStringWidth() : process.argv[hostFlag + 1]
if (typeof hostPath !== 'string' || hostPath.length === 0) {
  process.stderr.write('host stringWidth.js が見つかりません。--host <path> か DSH_TUI_STRING_WIDTH で指定してください。\n')
  process.exit(2)
}

let hostStringWidth
try {
  ;({ stringWidth: hostStringWidth } = await import(pathToFileURL(hostPath).href))
} catch (error) {
  process.stderr.write(`host モジュールを読み込めません: ${hostPath}\n${error?.message ?? String(error)}\n`)
  process.exit(2)
}

let under = 0
let over = 0
let exact = 0
for (const sample of CORPUS) {
  const mine = cellWidth(sample)
  const host = hostStringWidth(sample)
  const label = JSON.stringify(sample).slice(0, 42)
  if (mine === host) {
    exact += 1
    continue
  }
  if (mine > host) {
    over += 1
    process.stdout.write(`over  ${String(mine).padStart(3)} > ${String(host).padStart(3)}  ${label}\n`)
  } else {
    under += 1
    process.stdout.write(`UNDER ${String(mine).padStart(3)} < ${String(host).padStart(3)}  ${label}\n`)
  }
}

// The budget comparison runs on the host's folded single line, so the same
// strings are compared after folding.
let foldMismatch = 0
for (const sample of CORPUS) {
  const folded = flattenForHost(sample)
  if (folded.includes('\n') || folded.includes('\t')) foldMismatch += 1
}

process.stdout.write(`\nhost=${hostPath}\nsamples=${CORPUS.length} exact=${exact} over(safe)=${over} under(unsafe)=${under}\n`)
process.stdout.write(`flattenForHost left raw layout in ${foldMismatch} sample(s) (must be 0)\n`)
if (under > 0 || foldMismatch > 0) {
  process.stdout.write('判定: 失敗（過小評価または平坦化漏れ）\n')
  process.exit(1)
}
process.stdout.write('判定: 合格（過小評価なし。過大評価は予算を余分に使うだけで切り詰めは起きない）\n')
