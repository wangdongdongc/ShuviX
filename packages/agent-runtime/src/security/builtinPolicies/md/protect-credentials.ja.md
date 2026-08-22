---
shuvix: policy v1
shuvix-builtin: true
name: protect-credentials
shuvix-displayName: 一部の資格情報ディレクトリを保護
description: 資格情報ディレクトリへの書き込みは不可；読み取りは事前確認が必要。
shuvix-policy-scope:
  subject.kind: [agent]
  object.type: [path]
  env.host: [desktop]
shuvix-policy-lets:
  credentialDirs: >-
    ['.ssh', '.aws', '.gnupg', '.config/gh', '.netrc',
    'AppData/Local/Microsoft/Credentials',
    'AppData/Roaming/Microsoft/Credentials'].map(s, vars.home + '/' + s)
shuvix-policy-rules:
  - effect: deny
    action: [write]
    match: inDir(object.path, credentialDirs)
    prompt: 書き込みは拒否された。資格情報ディレクトリ（~/.ssh、~/.aws、~/.gnupg、~/.config/gh、~/.netrc）はエージェントに対して閉じている。変更が必要ならユーザー自身に依頼すること。
  - effect: ask
    action: [read]
    match: inDir(object.path, credentialDirs)
    prompt: このパスには資格情報がある。ここから読んだ秘密鍵やトークンはモデルのコンテキストに入る。渡してしまうのと同じこと。
---

**このポリシーの役割**：資格情報の保存場所（`~/.ssh`、`~/.aws`、`~/.gnupg`、
`~/.config/gh`、`~/.netrc`）について：

- **書き込みは常に拒否** —— 自動許可がオンでも通らない。
- **読み取りは事前確認** —— 秘密鍵を読むことは実質的な流出であるため、自動許可を
  オンにしていない限り、エージェントはこれらのパスを読む前に確認する。

**カバーしないこと**：

- 対象は上記パスのみ。
- 制約するのはファイルツールのみ：あなたが許可すれば、エージェントはコマンドを
  実行して重要な資格情報ファイルを操作できる。
- 自動許可のスイッチをオンにすると、別の組み込みポリシー session-auto-allow が
  効いて確認はスキップされる。

**調整するには**：上書きコピーを作成して編集する —— 慎重に。
