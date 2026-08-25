---
shuvix: policy v1
shuvix-builtin: true
name: ask-on-read
shuvix-displayName: ファイル読み取り前に確認
description: ワークスペースとアプリの読み取り専用ディレクトリの外にある読み取りは事前確認が必要。範囲内は自由。
shuvix-policy-scope:
  subject.kind: [agent]
  object.type: [path]
  env.host: [desktop]
shuvix-policy-rules:
  - effect: ask
    action: [read]
    match: >-
      !inDir(object.path, vars.workspace)
      && !inDir(object.path, vars.toolResultsBase)
      && !inDir(object.path, vars.skillsDirs)
      && !inDir(object.path, vars.memoryDirs)
    prompt: 作業ディレクトリ外のファイルを読むと、その内容はモデルのコンテキストに入り、以降の対話やツール呼び出しで外部へ渡る可能性がある。
---

**このポリシーの役割**：エージェントは作業ディレクトリ（およびアプリの読み取り
専用ディレクトリ：ツール結果、skills、プロジェクトメモリ）内を自由に読める。その範囲の外にあるもの
—— 他の場所、他のプロジェクトのファイル —— を読むときは先に確認される。

**カバーしないこと**：

- ゲートするのはファイルツールのみ：あなたが許可すれば、エージェントはコマンドを
  実行してファイルを読むこともできる。
- 本ポリシーはファイルの機密性を解析しない。
- 自動許可のスイッチをオンにすると、別の組み込みポリシー session-auto-allow が
  効いて確認はスキップされる。

**調整するには**：上書きコピーを作成して編集する。
