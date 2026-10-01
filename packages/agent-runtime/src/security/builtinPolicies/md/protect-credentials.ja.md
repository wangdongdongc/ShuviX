---
shuvix: policy v1
shuvix-builtin: true
name: protect-credentials
shuvix-displayName: 一部の資格情報ディレクトリを保護
description: 資格情報ディレクトリの読み取りは事前確認が必要；サンドボックス内のコマンドは一切触れられない。
shuvix-policy-scope:
  subject.kind: [agent]
  object.type: [path]
  env.host: [desktop]
shuvix-policy-lets:
  credentialDirs: >-
    ['.ssh', '.aws', '.gnupg', '.config/gh', '.netrc', '.shuvix/.session-state',
    'AppData/Local/Microsoft/Credentials',
    'AppData/Roaming/Microsoft/Credentials'].map(s, vars.home + '/' + s)
shuvix-policy-rules:
  - effect: ask
    action: [read]
    match: inDir(object.path, credentialDirs)
    prompt: このパスには資格情報がある。ここから読んだ秘密鍵やトークンはモデルのコンテキストに入る。渡してしまうのと同じこと。
---

**このポリシーの役割**：資格情報の保存場所（`~/.ssh`、`~/.aws`、`~/.gnupg`、
`~/.config/gh`、`~/.netrc`、そして ShuviX が保存済みの API キーを暗号化する鍵
`~/.shuvix/.session-state`）について：

- **読み取りは事前確認** —— 秘密鍵を読むことは実質的な流出であるため、
  ファイルツールがこれらのパスを読む前に確認する。
- **サンドボックス内のコマンドは読み書きともできない。** コマンドサンドボックスの
  一覧はこのポリシーの `credentialDirs` から取るので、上書きコピーで一覧を変えれば
  コマンド側も変わる。

**カバーしないこと**：

- 対象は上記パスのみ。
- 書き込みは拒否しない：ここへの書き込みは普通の書き込みであり、作業ディレクトリの外への
  書き込みと同じく ask-on-write で確認される。
- サンドボックスの外で動くコマンド（サンドボックスがオフか使えない、または
  エージェントがフルアクセスを求めた）はパスごとには調べず、コマンド全体として
  ask-on-command で確認する。
- 必ずあなたに届くとは限らない：自動レビューがオンのときは、レビューする
  エージェントが先に答える —— 普段の作業は通し、明らかに有害なものは拒否し、
  残りは意見を添えてあなたに回す。

**調整するには**：上書きコピーを作成して編集する —— 慎重に。
