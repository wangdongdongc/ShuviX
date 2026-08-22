---
shuvix: policy v1
shuvix-builtin: true
name: git-safety
shuvix-displayName: 重要な Git 操作の実行前に確認
description: 組み込み git ツールの重要な操作（init / restore / checkout --force / branch -d）は実行前に確認する。
shuvix-policy-scope:
  subject.kind: [agent]
  object.type: [gitTool]
shuvix-policy-rules:
  - effect: ask
    match: >-
      object.gitAction in ['init', 'restore']
      || (object.gitAction == 'checkout' && object.force)
      || (object.gitAction == 'branch' && object.delete)
    prompt: この種の git 操作は未コミットの変更を破棄するか、ブランチを削除する（init、restore、checkout --force、branch -d）。アプリ内に取り消しはない。
---

**このポリシーの役割**：対象は**組み込み git ツールのみ**。日常的な操作
（add、commit、diff……）はワークスペース内で自由に実行されるが、重要な操作は
先に確認される —— リポジトリ作成（`init`）、変更の破棄（`restore`、
`checkout --force`）、ブランチ削除（`branch -d`）。

**カバーしないこと**：

- コマンド経由で実行される `git` コマンドは**本ポリシーの対象外** —— あなたが
  許可すれば、エージェントはコマンドを実行して任意の git 操作を行える。
- ゲートされるのは上記の操作のみ；git ツールのその他の操作はワークスペース内で
  ダイアログなしに実行される。
- ワークスペース外のディレクトリを対象とする git ツール操作は、通常のパス確認も
  併せて通る。
- 自動許可のスイッチをオンにすると、別の組み込みポリシー session-auto-allow が
  効いて確認はスキップされる。

**調整するには**：上書きコピーを作成して編集する。
