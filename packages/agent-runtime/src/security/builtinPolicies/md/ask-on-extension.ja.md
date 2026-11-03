---
shuvix: policy v1
shuvix-id: policy:builtin:ask-on-extension
shuvix-builtin: true
name: ask-on-extension
shuvix-displayName: 拡張機能を有効にする前に確認
description: エージェントはこのセッションでオフの MCP サーバーを探せます。有効にするときはあなたに確認します。
shuvix-policy-scope:
  subject.kind: [agent]
  object.type: [extension]
  env.host: [desktop]
shuvix-policy-rules:
  - effect: ask
    action: [enable]
    prompt: このセッションでこの拡張機能を有効にします。エージェントはそのすべてのツールを使えるようになり、あなたが追加したサーバーならここでプロセスが起動することがあります。
---

**何をするか**：セッションでチェックされたサーバーのツールだけをエージェントは持っています。別の機能が必要なとき、
`tool_search` で、設定では有効だがこのセッションではオフのサーバーを探し、有効化を申請できます。申請のたびにあなたに
確認します。許可すると、そのサーバー全体がこのセッションでチェックされ、エージェントは次のステップからツールを呼べます。

**なぜ確認するか**：チェックは、エージェントとサーバーの機能のあいだにある唯一の関門であることが多いからです。たとえば
内蔵ブラウザーは確認なしで Web ページを開き、あなたのログイン状態を共有します。`database` も SQL を止めません。

**しないこと**：

- 自動レビューはこの確認に答えません：内蔵 hook `auto-review` はこれをあなたに任せるので、すべてのカードがあなたに届きます。
- 検索そのものは確認せず、サーバーも起動しません。
- このセッションですでにチェック済みのサーバーは確認しません。あなた自身がチェックする場合も同じです。
- ほかのセッションには影響しません。サブセッションは作成時に親の選択を、フォークはコピー元の選択を複製します。

**調整するには**：特定のサーバーだけ確認をやめるには、自分のポリシーを書きます。範囲は `subject.kind: [agent]` と
`object.type: [extension]`、ルールは `effect: force-allow`、`action: [enable]`、たとえば `match: object.server == 'browser'`
（普通の `allow` は `ask` に勝てません）。すべて確認をやめるには、このポリシーの
上書きコピーを作ってルールを外します。
