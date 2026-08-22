---
shuvix: policy v1
shuvix-builtin: true
name: ask-on-command
shuvix-displayName: コマンド実行前に確認
description: bash/ssh の全コマンドはコマンドごとにユーザー確認が必要。唯一の免除はセッション単位の自動許可。
shuvix-policy-scope:
  subject.kind: [agent]
  object.type: [command]
shuvix-policy-rules:
  - effect: ask
    action: [execute]
    prompt: 許可したコマンドはあなたのシステム権限で実行され、任意のファイルへのアクセスも通信もできる。実際に何をするか確かめてから許可すること。
---

**このポリシーの役割**：エージェントが実行しようとするコマンドは、すべて事前に
あなたへの確認が必要になる。

**カバーしないこと**：

- 確認がゲート：確認した瞬間、コマンドはあなたのシステム権限で実行される。
- 自動許可のスイッチをオンにすると、別の組み込みポリシー session-auto-allow が
  効いて確認はスキップされる。

**調整するには**：上書きコピーを作成して編集する。
