---
shuvix: policy v1
shuvix-builtin: true
name: protect-builtin-knowledge
shuvix-displayName: ShuviX 組み込みナレッジベースを読み取り専用に保つ
description: エージェントは ShuviX がアプリに同梱するナレッジベースへ書き込めません。
shuvix-policy-scope:
  subject.kind: [agent]
  object.type: [path]
  env.host: [desktop]
shuvix-policy-rules:
  - effect: deny
    action: [write]
    match: inDir(object.path, [vars.builtinKnowledgeDir])
    prompt: >-
      書き込みを拒否しました。このファイルは ShuviX の組み込みナレッジベース ——
      アプリに同梱され、更新のたびに丸ごと差し替えられるリファレンスです。学んだことは
      ユーザー自身のナレッジベースに記録してください（knowledge ツールの "bases" が一覧します）。
---

**何をするか**：ShuviX の組み込みナレッジベース配下へのファイル書き込みをすべて拒否します ——
自動許可がオンでも変わりません。

**なぜか**：そのベースは ShuviX 自身のリファレンス（agent / bot / policy / hook ファイル、
ナレッジエントリ、skill の書き方）です。アプリバンドルの中にあり、更新のたびに丸ごと差し替わる
ので、そこに書いたものは次のリリースで消えます —— さらに macOS では、改変されたアプリバンドルは
署名と一致せず起動を拒否されることがあります。`knowledge` ツールはすでにそこでの `create` を拒み、
ベースを読み取り専用と表示しています。このポリシーは残る経路 —— ツールが印字した絶対パスへの
直接の `write` / `edit` —— を塞ぎます。

**何をしないか**：

- 拒むのはエージェントのファイルツールによる書き込みだけです。あなたが許可したコマンドは
  あなたのシステム権限そのままで実行され、ここでは制限されません。
- 読み取りは拒みません —— 読むことがこのベースの用途です。
- `~/.shuvix/knowledge/` 配下のあなた自身のナレッジベースは対象外です —— それらは ask-on-write を
  参照してください。
