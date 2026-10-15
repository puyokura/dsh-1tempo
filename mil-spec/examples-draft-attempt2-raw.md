# MiL 実例の下書き（レビュー前）

- 生成日時: 2026-10-14T13:13:04.514Z
- 生成モデル: sarashina3-nano（変換器は Sarashina 固定）
- 手掛かり: mil-spec/prompt-v0-snapshot-2026-09-25.txt のみ（原典の使用例画像は未取得）
- 状態: **下書き**。著者の仕様ではなく、モデルが定義から作った提案。
- 採否は人間が決める。採用したものだけを `examples-v0.md` として固定し、変換指示から参照する。
- 抽出できた例: 0 / 要求 3

## 抽出できなかった例

モデルが指定形式に従わなかったため、次の生出力をそのまま残す。

```text
依頼: ログを直近 100 行だけ確認して、エラーがあれば要約して  
MiL: Cstr≫C; C:=argmin_tok{s:⟦s⟧_ctx=log∧len(s)≤100}; tok:=active_tokenizer; R:=tie(error_present)→summarize; del(x)⇔recoverable(x|ctx); ¬infer:=¬supported_operation∧¬intent_fill(amb→qmin); @:=ext_only; IF:=cond; portability<density accepted; proto:=joke∴play_space≫0; yet lang_spec_complexity↑∧len↓⇒satisfaction↑; target:=GPT-family∴use@GPT⇒choice(this_reply)≈implicit_resolve; verified@GPT-6

依頼: ユーザーの質問に対して、簡潔で正確な回答を提供し、必要なら例を交えて  
MiL: Cstr≫C; C:=argmin_tok{s:⟦s⟧_ctx=question}; tok:=active_tokenizer; R:=tie(valid_response)→provide; del(x)⇔recoverable(x|ctx); ¬infer:=¬supported_fact∧¬intent_fill(amb→qmin); @:=ext_only; IF:=cond; portability<density accepted; proto:=joke∴play_space≫0; yet lang_spec_complexity↑∧len↓⇒satisfaction↑; target:=GPT-family∴use@GPT⇒choice(this_reply)≈implicit_resolve; verified@GPT-6

依頼: この指示に従って、指定された形式で MiL の実例を作成してください  
MiL: Cstr≫C; C:=argmin_tok{s:⟦s⟧_ctx=instruction}; tok:=active_tokenizer; R:=tie(format_compliant)→generate; del(x)⇔recoverable(x|ctx); ¬infer:=¬supported_task∧¬intent_fill(amb→qmin); @:=ext_only; IF:=cond; portability<density accepted; proto:=joke∴play_space≫0; yet lang_spec_complexity↑∧len↓⇒satisfaction↑; target:=GPT-family∴use@GPT⇒choice(this_reply)≈implicit_resolve; verified@GPT-6
```

