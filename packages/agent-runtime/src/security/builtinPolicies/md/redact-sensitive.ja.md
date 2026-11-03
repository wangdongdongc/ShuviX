---
shuvix: policy v1
shuvix-id: policy:builtin:redact-sensitive
shuvix-builtin: true
name: redact-sensitive
shuvix-displayName: モデルに送る機密情報をプレースホルダーに置き換える
description: 新しいツールの結果と、トリガーやフックが送るメッセージの中のシークレットと個人情報は、プレースホルダーとして保存され、モデルに送られます。ツールとそれが書くファイルは本物の値のままです。新しく生まれる内容にだけ適用され、会話にすでにある内容には触れません。
shuvix-policy-scope:
  subject.kind: [agent]
  env.host: [desktop]
shuvix-policy-rules:
  - effect: allow
    action: [send]
    object.type: [modelRequest]
    disposition: detect
    prompt: モデル向けの新しい内容はマスキングの対象です。
  - effect: allow
    action: [disclose]
    object.type: [sensitive]
    match: "!(object.category in ['USERNAME', 'HOSTNAME', 'IP', 'BUCKET'])"
    disposition: redact
    prompt: シークレットと個人情報はプレースホルダーとして保存され、モデルに送られます。
---

**働き**：ツールの結果や、ボットのトリガー、フックが送るメッセージを会話に書き込む前に、ShuviX はその中の
シークレットと個人情報（API キー、トークン、秘密鍵、パスワード、メールアドレス、電話番号、身分証番号、カード番号など）を
見つけ、`{{REDACTED_API_KEY_k3v7x2mq}}` のようなプレースホルダーとして保存します。本物の値は暗号化され、その会話自身の
対応表に保存されます。ツールを実行するときは引数のプレースホルダーが本物の値に戻るので、コマンドは普通に動き、ファイルには
本物の内容が書かれます。会話に保存されたものがそのままモデルに届きます：リクエストを送るときに内容を書き換えることはありません。

**新しい内容だけが対象**：このポリシーは、これから新しく生まれる会話の内容だけに適用され、そのとき会話が使っているモデルに
ついて判定します。**会話の履歴には触れません**：会話の記録にすでにある機密情報はそのまま残り、そのまま送られ続けます。
以前のプレースホルダーもプレースホルダーのままです。ここをどう変えても、どのモデルに切り替えても同じです。すでに送った
内容をなくしたいときは、新しいセッションを始めてください。

- **ルール 1**（`modelRequest`、`send`）：どのモデル向けの新しい内容もマスキングする（`detect`）；
- **ルール 2**（`sensitive`、`disclose`）：見つかった値はプレースホルダーとして保存する（`redact`）。ただし
  ホームフォルダーのユーザー名（`USERNAME`）、`user@host`（`HOSTNAME`）、パブリック IP（`IP`）、
  クラウドのバケット（`BUCKET`）の四種類は、ほぼすべてのコーディングのリクエストに含まれ、モデルが正確に書き写す必要が
  あるため、書かれたとおりに保存して送ります。

調べないもの：入力欄に打った内容（+ → 機密情報を追加 で自分で隠してください）、ほかのセッションから届くメッセージ、
エージェント自身の返信、指示ファイルとシステムプロンプト。

**オブジェクト**：`object.provider` は設定に表示されるプロバイダー名、`object.model` はモデル id。見つかった
値には `object.category`（上の種類）、`object.rule`（検出ルール）、`object.value`（値そのもの）があります。

**調整**——このポリシーを書き換えず、自分のポリシーを書いてください：

- あるモデルをマスキングしない（そのモデル向けの新しい内容は書かれたとおり保存し、検出もしない）：`action: [send]`、
  `object.type: [modelRequest]` に `force-allow`、`match: "object.provider == 'home-server'"`；
- ある種類はそのまま送る：`action: [disclose]`、`object.type: [sensitive]` に `force-allow`、
  `match: "object.category == 'EMAIL'"`；
- テスト用のキーはそのまま送る：同じく `match: "object.value.startsWith('sk-test-')"`；
- ある種類はほかの規則が通してもプレースホルダーにする：`deny`、`match: "object.category == 'PRIVATE_KEY'"`；
- 復元されたシークレットを使うコマンドがサンドボックスの外で動くときは自分だけが答える（`ask-on-command` は
  もともと確認する。`force-ask` なら自動レビューが答えない）：`object.type: [command]` に `force-ask`、
  `match: "size(tool.restored) > 0 && !object.sandboxed"`。

`disposition` のない `force-allow` はこのポリシーの `allow` より優先されるので、一致したものはマスキング
されなくなります。このポリシーを無効にすると自動マスキングは止まり、新しい内容は本物の値のまま保存され、送られます。
会話にすでにあるプレースホルダーは残り、ツールはそれを復元できます。
