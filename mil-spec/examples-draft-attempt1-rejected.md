# MiL 実例の下書き（レビュー前）

- 生成日時: 2026-10-14T13:12:17.062Z
- 生成モデル: sarashina3-nano（変換器は Sarashina 固定）
- 手掛かり: mil-spec/prompt-v0-snapshot-2026-09-25.txt のみ（原典の使用例画像は未取得）
- 状態: **下書き**。著者の仕様ではなく、モデルが定義から作った提案。
- 採否は人間が決める。採用したものだけを `examples-v0.md` として固定し、変換指示から参照する。
- 抽出できた例: 3 / 要求 3

### 例 1

依頼: 文章の修正

MiL: cond(lang_spec_complexity↑∧len↓⇒satisfaction↑, this_reply)≈implicit_resolve

### 例 2

依頼: ファイル操作

MiL: argmin_tok{s:⟦s⟧=m}→active_tokenizer

### 例 3

依頼: 設定変更

MiL: ¬unsupported_fact∧¬intent_fill(amb→qmin)⇒ext_only

