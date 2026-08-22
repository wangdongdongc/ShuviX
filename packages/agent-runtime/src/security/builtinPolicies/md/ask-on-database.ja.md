---
shuvix: policy v1
shuvix-builtin: true
name: ask-on-database
shuvix-displayName: データベース SQL 実行前に確認
description: 書き込み権限を持つデータベース接続で実行される SQL は、一つずつ確認が必要。
shuvix-policy-scope:
  subject.kind: [agent]
  object.type: [database]
shuvix-policy-rules:
  - effect: ask
    action: [execute]
    match: '!object.readonly'
    prompt: この接続は書き込み権限を持つため、この SQL はサーバー上のデータを変更・削除しうる。
---

**このポリシーの役割**：書き込み権限を持つデータベース接続でエージェントが SQL を
実行するとき、一つずつあなたに確認する。

**カバーしないこと**：

- 読み取り専用接続はゲートしない：データベース自身が書き込みを拒否する。
- 読み取りと書き込みを判別しない：本ポリシーは SQL の解析を行わない。
- 自動許可のスイッチをオンにすると、別の組み込みポリシー session-auto-allow が
  効いて確認はスキップされる。

**調整するには**：上書きコピーを作成して編集する。
