---
shuvix: policy v1
shuvix-id: policy:builtin:redact-sensitive
shuvix-builtin: true
name: redact-sensitive
shuvix-displayName: モデルに送る機密情報をプレースホルダーに置き換える
description: シークレットと個人情報はプレースホルダーとしてモデルに送られます。エージェントのツール、それが書くファイル、画面に表示される内容は本物の値のままです。
shuvix-policy-scope:
  subject.kind: [agent]
  env.host: [desktop]
shuvix-policy-rules:
  - effect: allow
    action: [send]
    object.type: [modelRequest]
    disposition: detect
    prompt: モデルへのリクエストはすべてマスキングの対象です。
  - effect: allow
    action: [disclose]
    object.type: [sensitive]
    match: "!(object.category in ['USERNAME', 'HOSTNAME', 'IP', 'BUCKET'])"
    disposition: redact
    prompt: シークレットと個人情報はプレースホルダーとしてモデルに送られます。
---

**働き**：会話の記録に書き込む前に、ShuviX はその中のシークレットと個人情報（API キー、トークン、
秘密鍵、パスワード、メールアドレス、電話番号、身分証番号、カード番号など）を見つけ、
`{{API_KEY_k3v7x2mq}}` のようなプレースホルダーとして保存します。本物の値は暗号化され、その会話自身の
対応表に保存されます。ツールを実行するときは引数のプレースホルダーが本物の値に戻るので、コマンドは
普通に動き、ファイルには本物の内容が書かれます。画面ではその場所に印が表示されます。モデルに何が届くかは
このポリシーで決まります：

- **ルール 1**（`modelRequest`、`send`）：モデルへのリクエストはすべてマスキングの対象（`detect`）。会話の
  記録の外にある内容（指示ファイル、システムプロンプト）もここでもう一度調べます；
- **ルール 2**（`sensitive`、`disclose`）：見つかった値はプレースホルダーのまま（`redact`）。ただし
  ホームフォルダーのユーザー名（`USERNAME`）、`user@host`（`HOSTNAME`）、パブリック IP（`IP`）、
  クラウドのバケット（`BUCKET`）の四種類は、ほぼすべてのコーディングのリクエストに含まれ、モデルが
  正確に書き写す必要があるため、そのまま送ります。

**オブジェクト**：`object.provider` は設定に表示されるプロバイダー名、`object.model` はモデル id。見つかった
値には `object.category`（上の種類）、`object.rule`（検出ルール）、`object.value`（値そのもの）があります。

**調整**——このポリシーを書き換えず、自分のポリシーを書いてください：

- あるモデルを信頼する（本物の値を受け取り、検出もしない）：`action: [send]`、`object.type: [modelRequest]`
  に `force-allow`、`match: "object.provider == 'home-server'"`；
- ある種類はそのまま送る：`action: [disclose]`、`object.type: [sensitive]` に `force-allow`、
  `match: "object.category == 'EMAIL'"`；
- テスト用のキーはそのまま送る：同じく `match: "object.value.startsWith('sk-test-')"`；
- ある種類は決して送らない（リクエスト全体を送らない）：`deny`、`match: "object.category == 'PRIVATE_KEY'"`；
- 復元されたシークレットを使うコマンドがサンドボックスの外で動くときは自分だけが答える（`ask-on-command` は
  もともと確認する。`force-ask` なら自動レビューが答えない）：`object.type: [command]` に `force-ask`、
  `match: "size(tool.restored) > 0 && !object.sandboxed"`。

`disposition` のない `force-allow` はこのポリシーの `allow` より優先されるので、一致したものはマスキング
されなくなります。このポリシーを無効にすると、すべてのモデルに本物の値が送られます。会話の記録には
引き続きプレースホルダーが保存されます。
