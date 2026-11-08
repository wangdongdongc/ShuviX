---
shuvix: policy v1
shuvix-id: policy:builtin:ask-on-settings
shuvix-builtin: true
name: ask-on-settings
shuvix-displayName: エージェントが設定を変える前に確認
description: エージェントは自分に開放された ShuviX の設定を見られます。変更するときは先に確認します。
shuvix-policy-scope:
  subject.kind: [agent]
  object.type: [channel]
  env.host: [desktop]
shuvix-policy-rules:
  - effect: ask
    action: [invoke]
    match: "object.access != 'read'"
    prompt: エージェントが ShuviX の設定を変更しようとしています。変わる内容はカードに一覧があります。カードに入力した値はそのまま設定に保存され、エージェントには見えません。
---

**何をするか**：エージェントは `shuvix` ツールで、ShuviX 自体の設定を代わりに扱えます。設定画面が使うのと
同じ設定 API を通ります。たとえば貼り付けた MCP の設定を、設定内のサーバーとして追加できます。届くのは
ShuviX がエージェントに開放した設定だけで、ツールの `describe` が一覧を出します。見るだけなら承認は要りません。
変更するときは毎回先に確認し、何が変わるかをカードに一行ずつ示します。エージェントが空のままにした秘密の値
（API キー、トークン）は、カード上の伏せ字の入力欄になります。そこに入力した値はそのまま設定に保存され、
会話にもモデルにも渡りません。

**誰が答えるか**：呼び出しごとに、リモートクライアントの呼び出しと同じ事実が付きます：`object.channel`
（たとえば `mcp:add`）、`object.scope`（ShuviX のどの部分か、たとえば `extensions`）、`object.access`。
- `admin` の変更は ShuviX 自体の構成（MCP サーバーなど）を変えるもので、**あなただけが答えます**。
  組み込みの hook `auto-review` はこれをあなたに任せます。
- `write` の変更は自動レビューが代わりに答えられます。

**しないこと**：

- リモートクライアントには適用されません。その呼び出しは `subject.kind: network` で、ネットワークアクセスの
  ポリシーに従います。
- 追加した MCP サーバーをセッションで有効にするのは別の確認で、`ask-on-extension` が尋ねます。

**調整するには**：ある部分だけ確認をやめるには、範囲が `subject.kind: [agent]` と `object.type: [channel]` の
ポリシーを自分で書き、ルールに `effect: force-allow`、`action: [invoke]`、たとえば
`match: object.scope == 'extensions'` を指定します（通常の `allow` は `ask` に勝ちません）。エージェントが空の
ままにした値は、値だけを入力するカードで引き続き尋ねます。
