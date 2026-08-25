---
shuvix: policy v1
shuvix-builtin: true
name: session-auto-allow
shuvix-displayName: セッション自動許可スイッチの適用
description: セッションの自動許可スイッチが入っている間、すべての確認をスキップする。
shuvix-policy-scope:
  subject.kind: [agent]
shuvix-policy-rules:
  - effect: force-allow
    match: vars.autoAllow
    prompt: セッションの自動許可スイッチがオンのため、確認ゲートはスキップされる。
---

**このポリシーの役割**：セッション設定パネルの「自動許可」スイッチそのもの。オンの
間は、ファイルの読み書き・コマンド・git・データベースといったすべての確認ゲートが
スキップされ、操作は即座に実行される。

**カバーしないこと**：

- deny には勝てない。資格情報の保護とシステム保護は、自動許可の有無にかかわらず
  遮断し続ける。
- `force-ask` ルールはスキップしない。この effect は「このゲートはセッション単位の
  同意を受け付けない」という意味であり、スイッチがオンでも確認は出る。
- セッション単位であり、新しいセッションには引き継がれない。

**調整するには**：スイッチの意味はこのポリシーが与えている。上書きすれば範囲を狭め
られる —— 例えばオンでも書き込みだけは確認する：

    shuvix-policy-scope:
      subject.kind: [agent]
    shuvix-policy-rules:
      - effect: force-allow
        action: [read, execute]
        match: vars.autoAllow

`subject.kind` はすべてのルールで必須（ここでは scope に一度だけ宣言）。省略しないこと
—— 不正な上書きファイルは丸ごとスキップされ、しかも組み込みを**遮蔽しない**ため、
「狭めるつもりが解析に失敗した」上書きは、狭められていない元のスイッチをそのまま残す。
「不正なユーザーファイルは組み込みを遮蔽しない」という安全側の規則が、唯一あなたの意図に
逆らう方向がこれ。編集後はポリシー画面を確認すること：有効なのが自分の版でなければ、
解析に失敗している。
