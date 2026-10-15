/**
 * TUI settings section descriptor for the plugin's own config namespace.
 *
 * Measured contract (`@deepseek-harness-tui/dsh-tui` channel-settings.d.ts):
 *   TuiSettingsSection = { ns, title, descriptions?, groups?, fields }
 *   TuiSettingsField   = { path, label, descriptions?, hint?, group?, kind,
 *                          options?, placeholder?, secret?, format?, parse? }
 *   kind ∈ 'text' | 'number' | 'boolean' | 'select'
 *   The registry is display metadata only: storage, validation and writes stay
 *   with the dsh settings service, keyed by the loader entry id (= `ns`).
 *
 * IMPORTANT LIMIT (measured, not assumed): `ctx.settings` builds forms from the
 * loader entry's Config schema, and this repository cannot declare one — a
 * schema library would have to be imported across the profile boundary, and a
 * bare specifier does not resolve from here (measured: ERR_MODULE_NOT_FOUND
 * for `@deepseek-ai/dsh-llm`). This section therefore declares WHAT is
 * editable; whether the screen can write depends on the entry carrying a
 * Config schema, which needs the plugin to be installed inside the profile.
 */

/**
 * Loader entry id used as the settings namespace.
 *
 * Measured rule (dsh-adapter/settings-sections.js registerSection): a
 * plugin-owned namespace must match /^[a-z][a-z0-9_-]*$/u, so `1tempo` is
 * rejected and the loader entry id must be `onetempo` for the screen to serve
 * this section. The visible product name stays `1tempo` in SETTINGS_TITLE.
 */
export const SETTINGS_NS = 'onetempo'

/** Namespace-derived section title. */
export const SETTINGS_TITLE = '1tempo (MiL-Bridge)'

/**
 * Build the section descriptor.
 *
 * Field order is the reading order: what is sent, then how it is sent, then how
 * failures behave, then the reply-language section.
 *
 * @returns {{
 *   ns: string, title: string,
 *   fields: ReadonlyArray<Record<string, unknown>>,
 * }}
 */
export function buildSettingsSection() {
  const fields = [
    {
      path: ['model'],
      label: 'Sarashina model',
      hint: 'mini は 6 RPM、nano は 60 RPM。',
      kind: 'select',
      options: [
        { value: 'sarashina3-nano', label: 'sarashina3-nano (60 RPM)' },
        { value: 'sarashina3-mini', label: 'sarashina3-mini (6 RPM)' },
      ],
    },
    {
      path: ['backtranslate'],
      label: 'Back translation',
      hint: 'always にすると、承認前に MiL を自然語へ復号して表示する（追加で 1 回呼び出す）。',
      kind: 'select',
      options: [
        { value: 'off', label: 'off (原文と MiL のみ)' },
        { value: 'always', label: 'always (逆翻訳も表示)' },
      ],
    },
    {
      path: ['atSymbol'],
      label: 'At-symbol substitute',
      hint: '着信側で @ がメンション展開されないよう、送信直前に置換する ASCII 記号。@ と空白は使えない。',
      kind: 'text',
      placeholder: 'ext:',
    },
    {
      path: ['failureMode'],
      label: 'On conversion failure',
      hint: 'confirm は原文を送るか確認する。abort は常に中止する。',
      kind: 'select',
      options: [
        { value: 'confirm', label: 'confirm (原文送信を確認)' },
        { value: 'abort', label: 'abort (常に中止)' },
      ],
    },
    {
      path: ['maxCompletionTokens'],
      label: 'Max completion tokens',
      hint: '1〜8000。Sarashina の上限は 8000。',
      kind: 'number',
      placeholder: '2000',
    },
    {
      path: ['minIntervalMs'],
      label: 'Minimum request interval (ms)',
      hint: '空欄ならモデルの RPM から算出する（nano 1000ms / mini 10000ms）。',
      kind: 'number',
      placeholder: 'auto',
    },
    {
      path: ['replyLanguageSectionEnabled'],
      label: 'Reply-language system section',
      hint: 'system prompt に返答言語の指示を足すか。',
      kind: 'boolean',
    },
    {
      path: ['replyLanguageSection'],
      label: 'Reply-language instruction',
      hint: '上の項目が有効なときに system prompt へ入る文面。',
      kind: 'text',
    },
  ]
  return { ns: SETTINGS_NS, title: SETTINGS_TITLE, fields }
}
