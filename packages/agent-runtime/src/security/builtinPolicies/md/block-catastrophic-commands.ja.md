---
shuvix: policy v1
shuvix-builtin: true
name: block-catastrophic-commands
shuvix-displayName: 壊滅的なコマンドをいくつか遮断
description: マシン全体を破壊する数種類の書き方——ルートディレクトリの削除、ディスクのフォーマットや上書き——を実行前に拒否します。ローカルコマンドと ssh コマンドを同じに扱います。
shuvix-policy-scope:
  subject.kind: [agent]
  object.type: [command]
shuvix-policy-lets:
  blockDevices: "['/dev/sd', '/dev/nvme', '/dev/disk', '/dev/hd', '/dev/vd']"
  recursiveForce: "['--recursive', '--force']"
shuvix-policy-rules:
  # ルートディレクトリの再帰的な強制削除
  - effect: deny
    action: [execute]
    match: >-
      object.commands.exists(c,
      c.base == 'rm'
      && (hasShortFlags(c.argv, 'rf') || hasShortFlags(c.argv, 'Rf')
      || recursiveForce.all(f, f in c.argv))
      && c.argv.exists(a, a == '/' || a == '/*'))
    prompt: 実行は拒否された。このコマンドはルートディレクトリの再帰的な強制削除として解析された。
  # ブロックデバイスのフォーマットまたは上書き —— mkfs / dd / リダイレクトは同じことの三通りの書き方
  - effect: deny
    action: [execute]
    match: >-
      object.commands.exists(c, c.base == 'mkfs' || c.base.startsWith('mkfs.'))
      || object.commands.exists(c, c.base == 'dd'
      && c.argv.exists(a, blockDevices.exists(d, a.startsWith('of=' + d))))
      || object.writes.exists(p, blockDevices.exists(d, p.startsWith(d)))
    prompt: 実行は拒否された。このコマンドはブロックデバイスのフォーマットまたは上書きとして解析された。
  # Windows：ドライブ単位のフォーマットとセキュア消去
  - effect: deny
    action: [execute]
    match: >-
      object.commands.exists(c,
      (c.base.lowerAscii() == 'format' && c.argv.exists(a, a.lowerAscii().matches('^[a-z]:')))
      || (c.base.lowerAscii() == 'cipher' && c.argv.exists(a, a.lowerAscii().startsWith('/w:'))))
    prompt: 実行は拒否された。このコマンドは Windows のドライブ単位のフォーマットまたは完全消去として解析された。
---

**すること**：マシン全体を壊す数種類の書き方——ルートディレクトリの削除、ディスクの
フォーマットや上書き——を実行前に拒否します。ローカルコマンドと ssh コマンドは同じ
扱いで、自動許可がオンでもこの拒否は覆りません。

コマンドはテキストではなく構造として読まれるため、書き換えてもすり抜けません。
コマンド名に引用符を挟む、`bash -c` で包む、ツールではなくリダイレクトでディスクに
書く——どれも同じ判定にたどり着きます。

**しないこと**：

- これは短いリストであり、汎用の危険検出ではありません。意図的に狭く保っています。
  通常の作業で誤って発火する規則は、何かを見逃す規則よりはるかに厄介です——拒否は
  一つのコマンドのためだけに解除できないからです。
- 実行時になって初めて対象が決まる書き方——`$(...)` の出力、変数から組み立てた
  コマンド名——は、事前の検査からは見えません。それらは ask-on-command に届きます。
  すべてのコマンドを実際にあなたの目の前に出すのは、そちらの門です。
- 引数ではなく標準入力からシェルに渡されるスクリプト——`bash <<'EOF' … EOF`、`sh -s`、
  シェルへのパイプ——は中身を読みません。`bash -c '…'` の形は読みます。
- コマンドが何と言っているかだけを見ます。最終的に何に触れるかは判断しません。

**調整するには**：上書きコピーを作成して編集してください——慎重に。
