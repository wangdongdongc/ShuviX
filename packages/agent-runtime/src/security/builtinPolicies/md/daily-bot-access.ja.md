---
shuvix: policy v1
shuvix-id: policy:builtin:daily-bot-access
shuvix-builtin: true
name: daily-bot-access
shuvix-displayName: 日記ボットが今日のセッションを読む
description: ShuviX に付属の日記ボットは、確認なしで直近 24 時間にメッセージのあったセッションとあなたの日記を読めます。自分からは何も書きません。
shuvix-policy-scope:
  subject.kind: [agent]
  env.host: [desktop]
shuvix-policy-rules:
  - effect: force-allow
    object.type: [session]
    action: [read]
    match: >-
      has(subject.bot) && subject.bot == 'bot:builtin:daily'
      && subject.agentKind == 'root'
      && timestamp(object.lastActiveAt) > timestamp(vars.now) - duration('24h')
    prompt: 今日のセッションを見るのが日記ボットの役目です。
  - effect: force-allow
    object.type: [path]
    action: [read]
    match: >-
      has(subject.bot) && subject.bot == 'bot:builtin:daily'
      && subject.agentKind == 'root'
      && inDir(object.path, vars.dailyDir)
    prompt: 日記ボットは昨日の日記が書かれているかを確かめます。
---

**このポリシーの役割**：日記ボット（ShuviX が初回起動時に `~/.shuvix/bots/daily.md` に書き込むもの）は、
毎日夕方に内蔵タイマーで起こされ、今日のセッションと昨日の日記が書かれているかを見て、受け入れられる提案を
いくつか出します。そのために必要な二つのことは本来毎回確認されますが、夕方 18:00 に答える人はたいていいません：

- **ほかのセッションを読む** —— `ask-on-session-access` は、自分のサブセッションではないセッションを読む前に確認します。
  このポリシーにより、日記ボットは直近 24 時間にメッセージのあったセッションを確認なしで読めます（読むだけ：
  そこへメッセージを送るのは引き続き確認されます）。
- **`~/.shuvix/daily/` を読む** —— あなたの日記です（読むだけ）。

書き込みを許すルールはありません：提案（たとえば今日の日記を書く）を受け入れたとき、その書き込みはほかの
セッションと同じく通常どおり確認されます。

二つのルールはどちらも、そのボットに結び付いたセッションのルートエージェントにだけ効きます（`subject.bot` は
ボットファイルの `shuvix-id` で、ボットの名前を変えても変わりません）。サブセッションや、それが派遣するエージェントには
効きません。`bot:builtin:daily` という id は ShuviX 自身が書いたファイルにだけ成り立ちます：同じ id を宣言する
別のボットファイルは名前で識別され、ShuviX の `daily.md` が無くなればその id は二度と認められません。

**調整するには**：行メニューから上書きコピーを作り、`24h` を長く・短く変えます。またはこのポリシーを無効にすれば、
日記ボットもほかのセッションと同じく確認するようになります。`~/.shuvix/bots/daily.md` を削除すればボット自体が動かなくなります。
