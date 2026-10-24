---
shuvix: policy v1
shuvix-id: policy:builtin:daily-bot-access
shuvix-builtin: true
name: daily-bot-access
shuvix-displayName: デイリーボットが最近のセッションを読む
description: ShuviX に付属のデイリーボットは、確認なしで直近 7 日間にメッセージのあったセッションを読み、~/.shuvix/tracking の追跡項目を管理できます。
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
      && timestamp(object.lastActiveAt) > timestamp(vars.now) - duration('168h')
    prompt: 直近 7 日間のセッションを見直すのがデイリーボットの役目です。
  - effect: force-allow
    object.type: [path]
    action: [read, write]
    match: >-
      has(subject.bot) && subject.bot == 'bot:builtin:daily'
      && subject.agentKind == 'root'
      && inDir(object.path, vars.trackingDir)
    prompt: 追跡項目はデイリーボット自身のファイルです。
---

**このポリシーの役割**：デイリーボット（ShuviX が初回起動時に `~/.shuvix/bots/daily.md` に書き込むもの）は、
毎日夕方に内蔵タイマーで起こされ、最近のセッションを見直して追跡項目を管理します。そのために必要な二つのことは
本来毎回確認されますが、夕方 18:00 に答える人はたいていいません：

- **別のセッションを読む** —— `ask-on-session-access` は、自分のサブセッションでないセッションを読む前に確認します。
  このポリシーにより、デイリーボットは直近 7 日間にメッセージのあったセッションを確認なしで読めます（読むだけで、
  メッセージを送るときは従来どおり確認します）；
- **`~/.shuvix/tracking/` の読み書き** —— `ask-on-external-path` は、セッションの権限表の外に書く前に確認します。

どちらのルールも、このボットに紐づいたセッションのルートエージェントにだけ適用されます（`subject.bot` はボット
ファイルの `shuvix-id` で、ボットの名前を変えても変わりません）。サブセッションや、ボットが派遣したエージェントには
適用されません。`bot:builtin:daily` という id は ShuviX 自身が書き込んだファイルにだけ認められます：ほかの
ボットファイルがこれを名乗っても名前で識別され、ShuviX が書いた `daily.md` が無くなればこの id は二度と認められません。

**調整するには**：行メニューから上書きコピーを作り、`168h` を長く／短く変えます。あるいはこのポリシーを無効にすると、
デイリーボットもほかのセッションと同じように確認します。`~/.shuvix/bots/daily.md` を削除するとボット自体が動かなくなります。
