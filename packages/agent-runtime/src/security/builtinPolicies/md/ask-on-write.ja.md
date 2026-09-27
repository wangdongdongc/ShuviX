---
shuvix: policy v1
shuvix-builtin: true
name: ask-on-write
shuvix-displayName: ファイル書き込み前に確認
description: ファイルの書き込み・編集は事前にユーザーの確認を求める —— この会話自身の成果物と、サンドボックスがオンのときは制限付きコマンドがもともと変更できる場所を除く。
shuvix-policy-scope:
  subject.kind: [agent]
  object.type: [path]
  env.host: [desktop]
shuvix-policy-rules:
  - effect: ask
    action: [write]
    match: >-
      !inDir(object.path, vars.sessionArtifactsDir)
      && !(inDir(object.path, vars.sandboxWritableRoots)
      && !inDir(object.path, vars.sandboxWriteDenied)
      && !vars.sandboxProtectedPatterns.exists(p, object.path.matches(p)))
    prompt: 書き込みはディスク上の内容をそのまま置き換える。許可する前に対象パスと差分を確認すること。
---

**このポリシーの役割**：エージェントがファイルを書き込み・編集しようとするとき、先に
あなたに確認される —— 例外は二つ。

- **この会話自身の成果物**（`~/.shuvix/artifacts/<セッション>/`）：エージェントが修正の
  ために adopt した図やブロックだ。会話が持つファイルで、あなたのプロジェクトの外にある。
  一分前に描いた図の手直しまで毎回確認させても、許可を押す癖がつくだけだ。
- **サンドボックスがオンのとき**、制限付きコマンドがもともと変更できる場所：作業
  ディレクトリ、一時フォルダ、ツールのキャッシュ。サンドボックス内の `bash` はすでに確認
  なしでそこへ書けるので、同じファイルをファイルツールで書くときだけ確認させても、
  エージェントを `echo > file` へ押しやるだけだ。その中の保護された場所は、サンドボックスが
  コマンドに対して拒否するのと同じく、引き続き確認される：`.git/hooks`、`.git/config` など
  git が自分で実行するメタデータと、プロジェクトの `.vscode`、`.idea`、`.claude`、`.cursor`、
  `.codex`、`.zed`、`.mcp.json`、`.envrc`。

ホストが `vars.sandboxWritableRoots` を埋めるのは、コマンドが実際に制限付きで動く
セッションだけだ。サンドボックスがオフ、サンドボックスのないプラットフォーム、または
作業ディレクトリが ShuviX 自身のデータの中にあるときは空になり、成果物以外への書き込みは
これまでどおりすべて確認される。

**カバーしないこと**：

- ゲートするのはファイルツールのみ。コマンドは ask-on-command とサンドボックスが扱う。
- 自動許可のスイッチをオンにすると、別の組み込みポリシー session-grants が
  効いて確認はスキップされる。

**調整するには**：上書きコピーを作成して編集する。`match` を一行目だけにすると、
サンドボックスの有無にかかわらず「すべての書き込みで確認」に戻る。
