---
shuvix: policy v1
shuvix-builtin: true
name: ask-on-write
shuvix-displayName: ファイル書き込み前に確認
description: どこへのファイル書き込み・編集も、事前にユーザーの確認を求める —— この会話自身の成果物（artifact）を除く。
shuvix-policy-scope:
  subject.kind: [agent]
  object.type: [path]
  env.host: [desktop]
shuvix-policy-rules:
  - effect: ask
    action: [write]
    match: '!inDir(object.path, vars.sessionArtifactsDir)'
    prompt: 書き込みはディスク上の内容をそのまま置き換える。許可する前に対象パスと差分を確認すること。
---

**このポリシーの役割**：エージェントがファイルを書き込み・編集しようとするとき
—— 作業ディレクトリの内外を問わず —— 先にあなたに確認される。

唯一確認しないのは、この会話自身の成果物（`~/.shuvix/artifacts/<セッション>/`）：
エージェントが修正のために adopt した図やブロックだ。会話が持つファイルで、あなたの
プロジェクトの外にある。一分前に描いた図の手直しまで毎回確認させても、許可を
押す癖がつくだけだ。

**カバーしないこと**：

- ゲートするのはファイルツールのみ；あなたが許可すれば、エージェントはコマンドを
  実行してファイルを書くこともできる。
- 自動許可のスイッチをオンにすると、別の組み込みポリシー session-grants が
  効いて確認はスキップされる。

**調整するには**：上書きコピーを作成して編集する。
