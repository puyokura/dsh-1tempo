# dsh への要望: プラグインから会話（transcript）へ行を書く公開 API

## 要望

プラグインが、コマンド結果の通知欄（200 セルで切られる）ではなく、**会話の行**として任意のテキストを表示できる公開 API を追加してください。

## 実測した現状

環境: `@deepseek-harness-tui/dsh-tui`（プロファイル `dsh-tui`）、`@deepseek-ai/dsh-commands`、`@deepseek-ai/dsh-session`。すべてインストール済みの実物のコードを読んで確認した。

1. **コマンド結果は通知に回る。会話には出ない。**
   `lib/types/screens/Chat.js`
   ```js
   const cleaned = cleanRenderText(outcome.text, COMMAND_RESULT_CELLS); // = 200
   if (cleaned !== '') channel.notify(cleaned, outcome.kind === 'error' ? { color: 'error' } : undefined);
   ```
   `CommandResult` は `{ kind: 'success' | 'error', text }` のみ（`@deepseek-ai/dsh-commands` `types.d.ts`）。

2. **会話の行を書けるのは dsh 内部だけ。**
   `lib/types/dsh-adapter/channel/core/local-actions.js`
   ```js
   pushLocal(title, lines) {
       state.rows.push({ id: rowIds.value++, kind: 'local', text: title });
       for (const line of lines)
           state.rows.push({ id: rowIds.value++, kind: 'local-output', text: preview(line, LOCAL_OUTPUT_LIMIT) });
   ```
   これは `action-readiness.js` の内部経路で、プラグインからは到達できない。

3. **プラグイン公開面に transcript へ書く口が無い。**
   `lib/types/api.d.ts` が公開するのは extensions（dialogs / status / shortcuts / renderers / themes / toast）、plugin-host（storage / messages.observe / ledger）、scenes、panels、settings-sections、command-trees、workspaces。`plugin-host.d.ts` に transcript / local / row / notice は一件も無い。

4. **`ctx.tuiRenderers` は現状プラグインから使えない。**
   `lib/types/dsh-adapter/renderers.d.ts` には「A plugin that appends its own log-only session events (`session.append('my-plugin/event', payload)`) registers a renderer mapping the payload to plain TEXT rows」と書かれている。しかし `@deepseek-ai/dsh-session` の `append()` は envelope に `sourceEventSeqs` と `surfaceOp` しか入れず、**`ignorable` を付ける手段が無い**。
   ```js
   append(type, data, ...opts) {
       const surfaceOpts = opts[0];
       const surfaceMetadata = { ...sourceEventSeqs..., ...surfaceOp... };
       const event = deepFreeze({ type, seq, time, data: dataSnapshot, ...surfaceMetadataSnapshot });
   ```
   未知の type を `ignorable` 無しで書くと、`@deepseek-ai/dsh-session-persistence` の `validateStoredEvents` が**読込時に**拒否し、セッション全体が再開不能になる。
   ```
   session "…" contains event type "onetempo/conversion" (seq 141) unknown to this
   harness and not marked ignorable; refusing to interpret the log
   ```
   実際にこの事象が発生し、セッションのログを手で修復する必要があった（後述の再現手順）。

5. **`source.form = 'notice'` の `summary` は会話の行に描画されない。**
   `@deepseek-ai/dsh-llm` の message.d.ts は `{ form: 'notice', summary }` を「行を展開せずに表示される 1 行の説明」と定義し、`dsh-plan-mode` も実際にこの source でユーザーメッセージを作っている。しかしプラグインが送信メッセージにこの source を付けても、会話の行に出るのは `content` のままで、`summary` は表示されなかった（実機確認）。
   `dsh-tui` の `lib/types/*.js` にも `source.form` / `source.summary` の参照は無い。

6. **プラグインのメッセージは「利用者の発言」にならない。`/rewind` の対象にもならない。**
   `lib/types/dsh-adapter/trajectory/projection.js`
   ```js
   case 'user/message': {
       const sourceKind = data?.source?.kind;
       const isHuman = sourceKind === 'user';
       // A direct human prompt is a USER row; everything else on the user-role
       // surface (skill bodies, file-change notices, goal continuations) is an
       // injected CONTEXT row — same distinction the official ledger draws.
       push(state, nodes, { kind: isHuman ? 'user' : 'context', label: isHuman ? '' : sourceKind, detail: text });
   }
   ```
   同じ線引きが戻り先の選択にもある（`lib/types/dsh-adapter/sessionTree.js:275`、`session-lineage.js:44` が `source.kind !== 'user'` を除外）。このため、
   - プラグインが送ったメッセージは会話の context 行になり、利用者自身の行にはならない
   - `/rewind` の候補にもならない
   - スラッシュコマンドの入力（`/onetempo <依頼>` の `<依頼>`）はそもそも会話の行として記録されない

   結果として、プラグイン経由でモデルへ依頼を渡す使い方では、**利用者が自分の言葉でターンを識別できず、そのターンへ戻ることもできない**。これは表示の問題ではなく、利用者とプラグインの区別を `source.kind === 'user'` の一点に置いた設計から来ている。

7. **表示されないことが `/rewind` の実用性を壊す。**
   送信メッセージの `content` を MiL にすると、会話のユーザー行は MiL になる。`/rewind` は会話の行を手掛かりに戻り先を選ぶため、**利用者が自分の言葉で過去のターンを識別できない**。原文を `content` に入れれば解決するが、それは対象モデルへ原文を渡すことになり、MiL へ圧縮して送る目的と衝突する。表示だけを差し替える手段が無いことが、この用途の実用性を直接損なっている。

## 現状で取れる唯一の回避策と、その代償

会話に出せるのは「対象モデルへ渡すユーザーメッセージ」だけである。`ctx.agents.get(id).followup(message)` で本文を送れば会話の行になるが、**対象モデルもその本文を読む**。MiL へ圧縮して送ることを目的にしたプラグインでは、レポート（原文・変換メタデータ）をそこへ載せると圧縮の前提が崩れる。

## 提案（どれか 1 つで足りる）

1. `ctx.tuiTranscript.push({ title?, lines })` のような、プラグインが会話の行を追加できる公開 API
2. `Session.append` の envelope に `ignorable: true` を渡せるようにする（`renderers.d.ts` の記述どおりに動かす）
3. `CommandResult` に会話へ出す種別（例: `kind: 'transcript'`）を追加する、または通知の上限 `COMMAND_RESULT_CELLS = 200` を設定可能にする
4. **送信メッセージの表示テキストを `content` と別に指定できるようにする**（例: `source.form = 'notice'` の `summary` を実際に描画する、または `displayText` のような欄を設ける）。モデルへ渡す本文と、会話の行に出す本文を分けられれば、圧縮した本文を送りつつ利用者の言葉を会話に残せる
5. `/rewind` の候補が、ユーザー行の本文以外（送信前の元テキストなど）でも識別できるようにする
6. **プラグインが「利用者に代わって入力欄へ本文を入れる」公開 API**（利用者が Enter を押せば `source.kind: 'user'` の本物の行になる）。これが最も自然で、帰属も偽らない。現状 `HostFacade.channel.actions.submit` は `@internal`、`tuiPanels.sendToChat` は恒 `false`

## 本リポジトリでの当面の回避策

`source.kind: 'user'` で送ることにした（ユーザー判断、2026-10-15）。会話に利用者の行として出て `/rewind` も効くが、**セッションログ上は利用者が送った記録になる**。この帰属の偽りを避けるには上記 6 の API が要る。変換の来歴はプラグイン側の storage ログと通知に残している。

送信本文は MiL のみである。本文の先頭に利用者の原文を置けば会話では識別しやすいが、`content` は会話表示とモデル入力を兼ねるため（実測: `agent/inbox/spliced` に本文が入る）、**原文がそのままモデルへ渡り、MiL へ圧縮する意味が失われる**。ユーザーは圧縮を優先し、原文を本文に含めないことを選んだ（`qa-record.md` §6.23・§6.24）。会話に利用者の言葉を残しつつモデルには圧縮形だけを渡すには、上記 4 か 6 が必要である。

## 再現手順

```powershell
# 1. 200 セルを超えるコマンド結果は必ず切れる（通知欄に … が付く）
#    任意のプラグインで text に 200 セル超の文字列を返す

# 2. 未知のログ専用イベントを append すると、次回の再開が失敗する
#    session.append('onetempo/conversion', payload) を実行して TUI を再起動
dsh-tui --resume <session-id>
# -> dsh-tui startup failed: cannot resume session "…": contains event type
#    "onetempo/conversion" (seq N) unknown to this harness and not marked ignorable
```

本リポジトリの `tools/repair-session-log.mjs` は、この状態のログ（複数の zstd フレームの連結）を復号し、該当行に `ignorable: true` を付けて再圧縮する復旧ツールである。恒久的な回避策ではない。

## 参照したファイル

| 内容 | パス |
| --- | --- |
| コマンド結果 → 通知 | `@deepseek-harness-tui/dsh-tui/lib/types/screens/Chat.js` |
| 会話の行の追加 | `@deepseek-harness-tui/dsh-tui/lib/types/dsh-adapter/channel/core/local-actions.js` |
| 行の切り詰め | `@deepseek-harness-tui/dsh-tui/lib/types/channel/transcript.js` |
| レンダラの説明 | `@deepseek-harness-tui/dsh-tui/lib/types/dsh-adapter/renderers.d.ts` |
| プラグイン公開面 | `@deepseek-harness-tui/dsh-tui/lib/types/api.d.ts`、`plugin-host.d.ts` |
| append の実装 | `@deepseek-ai/dsh-session/lib/index.js` |
| 読込時の拒否 | `@deepseek-ai/dsh-session-persistence/lib/index.js` |
