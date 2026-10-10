---
shuvix: policy v1
shuvix-id: policy:builtin:ask-on-external-path
shuvix-builtin: true
name: ask-on-external-path
shuvix-displayName: セッション外のファイルに触れる前に確認
description: ファイルツールはこのセッション自身のディレクトリでは自由に使える。ホームフォルダの他の場所を読むとき、それ以外の場所に書くときは先に確認する。
shuvix-policy-scope:
  subject.kind: [agent]
  object.type: [path]
  env.host: [desktop]
shuvix-policy-rules:
  - effect: ask
    action: [read]
    match: >-
      inDir(object.path, vars.home)
      && !inDir(object.path, vars.sessionDirs)
      && !inDir(object.path, vars.sessionReadDirs)
      && !inDir(object.path, vars.grantedRead)
      && !inDir(object.path, vars.grantedWrite)
    prompt: このファイルはこのセッションのディレクトリの外にある。読んだ内容はモデルのコンテキストに入り、以後の会話やツール呼び出しで外へ持ち出されうる。
  - effect: ask
    action: [write]
    match: >-
      !inDir(object.path, vars.sessionDirs)
      && !inDir(object.path, vars.grantedWrite)
    prompt: この書き込みはこのセッションのディレクトリの外になる。許可する前に対象パスと差分を確認すること。
---

**このポリシーの役割**：ファイルツール（read、write、edit、ls、grep、glob……）は、この
セッション自身のディレクトリの中では自由に使える：

- 作業ディレクトリ —— ただし `/`、ホームフォルダ全体を含むもの、ShuviX 自身の設定や
  アプリデータは除く；
- このセッションの一時フォルダ（そのコマンドの `$TMPDIR`）、artifacts
  （`~/.shuvix/artifacts/<セッション>/`）、ツール結果（長い出力とバックグラウンドタスクのログ）；
- このセッションでチェックしたナレッジベース —— ナレッジベースの変更はそれぞれ自身の git に
  コミットされるので、元に戻せる；
- 「許可して記憶」と答えたパス —— 書き込み許可は読み取りも含む。

スキルのフォルダ（組み込みのものと有効にしたもの）と組み込みの ShuviX マニュアルは
**読み取り専用**のセッションディレクトリ：読むのは確認なし、変更は確認する —— スキルは
エージェント自身が従う指示だから。

それ以外では、**ホームフォルダ内のファイルを読むときは確認し**、**どこへ書くときも確認する**。
ホームフォルダの外（システムの場所、`/opt/homebrew`、`/Applications`）を読むときは確認しない。

これはコマンドサンドボックスが引く線とまったく同じ：制限付きのコマンドが読み書きできるのは
同じセッションディレクトリだけで、ホームフォルダの外は読み取りのみ、それ以外はできない。両者は
同じ一覧（ホストがこのセッションの設定から計算する `vars.sessionDirs` と `vars.sessionReadDirs`。
誰かが保守する一覧ではない）を使うので、エージェントがファイルツールから
`cat` や `echo >` に切り替えても得はない。`~/.ssh` のような資格情報はホームフォルダの中に
あるので、専用の一覧は要らない。

**カバーしないこと**：

- コマンドは ask-on-command とサンドボックスが扱う。サンドボックスがない場合（Windows、Linux、
  またはサンドボックスがオフ）も、ファイルツールには同じ線が適用され、コマンドは毎回確認する。
- 必ずあなたに届くとは限らない：自動レビューがオンのときは、レビューする
  エージェントが先に答える —— 普段の作業は通し、明らかに有害なものは拒否し、
  残りは意見を添えてあなたに回す。
- 「許可して記憶」はこのセッションの間だけ有効。記憶したパスはセッション設定パネルに
  一覧され、一つずつ削除できる。

**調整するには**：上書きコピーを作成して編集する。読み取りのルールを消すと、ファイルツールは
どこを読んでも確認しなくなる（サンドボックスは引き続き制限付きのコマンドをホームフォルダの
外に留める）。
