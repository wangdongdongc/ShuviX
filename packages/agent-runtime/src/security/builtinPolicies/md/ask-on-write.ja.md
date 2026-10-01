---
shuvix: policy v1
shuvix-builtin: true
name: ask-on-write
shuvix-displayName: ファイル書き込み前に確認
description: ファイルの書き込み・編集は事前にユーザーの確認を求める —— この会話自身の成果物と作業ディレクトリ、サンドボックスがオンのときは制限付きコマンドがもともと変更できるその他の場所を除く。
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
      && !(inDir(object.path, vars.workspaceWritable)
      && !inDir(object.path, vars.workspaceWriteDenied)
      && !vars.workspaceProtectedPatterns.exists(p, object.path.matches(p)))
    prompt: 書き込みはディスク上の内容をそのまま置き換える。許可する前に対象パスと差分を確認すること。
---

**このポリシーの役割**：エージェントがファイルを書き込み・編集しようとするとき、先に
あなたに確認される —— 例外は三つ。自動審査がオンなら、まずレビュアーが答えるので、残りの
多くはあなたまで届かない。

- **この会話自身の成果物**（`~/.shuvix/artifacts/<セッション>/`）：エージェントが修正の
  ために adopt した図やブロックだ。会話が持つファイルで、あなたのプロジェクトの外にある。
  一分前に描いた図の手直しまで毎回確認させても、許可を押す癖がつくだけだ。
- **サンドボックスがオンのとき**、制限付きコマンドがもともと変更できる場所：作業
  ディレクトリ、一時フォルダ、ツールのキャッシュ。サンドボックス内の `bash` はすでに確認
  なしでそこへ書けるので、同じファイルをファイルツールで書くときだけ確認させても、
  エージェントを `echo > file` へ押しやるだけだ。その中で唯一保護された場所は、サンドボックスが
  コマンドに対して拒否するのと同じく、引き続き確認される：git 自身のメタデータ ——
  `.git/hooks`、`.git/config` など git が自分で実行するもの。

- **作業ディレクトリ（サンドボックスの有無を問わない）**（`vars.workspaceWritable`）：
  プロジェクトのファイルを直すのが仕事の中心で、ファイルツールは正確なパスを知っている
  ので、コマンドが制限なしで動く環境でも確認しない。上の保護された場所は引き続き確認
  される。サンドボックスも拒否する作業ディレクトリには適用しない —— `/`、ホームフォルダを
  覆うディレクトリ、認証情報のディレクトリ、ShuviX 自身の設定やデータ —— Windows でも
  適用しない。そこでは保護された場所のパターンを確実に照合できない。

ホストが `vars.sandboxWritableRoots` を埋めるのは、コマンドが実際に制限付きで動く
セッションだけだ。作業ディレクトリの例外はそれに依存しない。

**カバーしないこと**：

- ゲートするのはファイルツールのみ。コマンドは ask-on-command とサンドボックスが扱う。

**調整するには**：上書きコピーを作成して編集する。`match` を一行目だけにすると、
サンドボックスの有無にかかわらず「すべての書き込みで確認」に戻る。最後の節（`vars.workspace*`
の行）を外すと、「サンドボックスがオフのときは作業ディレクトリも確認」に戻る。
