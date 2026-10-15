# 原典の使用例（ユーザー分析による転記）

| 項目 | 内容 |
| --- | --- |
| 出所 | 原典の定義本体に画像添付された使用例、および投稿群の短い実例 |
| 取得方法 | **ユーザーが別途行った分析による転記**（2026-10-14） |
| 検証状態 | 当エージェントは画像を入力できないため、**内容を独立検証していない**。原典画像そのものが正 |
| 位置づけ | 仕様の正本は投稿本文（`v0-snapshot-2026-09-25.md`）。本ファイルは**使用実態の記録**であり、記法の規則を追加するものではない |

原典の投稿本文（定義）と、この使用実例は別物である。定義は「書き方の規則」、本ファイルは「実際にどう書かれていたか」。

---

## 1. 追加探索の結果（ユーザー分析）

- 著者の MiL 風の投稿は **2026-09-24〜25 の 12 件＋画像内の使用例がすべて**。
- 2026-09-26 以降（〜10-14）に MiL らしい超圧縮記法の投稿は確認されなかった。

→ **本物の追加例はこれ以上存在しない。** 以降の実例が要るなら合成するしかない（§4）。

## 2. 画像内の使用例（転記）

### 例A（rply / 返信分析）

```text
rply MiL;C(m):=argmin_tok{s:⟦s⟧=m};R:=sym>logic>abbr>alias>>>EN;del(recoverable);IF:=cond;@:=ext;¬infer;amb→qmin

AI new_task→insight;usual:insight→AI

crap_summary→{SKILLs,docs/};info_loss≫0→waste?;alt:=keep(raw)∧summarize@use;result:=¬RL∧bench↑;LocalLLM+RL→perf↑↑;WebShop≈2×;prior continual_learning≈("current method→gain≈0;thus Δweights!");yet method_space→many improvable;ctx:=X post∧quote(research_announcement);?problem
```

**読み取れる書き方**: 冒頭に `rply MiL;` と定義行を**宣言として置き**、その後に本文（符号化した内容）を書く。本文は「話題の語＋演算子」の列で、定義の `C`/`R` をそのまま使ってはいない。

### 例B（problem / 問題点指摘）

```text
problem:={tone:"AI crap_summary"→needless_attack,
causal:keep(raw)→bench↑?∵other_method_changes,
metric:"bench↑"/"perf↑↑"/"≈2×"→baseline∧metric∧setting missing,
scope:WebShop→general continual_learning?=overgeneralize,
strawman:prior_continual_learning≈"gain≈0→Δweights!"→false_simplify,
term:¬RL→what_training? unclear,
claim:"method_space→many improvable"→evidence? weak,
quote_ctx:research_announcement→reader may misread your inference as paper_claim};
fix:=separate{paper_claim,your_interpretation}∧quantify{benchmark,baseline,method}∧soften{prior_work,tone}
```

### 例C（stance / スタンス表明）

```text
stance:={mockery↓:agree,assertiveness↓:reject:X_post_quality↓(empirical)};

q:=WebShop_desc such that {scope=WebShop_task,¬generalize→continual_learning,claim_strength=high};

need:=better_wording
```

**例B・例C の形**: `<ラベル>:={key:value, …}` の集合、または `<目的>:=<操作>{…}∧<操作>{…}`。話題に即したラベル（`problem` `fix` `stance` `q` `need` `metric` `scope` `causal`）を使う。定義の `C` `R` `del` `¬infer` は本文には現れない。

## 3. その他の短い実例（転記）

```text
Σspec⊂P₋₁;AI←P₋₁⇒learn! welcome:=spk{MiL,JP}
```

```text
MiL:mastery✓✓!;txt=◎!
```

```text
cstr≫C≫R; C:=argmin_tok{s:⟦s⟧_ctx=m}; ... verified@GPT-6 Sol.
```

```text
agree↑; ... MiL≈UL_extreme? ... proto:=test(max_compress | shared_ctx↑).
```

```text
😂; 🇯🇵:{1glyph→m↑∧tok↓}; ⊕{∑,↔,≔,⚡,🧠}⇒MiL++; ∴ native_buff≈✓? 🚀
```

```text
actual:self already has SKILL{JP→MiL}!; reverse:=∅ ∵ readability(MiL)>readability(JP)
```

**共通する書き方**: `:=` `{}` `∧` `→` `↑↓` `∴` `∵` `≈` `⇒` `≫` `↓` などの記号、ラベル＋値、日本語と英語の混在、絵文字も使う。

## 4. 合成例（本物ではない）

ユーザー分析が、実例が枯渇したため仕様書から作った参考例。**原典の使用例ではない。**

```text
model:={GPT-6.1 Sol, LFM2.5}; tok/s:local≈60 → Sol_max≈97 (theo=105); ∴ opt↑≫human_tune; era:=good
```

```text
goal:=trial_scale↑; bottleneck:=unknown_unknown; fix:=term_collect→AI_deepdive; shape:=thumbtack (broad_shallow + deep_specialty)
```

```text
claim:X→Y; evidence:=weak; scope_over:=generalize?; alt:=keep_raw∧measure_baseline; fix:=quantify∧soften_tone
```

```text
agree↑; mechanism_real≈yes; core≠brevity; :=constrain(expr)→constrain(thought); compress_until_ambiguity_breaks
```

## 5. 本プラグインへの含意（未確定の論点）

1. **形の食い違い**: 本プラグインが採用した実例（`examples-v0.md`）は `C:=argmin_tok{…}; R:=tie(…)→…` の形で、これは定義の変数をそのまま使う書き方。原典の本文（例B・例C）は `<ラベル>:={key:value,…}` の形。**採用した実例の形は原典の本文と一致していない。**
2. **定義行の扱い**: 例A では著者自身が `MiL;` と定義行を本文の前に置いている。つまり「定義行を付ける」ことは原典の運用に存在する。本プラグインは `stripSpecClauses` で定義と逐語一致する節を除去している（architecture.md §3 の送信ペイロードは「MiL のみ」）。**この 2 つは再検討の余地がある。**
3. **依頼の符号化**: 原典の実例は「議論の分析・立場表明」であり、**依頼（命令）を符号化した実例は存在しない**。本プラグインの用途（依頼の変換）に対応する原典の実例は無い。
