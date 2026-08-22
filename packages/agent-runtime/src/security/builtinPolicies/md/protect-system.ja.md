---
shuvix: policy v1
shuvix-builtin: true
name: protect-system
shuvix-displayName: 一部のシステムディレクトリを保護
description: エージェントは OS の場所へ決して書き込めない。
shuvix-policy-scope:
  subject.kind: [agent]
  object.type: [path]
  env.host: [desktop]
shuvix-policy-lets:
  systemDirs: >-
    ['/etc', '/usr', '/bin', '/sbin', '/boot', '/proc', '/sys', '/root',
    '/System', '/Library', '/private/etc', '/private/var'] + vars.systemDirs
shuvix-policy-rules:
  - effect: deny
    action: [write]
    match: inDir(object.path, systemDirs)
    prompt: 書き込みは拒否された。ここは OS のディレクトリであり、エージェントに対して閉じている。
---

**このポリシーの役割**：エージェントは OS の場所（`/etc`、`/usr`、`/System`、
Windows のシステム／プログラムディレクトリ……）へ決して書き込めない ——
自動許可が有効でも通らない。

**カバーしないこと**：

- ブロックされるのはエージェントのファイルツールによる書き込みのみ；確認済みの
  コマンドはあなたのシステム権限で実行され、ここでは制約されない。
- これらの場所の読み取りは遮らない。
- あなた自身のファイルは対象外 —— ask-on-read / ask-on-write が担当する。

**調整するには**：上書きコピーを作成して編集する —— 慎重に。
