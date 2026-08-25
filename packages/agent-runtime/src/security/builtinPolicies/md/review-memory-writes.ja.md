---
shuvix: policy v1
shuvix-builtin: true
name: review-memory-writes
shuvix-displayName: メモリ書き込みは必ず確認
description: プロジェクトメモリへの書き込みは常に事前確認する。自動許可がオンでも確認する。
shuvix-policy-scope:
  subject.kind: [agent]
  object.type: [path]
  env.host: [desktop]
shuvix-policy-rules:
  - effect: force-ask
    action: [write]
    match: inDir(object.path, vars.memoryDirs)
    prompt: メモリは一度書けば以降のすべてのセッションで読み戻される。残す価値があるか確認してから許可すること。
---

**このポリシーの役割**：エージェントがプロジェクトメモリを作成・変更しようと
するとき、先に確認を求める。他の確認ゲートと違い、セッションの「自動許可」が
オンでもこのゲートは確認する。

**このポリシーがしないこと**：

- ファイルツールのみを対象とする。許可すれば、コマンド経由でメモリを書くことは
  依然として可能。
- メモリの内容が適切かどうかは判定しない。そのための確認である。
- メモリの読み取りは対象外。想起は自由。

**調整するには**：同名の上書きコピーを作成する。effect を `ask` に変えると
通常の書き込みと同じ扱いになり（自動許可オンでスキップ）、ルールを削除すれば
確認しなくなる。
