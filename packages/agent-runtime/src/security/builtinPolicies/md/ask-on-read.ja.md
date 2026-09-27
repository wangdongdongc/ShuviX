---
shuvix: policy v1
shuvix-builtin: true
name: ask-on-read
shuvix-displayName: ファイル読み取り前に確認
description: ワークスペースとアプリの読み取り専用ディレクトリの外にある読み取りは事前確認が必要。サンドボックスがオンのときは、制限付きコマンドも読めない機密の場所だけが確認対象。
shuvix-policy-scope:
  subject.kind: [agent]
  object.type: [path]
  env.host: [desktop]
shuvix-policy-rules:
  - effect: ask
    action: [read]
    match: >-
      has(vars.sandboxActive) && vars.sandboxActive
      ? inDir(object.path, vars.sandboxReadDenied)
      && !inDir(object.path, vars.sandboxReadAllowed)
      : !inDir(object.path, vars.workspace)
      && !inDir(object.path, vars.toolResultsBase)
      && !inDir(object.path, vars.skillsDirs)
      && !inDir(object.path, vars.memoryDirs)
      && !inDir(object.path, vars.builtinKnowledgeDir)
      && !inDir(object.path, vars.sessionArtifactsDir)
    prompt: このファイルを読むと、その内容はモデルのコンテキストに入り、以降の対話やツール呼び出しで外部へ渡る可能性がある。
---

**このポリシーの役割**は、このセッションのコマンドがサンドボックス内で動くかどうかで変わる。

- **サンドボックスがオン**：制限付きコマンドはほぼ何でも読めるので、ファイルツールも同じ
  にする —— `cat` なら無条件に読めるファイルを `read` でだけ確認させても、エージェントを
  `cat` へ押しやるだけだ。引き続き確認されるのは、サンドボックスがコマンドに対しても拒否
  する一つのリスト：ShuviX 自身のデータ（他の会話、データベース、認証情報の鍵）、個人
  フォルダ（書類、デスクトップ、ダウンロード、ピクチャ、ムービー、ミュージック、iCloud
  Drive、メール、メッセージ、Safari、他のアプリのコンテナ）、そして認証情報ディレクトリ。
  作業ディレクトリとこのセッション自身のツール結果は、それらのフォルダの中にあっても自由に
  読める。
- **サンドボックスがオフ**（またはここでは使えない）：エージェントは作業ディレクトリと、
  アプリの読み取り専用ディレクトリ —— ツール結果、skills、プロジェクトメモリ、ShuviX 自身の
  組み込みナレッジベース（あのリファレンスは参照されるために同梱されている）、この会話自身の
  成果物 —— の中を自由に読める。その範囲の外を読むときは先に確認される。

**カバーしないこと**：

- ゲートするのはファイルツールのみ。コマンドは ask-on-command とサンドボックスが扱う。
- 上のリスト以外について、本ポリシーはファイルの機密性を解析しない。
- 自動許可のスイッチをオンにすると、別の組み込みポリシー session-grants が
  効いて確認はスキップされる。

**調整するには**：上書きコピーを作成して編集する。`match` を `:` より後ろの部分だけに
すると、サンドボックスの有無にかかわらず「ワークスペースの外は確認」に戻る。
