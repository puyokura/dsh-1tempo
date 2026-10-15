import test from 'node:test'
import assert from 'node:assert/strict'

import {
  substituteAt,
  unwrapSingleFence,
  validateMil,
  buildConvertMessages,
  buildBacktranslateMessages,
  extractMilSection,
  stripSpecClauses,
  splitTopLevel,
  looksLikeQuestionOnly,
  parseArgs,
  USAGE,
} from '../src/mil.mjs'
import { CONVERT_INSTRUCTION_DEFAULT } from '../src/config.mjs'

const SPEC = '// spec body marker'

test('substituteAt replaces a token-head @', () => {
  assert.equal(substituteAt('@EN>abbr:ILU', 'ext:'), 'ext:EN>abbr:ILU')
  assert.equal(substituteAt('a @GPT b', 'ext:'), 'a ext:GPT b')
  assert.equal(substituteAt('@a @b', 'ext:'), 'ext:a ext:b')
})

test('substituteAt leaves a mid-token @ alone', () => {
  assert.equal(substituteAt('hello@world', 'ext:'), 'hello@world')
  assert.equal(substituteAt('mail: a@b.c', 'ext:'), 'mail: a@b.c')
})

test('substituteAt leaves a bare @ with no token body alone', () => {
  assert.equal(substituteAt('end @', 'ext:'), 'end @')
})

test('substituteAt handles newline and tab separators', () => {
  assert.equal(substituteAt('x\n@a', 'ext:'), 'x\next:a')
  assert.equal(substituteAt('x\t@a', 'ext:'), 'x\text:a')
})

test('substituteAt keeps a quoted token body', () => {
  assert.equal(substituteAt('@"my dir/a"', 'ext:'), 'ext:"my dir/a"')
})

test('substituteAt is idempotent', () => {
  const once = substituteAt('@a @b', 'ext:')
  assert.equal(substituteAt(once, 'ext:'), once)
})

test('substituteAt rejects an invalid symbol', () => {
  assert.throws(() => substituteAt('@a', ''), TypeError)
  assert.throws(() => substituteAt('@a', 'x@y'), TypeError)
})

test('unwrapSingleFence unwraps exactly one whole-text fence', () => {
  assert.equal(unwrapSingleFence('```\nMiL;here\n```'), 'MiL;here')
  assert.equal(unwrapSingleFence('```mil\nMiL;here\n```'), 'MiL;here')
})

test('unwrapSingleFence preserves anything else verbatim', () => {
  assert.equal(unwrapSingleFence('MiL;here'), 'MiL;here')
  assert.equal(unwrapSingleFence('前置き\n```\nMiL;here\n```'), '前置き\n```\nMiL;here\n```')
})

test('validateMil accepts trimmed text and rejects bad shapes', () => {
  assert.deepEqual(validateMil('  MiL;x  '), { ok: true, text: 'MiL;x' })
  assert.equal(validateMil('').ok, false)
  assert.equal(validateMil('   ').ok, false)
  assert.equal(validateMil(undefined).ok, false)
  assert.equal(validateMil('abcde', { maxChars: 4 }).ok, false)
  assert.equal(validateMil('bad\u0007char').ok, false)
  assert.equal(validateMil('ok\nline\ttab').ok, true)
})

test('buildConvertMessages keeps the system message to the spec alone', () => {
  const messages = buildConvertMessages(SPEC, '依頼文', '指示')
  assert.equal(messages.length, 2)
  assert.equal(messages[0].role, 'system')
  assert.match(messages[0].content, /spec body marker/)
  // Isolation: the instruction must not sit next to the spec, or the model
  // paraphrases the definition instead of encoding the request.
  assert.equal(messages[0].content.includes('指示'), false)
  assert.equal(messages[0].content.includes('依頼文'), false)
  assert.equal(messages[1].role, 'user')
  assert.match(messages[1].content, /指示/)
  assert.ok(messages[1].content.endsWith('依頼文'), messages[1].content)
})

test('buildBacktranslateMessages never carries the original request', () => {
  const messages = buildBacktranslateMessages(SPEC, 'MiL;x', '指示')
  assert.equal(messages.length, 2)
  assert.equal(messages[1].role, 'user')
  assert.equal(messages[1].content, 'MiL;x')
  const serialized = JSON.stringify(messages)
  assert.equal(serialized.includes('依頼文'), false)
})

test('parseArgs reads flags in either order and keeps the prompt verbatim', () => {
  const defaults = { defaultModel: 'sarashina3-nano', defaultBacktranslate: false }
  assert.deepEqual(parseArgs('  mini back 3D モデル を作って', defaults), {
    kind: 'request',
    model: 'sarashina3-mini',
    backtranslate: true,
    prompt: '3D モデル を作って',
  })
  assert.deepEqual(parseArgs('back nano hello', defaults), {
    kind: 'request',
    model: 'sarashina3-nano',
    backtranslate: true,
    prompt: 'hello',
  })
})

test('parseArgs handles irregular whitespace between flags without corrupting the prompt', () => {
  const defaults = { defaultModel: 'sarashina3-nano', defaultBacktranslate: false }
  // Regression: multiple spaces between flags previously miscalculated the slice offset,
  // causing characters from the last flag or spaces to leak into the prompt.
  assert.deepEqual(parseArgs('mini    back    hello world', defaults), {
    kind: 'request',
    model: 'sarashina3-mini',
    backtranslate: true,
    prompt: 'hello world',
  })
  assert.deepEqual(parseArgs("nano\t\tback\t\tdo\tsomething", defaults), {
    kind: 'request',
    model: 'sarashina3-nano',
    backtranslate: true,
    prompt: "do\tsomething",
  })
})

test('parseArgs keeps flag-looking words inside the prompt', () => {
  const defaults = { defaultModel: 'sarashina3-nano', defaultBacktranslate: false }
  assert.deepEqual(parseArgs('mini back', defaults), { kind: 'error', reason: '依頼文がありません。' })
  assert.deepEqual(parseArgs('mini これは nano の話', defaults), {
    kind: 'request',
    model: 'sarashina3-mini',
    backtranslate: false,
    prompt: 'これは nano の話',
  })
})

test('parseArgs returns help for an empty or help input', () => {
  const defaults = { defaultModel: 'sarashina3-nano', defaultBacktranslate: false }
  assert.deepEqual(parseArgs('', defaults), { kind: 'help' })
  assert.deepEqual(parseArgs('   ', defaults), { kind: 'help' })
  assert.deepEqual(parseArgs('help', defaults), { kind: 'help' })
})

test('parseArgs applies the configured defaults', () => {
  const parsed = parseArgs('依頼', { defaultModel: 'sarashina3-mini', defaultBacktranslate: true })
  assert.equal(parsed.model, 'sarashina3-mini')
  assert.equal(parsed.backtranslate, true)
})

const SPEC_FIXTURE = 'cstr≫C≫R; tok:=active_tokenizer; @:=ext_only; IF:=cond'

test('stripSpecClauses removes verbatim spec clauses and keeps adapted ones', () => {
  const mil = 'Cstr≫C; C:=argmin_tok{s:⟦s⟧_ctx=log}; tok:=active_tokenizer; R:=tie(error)→summarize; @:=ext_only; IF:=cond'
  const result = stripSpecClauses(mil, SPEC_FIXTURE)
  assert.equal(result.text, 'C:=argmin_tok{s:⟦s⟧_ctx=log}; R:=tie(error)→summarize')
  assert.deepEqual(result.removed, ['Cstr≫C', 'tok:=active_tokenizer', '@:=ext_only', 'IF:=cond'])
})

test('stripSpecClauses preserves semicolons nested inside braces or parentheses', () => {
  const mil = 'goal:=check(dir); amb→qmin{style?; stack?}; tok:=active_tokenizer'
  const result = stripSpecClauses(mil, SPEC_FIXTURE)
  assert.equal(result.text, 'goal:=check(dir); amb→qmin{style?; stack?}')
  assert.deepEqual(result.removed, ['tok:=active_tokenizer'])
})

test('splitTopLevel splits only on delimiters at nesting depth 0', () => {
  assert.deepEqual(splitTopLevel('a; b; c'), ['a', ' b', ' c'])
  assert.deepEqual(splitTopLevel('a; {b; c}; d'), ['a', ' {b; c}', ' d'])
  assert.deepEqual(splitTopLevel('fn(1; 2); [x; y]'), ['fn(1; 2)', ' [x; y]'])
  assert.throws(() => splitTopLevel(null), TypeError)
})

test('stripSpecClauses matches case-insensitively with collapsed whitespace', () => {
  const result = stripSpecClauses('TOK :=  ACTIVE_TOKENIZER ; keep(me)', SPEC_FIXTURE)
  assert.equal(result.text, 'keep(me)')
  assert.deepEqual(result.removed, ['TOK :=  ACTIVE_TOKENIZER'])
})

test('stripSpecClauses returns the text unchanged without a spec', () => {
  const text = 'a; b'
  assert.deepEqual(stripSpecClauses(text, ''), { text, removed: [] })
  assert.deepEqual(stripSpecClauses(text, undefined), { text, removed: [] })
  assert.throws(() => stripSpecClauses(undefined, SPEC_FIXTURE), TypeError)
})

test('stripSpecClauses can empty the text, which validation then rejects', () => {
  const result = stripSpecClauses('tok:=active_tokenizer; IF:=cond', SPEC_FIXTURE)
  assert.equal(result.text, '')
  assert.equal(validateMil(result.text).ok, false)
})

test('extractMilSection drops an inline MiL label', () => {
  // Measured live 2026-10-14: the model answered with a label in front.
  const raw = 'request:={task:"create login_ui",usr:mobile,f:readable}; MiL:goal:=make(login_ui); usr:=mobile'
  assert.deepEqual(extractMilSection(raw), { text: 'goal:=make(login_ui); usr:=mobile', extracted: true })
})

test('extractMilSection uses the last inline label and ignores word continuations', () => {
  assert.deepEqual(
    extractMilSection('MiL: first; then MiL: second'),
    { text: 'second', extracted: true },
  )
  assert.deepEqual(extractMilSection('dataMIL:not_a_marker'), { text: 'dataMIL:not_a_marker', extracted: false })
})

test('the default conversion instruction forbids copying the examples', () => {
  assert.match(CONVERT_INSTRUCTION_DEFAULT, /そのまま写してはならない/u)
  assert.match(CONVERT_INSTRUCTION_DEFAULT, /含まれない対象/u)
  assert.match(CONVERT_INSTRUCTION_DEFAULT, /amb→qmin\{intent\?\}/u)
  // A real task with a missing detail must still be encoded.
  assert.match(CONVERT_INSTRUCTION_DEFAULT, /出力を質問だけにしてはならない/u)
})

test('looksLikeQuestionOnly detects a question-only MiL', () => {
  assert.equal(looksLikeQuestionOnly('amb→qmin{intent?}'), true)
  assert.equal(looksLikeQuestionOnly('  amb → qmin {intent?} ; '), true)
  assert.equal(looksLikeQuestionOnly('goal:=check(dir); amb→qmin{which_dir?}'), false)
  assert.equal(looksLikeQuestionOnly('goal:=make(x)'), false)
  assert.equal(looksLikeQuestionOnly(''), true)
  assert.throws(() => looksLikeQuestionOnly(undefined), TypeError)
})

test('the usage text carries the operation guide in the conversation', () => {
  // The dialog panel's own hint line is drawn by dsh and cannot be changed, so
  // the operating instructions live in the command's conversation output.
  assert.match(USAGE, /使い方: \/onetempo/u)
  assert.match(USAGE, /Esc \/ Ctrl\+C/u)
  assert.match(USAGE, /本文を編集して確定/u)
})
