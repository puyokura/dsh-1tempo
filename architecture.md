# 1tempo プラグイン アーキテクチャ

| 項目 | 内容 |
| --- | --- |
| 版 | 1.0 |
| 作成日 | 2026-10-14 |
| 対象 | dsh プラグイン `/onetempo`（MiL 変換ブリッジ。プロジェクト名は 1tempo）。企画書は `proposal.md` として原状のまま |
| 姉妹文書 | 質疑応答の全記録・根拠・未検証項目・README 改訂案は `qa-record.md` |

---

## 1. 全体フロー

```
1. ユーザーが /onetempo [mini|nano] [back] <依頼文> を入力
2. プラグインが sarashina Chat Completions を呼ぶ
   - model: 引数 > コンフィグ既定（mini または nano）
   - messages: system = mil-spec、user = 原文
   - temperature: 0、seed: 固定
3. 応答の MiL を検証（空・拒否・形式外れを弾く）
4. `@` を ASCII 代替（既定 `ext:`）へ置換
5. 編集ダイアログを表示（原文＋MiL。逆翻訳は引数またはコンフィグで有効時のみ別呼び出し）
   - ctx.tuiDialogs.input のみ。初期値が送信payload なので、その場で読める
   - 確認ダイアログ（confirm）は使わない（MiL が見えないまま承認させることになるため 2026-10-14 に廃止）
6. 確定された MiL を ctx.agents の followup で差し込む（Esc / タイムアウトなら中止）
   - role: 'user'、source: { kind: 'user' }（**`form` を付けない**。`isHuman = source.kind === 'user'` が利用者とプラグインの唯一の線引きで、`/rewind` も同じ条件。§11 の制約参照）
   - content は「依頼: <原文>」→「MiL: <送信する MiL>」の順（`includeOriginalInMessage`、既定 true）
   - 実測（セッションログ 2 本の比較）: `form` 付きのメッセージは dsh 自身のコンテキスト注入と同じ扱いになり会話に出ない。`form` 無しなら会話の行として描画される。原文を content の先頭に置くのは、行が自分の言葉で始まり `/rewind` の戻り先を識別できるようにするため。対象モデルも原文を読む
7. 送信先モデル（dsh の選択モデル）が通常ターンとして応答
8. 変換メタデータを dsh の storage に記録
```

---

## 2. 送信ペイロードの行き先

| 送り先 | 渡すもの | 渡さないもの |
| --- | --- | --- |
| sarashina（変換） | mil-spec（system）、原文（user） | — |
| sarashina（逆翻訳・有効時） | mil-spec（system）、MiL のみ（user） | 原文 |
| 送信先モデル（dsh の選択モデル） | 置換済み MiL（`role: 'user'`、`source.kind: 'user'`）。`specPreamble: 'prepend'` のときは定義行を前置する | 原文、逆翻訳（`off` のときは mil-spec も渡さない）。`includeOriginalInMessage: true` は原文を本文に足す（会話でも識別しやすいがモデルも読む） |

送信本文は**会話の表示とモデル入力を兼ねる**（実測: `agent/inbox/spliced` に本文がそのまま入る）。dsh に両者を分ける欄が無いため、「会話に原文を出しつつ、モデルには MiL だけ」は成立しない。原文は既定で送らず、storage ログと通知に残す。

逆翻訳呼び出しに原文を含めないのは、含めると逆翻訳が原文の言い換えになり、意味抜けの検出装置として機能しなくなるため。逆翻訳は既定オフであり、この独立性の要件は「逆翻訳をオンにしたとき」に適用される。

---

## 3. 記号置換規則

| 原典の記号 | ワイヤ上の表現 | 復元 |
| --- | --- | --- |
| `@`（`@:=ext_only`） | `ext:`（ASCII、自己記述的。コンフィグで変更可） | しない |
| `⟨x⟩`（原典の alt_sym 案） | 使わない | — |

規則は mil-spec ファイルに明記する。復元しない理由は、dsh の送信経路が `@` トークンを添付展開（`expandMentions`）の対象にするため。

---

## 4. dsh 統合の接点

| 用途 | 使用する接点 | 根拠・安定性 |
| --- | --- | --- |
| スラッシュコマンド `/onetempo` | `ctx.tuiPluginHost.registerCommand` または `ctx.get('commands').register` | 前者は帰属つきの mediated 登録（C-041）。後者は帰属なし（文書化された C-070 境界）。**名前は `/^[a-z][a-z0-9_-]*$/` に一致が必要**（実測: `1tempo` は拒否される）。`commands` はコア（`@deepseek-ai/dsh-commands`、dsh-base）が提供するため **Web UI でも同じ呼び出しで登録でき**、結果テキストは会話のコマンドカードとして描画される（複数行は展開表示） |
| 承認・修正 | TUI: `ctx.tuiDialogs.input`／Web: `ctx.userQuestions.ask` | TUI は初期値に送信 payload を入れ、その場で読めるようにする。`timeoutMs` を明示（省略時はホスト既定 30 秒）。**下部の操作ヒントは dsh 側が描くため消せない**（消すならダイアログを使わない方式にする）。`confirm` は MiL を見せられないため MiL の確認には使わない。Web の `userQuestions` には初期値の欄もタイムアウト引数も無いので、現在の MiL を `detail` に置き、空の回答は「そのまま使う」と解釈し、時間切れは自前の `AbortSignal` で打ち切る（実測 2026-10-15） |
| 障害時の確認（原文を送るか） | TUI: `ctx.tuiDialogs.confirm`／Web: `ctx.userQuestions.ask`（選択肢 2 つ） | どちらも明示の肯定だけを送信とみなす。回答 UI が無い構成では送信せず、理由を返す |
| 対話接点が無い場合 | `unavailable` を返して**送信しない** | 未確認の MiL を送らない（fail closed）。表示だけ行い、理由を通知に出す |
| モデルへの差し込み | `ctx.agents.get(sessionId).followup(message)` | `@deepseek-ai/dsh-agent` の公開インターフェース |
| 返答言語の指示 | system prompt 段への寄与 | 「五 system prompt 段」（跟随上游） |
| 設定 UI | 設定セクション | 「六 设置区块」（安定候補）。保存・検証は dsh の settings サービス。**プラグイン所有の名前空間は `/^[a-z][a-z0-9_-]*$/` に一致が必要**（実測: `1tempo` は拒否される）。名前空間はローダー entry id と一致させる |
| ログ | TUI: `ctx.tuiPluginStorage`／Web: `ctx.storageDomain` | 保存は dsh 側が所有。プラグインは手書きファイルを持たない。TUI 側は名前空間・grant・256 KiB クォータを持つが、**Web ホストにこのサービスは存在しない**（実測 2026-10-15）。Web 側は `storageDomain.open(spec)`（domain 名 `tempo_bridge`、`single` レイアウトで `~/.dsh/storages/tempo_bridge.json`）。grant 検査は無い。TUI ホストには storage-domain が mount されていないため、両者は排他ではなく「そのホストにある方を使う」 |
| 会話への表示 | **不可**（`ctx.tuiRenderers.register` の登録だけ実装、append は撤去） | 実測: コマンド結果は `channel.notify` に回り `COMMAND_RESULT_CELLS = 200` で切られる。会話へ出すにはログ専用イベント（`session.append`）＋エントリレンダラが要るが、**`Session.append` は envelope に `ignorable` を付けられない**（実装が `sourceEventSeqs`/`surfaceOp` のみ包む）。未知 type を `ignorable` 無しで書くと `dsh-session-persistence` の `validateStoredEvents` が**読込時に**拒否し、セッションが再開不能になる（2026-10-14 に実害。§11 の制約参照） |
| 表示 | コマンド結果の `text` | 通知欄にしか出ない。`COMMAND_RESULT_CELLS = 200` で切れる。全文は編集ダイアログの初期値（490 セルまで）で読む |

採用しない接点: `HostFacade.channel.actions.submit`（`@internal`）、`tuiPanels.sendToChat`（恒 `false`）、パネル UI（compact 行が未描画）。

---

## 5. 設定項目（コンフィグ）

| 項目 | 既定 | 選択肢 |
| --- | --- | --- |
| 変換モデル | nano を推奨（60 RPM） | `sarashina3-mini`（6 RPM） / `sarashina3-nano`（60 RPM） |
| 逆翻訳 | 出さない | 常に出す / 出さない |
| 返答言語の指示文面 | 「返答は日本語の自然文で」 | 任意の文面、または無効 |
| 障害時の動作 | 原文を送るか確認 | 確認 / 常に中止 |
| 置換記号 | `ext:` | 任意の ASCII トークン |
| 定義行の前置 | off | off（MiL のみ） / prepend（定義行を前置。原典の例A と同じ運用） |
| 例の同梱 | 有効 | 有効 / 無効（`mil-spec/reference-style.txt` と `examples-v0.txt` を変換指示に足す） |
| 定義逐語節の除去 | 有効 | 有効 / 無効（変換結果から、定義と逐語一致する節を除く） |
| 429 の待機 | 10s → 20s → 40s、最大 3 回 | 待機列と回数を変更可 |
| ダイアログの上限 | 180000ms（3 分） | 明示必須。省略するとホスト既定 30 秒で取り消される。**取り消し（Esc / Ctrl+C / タイムアウト）は送信の中止**として扱い、未編集の MiL を送らない |
| 送信本文への原文の同梱 | 無効 | 有効（`依頼: <原文>` を先頭に置く。会話で識別しやすいが、対象モデルも原文を読む） / 無効（MiL のみを送る。既定） |

---

## 6. API 呼び出し仕様

| 項目 | 値 |
| --- | --- |
| エンドポイント | `POST https://api.sarashina.ai/v1/chat/completions` |
| 変換の messages | system: mil-spec、user: 原文 |
| 逆翻訳の messages | system: mil-spec、user: MiL のみ |
| `temperature` | 0（再現性のため固定） |
| `seed` | 固定値（ベストエフォートで決定的） |
| `max_completion_tokens` | 用途に応じて指定（上限 8000） |
| `response_format` | 必要なら `json_schema` + `strict`（MiL と不足質問の分離に使える） |
| 429 | 10s → 20s → 40s の指数バックオフ、最大 3 回。上限で中止しユーザーへ報告 |
| 認証キーの解決 | `ctx.credentials.resolve('SARASHINA_API_KEY')` → `process.env` → `~/.dsh/.credentials.yaml` の順で解決。キー値は決して表示・出力・ログに含めない |

`temperature` と `seed` の固定は、企画書 §8.3「同一入力を複数回実行し、ばらつきを記録する」の前提条件になる。

---

## 7. 引数体系

```
/onetempo [mini|nano] [back] <依頼文>
```

- `mini` / `nano`: 変換モデルの上書き（省略時はコンフィグ既定）
- `back`: 逆翻訳をオン（省略時はコンフィグ既定）
- 依頼文: 変換対象の原文

---

## 8. ログ仕様

**会話ログ（dsh のセッション JSONL）**: MiL（input）と応答（output）がそのまま残る。

**独自ログ（dsh の storage）**:

| 項目 | 内容 |
| --- | --- |
| 原文 | 変換対象のテキスト |
| MiL | 変換結果 |
| 逆翻訳 | 実行した場合のみ |
| 変換モデル | `sarashina3-mini` / `sarashina3-nano` |
| 呼び出し回数 | 429 再試行を含む |
| 承認有無 | 承認 / 却下 / 修正あり |
| メッセージ ID | `followup` に渡したメッセージの ID（セッションログとの結合キー） |
| 時刻 | 変換・承認・送信の各時刻 |

応答は保存しない（セッションログにあるため）。

---

## 9. 機密の扱い

ベータ期間中は許容、警告なし。根拠は無償ベータのデータ利用条件（品質向上・改善のため利用データを活用する場合がある）。

---

## 10. 失敗時の動作

| 事象 | 動作 |
| --- | --- |
| 429 | 10s → 20s → 40s で最大 3 回再試行。上限で中止し、ユーザーへ報告 |
| sarashina 障害 | 変換を行わない。「原文をそのまま送るか」を確認する。自動送信はしない。コンフィグで「常に中止」も選択可 |
| MiL の形式外れ | 承認画面を出さず、生の応答を全文表示して中止 |
| ダイアログの取り消し | 送信を中止する（未編集の MiL を送らない） |

---

## 11. 実装前の確認（決定済みの作業）

1. 復号の事前実測: 3〜5 件。原文を見せずに MiL から要件を復唱させ、原文の対象・範囲・条件・優先度と矛盾しない項目がそろうことを合格とする。不合格なら、送信直前のデコーダ注記 1 行を追加するか、ペイロード方針を再検討する。
2. `ctx.agents` 経路の 3 点: (a) セッションの Agent を一意に取れるか、(b) `followup` が前景ターンとして走り TUI が通常どおり描画するか、(c) ターン実行中にコマンドから呼んだ場合の挙動。
3. 接点の実在確認: dsh の storage、system prompt 段、設定セクションの各接点。

未取得・未検証の詳細は `qa-record.md` を参照。

**実測状況（2026-10-14）**

- 1 は実施済みで**合格**。実例の形を原典の本文（`goal:=…; usr:=…; amb→qmin{…}`）に直した時点で、変換も復号も通った。不合格だった実行 1〜5 の記録は `qa-record.md` §6。
- 定義行の扱いは `specPreamble`（`off` / `prepend`）として設定化し、両モードとも復号に成功したことを実測済み（§2 の「MiL のみ」は `off` が既定）。原典の例A は定義行を前置しており、`prepend` がそれに一致する。
- 変換器は Sarashina 固定とする。他のモデルへの差し替えは行わない（Adapter の交換点は、Sarashina 終了時の代替という元来の contingency に限る）。
- 2 の一部は実機で確認済み（コマンド登録・変換・承認ダイアログ・編集ダイアログ）。送信（`followup`）と storage への記録は未確認。
- 3 の一部は実機で確認済み（設定セクションの登録は名前空間の修正後に成功）。system prompt 段と storage は未確認。
- 実機で判明した制約: コマンド名とプラグイン所有の設定名前空間は `/^[a-z][a-z0-9_-]*$/` が必要（§4）。セッション v4 のメッセージ source は producer 所有 kind（`plugin:<名前>`）が必要（§1）。
