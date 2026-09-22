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
  tempDirs: >-
    ['/private/var/folders', '/private/var/tmp']
shuvix-policy-rules:
  - effect: deny
    action: [write]
    match: inDir(object.path, systemDirs) && !inDir(object.path, tempDirs)
    prompt: 書き込みは拒否された。ここは OS のディレクトリであり、エージェントに対して閉じている。
---

**このポリシーの役割**：エージェントは OS の場所（`/etc`、`/usr`、`/System`、
Windows のシステム／プログラムディレクトリ……）へ決して書き込めない ——
自動許可が有効でも通らない。

パスは書き方ではなく、実際に行き着く場所で判定される：プロジェクト内の `/etc` を指す
リンクは `/etc` そのものと同じく拒否され、macOS では `/var/…` は `/private/var/…` である。

**カバーしないこと**：

- ブロックされるのはエージェントのファイルツールによる書き込みのみ；確認済みの
  コマンドはあなたのシステム権限で実行され、ここでは制約されない。
- これらの場所の読み取りは遮らない。
- 一時ディレクトリはシステムの場所ではない —— macOS がそれを `/private/var` の下に
  置いていても：あなた自身の一時ディレクトリ（`$TMPDIR`、`/private/var/folders` の下）と
  `/private/var/tmp` は通常どおり書き込める（通常どおり確認される）。
- あなた自身のファイルは対象外 —— ask-on-read / ask-on-write が担当する。

**調整するには**：上書きコピーを作成して編集する —— 慎重に。
