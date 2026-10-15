# 依頼 → MiL の見本 v0（本プラグインが作成）

| 項目 | 内容 |
| --- | --- |
| 状態 | **原典の仕様ではない。** 本プラグインが作成したプロンプト教材（人間レビュー済み・採用 2026-10-14） |
| 形の根拠 | `mil-spec/reference-style.txt` の「原典の本文」（ユーザー分析による転記） |
| 原典との関係 | 原典には**依頼（命令）を符号化した実例が存在しない**（`author-examples.md` §5-3）。依頼の変換例は本プラグインが初めて作った |
| 保存先 | 機械可読な本体は `examples-v0.txt`。コメント行（`#`）はプロンプトから除去される |

## 採用した 5 対

```text
依頼: いい感じのログイン画面を作って。スマホでも見やすく
MiL: goal:=make(login_ui); usr:=mobile; f:=readable; amb→qmin{style?,stack?}

依頼: ログを直近 100 行だけ確認して、エラーがあれば要約して
MiL: goal:=check(log); scope:=last100; cond:=error_found→summarize

依頼: READMEを直して。日本語で、簡潔に
MiL: goal:=fix(README); lang:=JA; len:=short; amb→qmin{which_section?}

依頼: 3Dモデルを作って
MiL: goal:=make(3D_model); amb→qmin{obj?,fmt?}

依頼: この関数を速くして。あと読みやすく
MiL: goal:=opt(fn); metric:={spd↑,read↑}
```

## 前版を破棄した理由（実測に基づく）

前版（`examples-v0-attempt1-wrong-shape.txt`）は、モデルが定義から作った下書きを採用したもので、`C:=argmin_tok{…}; R:=tie(…)→…` という**定義の変数をそのまま使う形**だった。

実測（`preflight-report-run5.md`）で次が判明した。

- 変換出力は `C:=…`/`R:=…` の形になり、対象モデルの復号は毎回「C は…と推定」という**記法の解説**になった。依頼として読まれない。
- 原典の本文（`reference-style.txt`）は `problem:={key:value,…}` / `fix:=…∧…` の形で、`C`/`R` は現れない。**前版は原典と違う形を教えていた。**

## 不変条件（テストで固定）

- `examples-v0.txt` の各 `MiL:` 行は、定義と逐語一致する節を含まない（`tests/spec.test.mjs`）。
  - 初稿は `len↓` を含んでおり、定義の `lang_spec_complexity↑∧len↓⇒satisfaction↑` と逐語一致していたため `len:=short` に修正した。

## 未確認

- この形が著者の意図と一致するかは未確認。原典の使用例（画像）は当エージェント未読で、転記との突き合わせも未実施。
- 原典の実例は議論の分析・立場表明であり、**依頼の符号化**が同じ形で成立するかは実測でしか確かめられない。
