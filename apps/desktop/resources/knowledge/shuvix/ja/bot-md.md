---
shuvix: okf v0.2
type: Guide
title: 'Bot ファイル（shuvix: bot v2）'
description: 'ShuviX の bot ファイルの完全な仕様 —— 三つの身元キーとトリガーのバインディング（実験的）、人格と記憶の本文、bot チャットがそれに結び付く仕組み、bot にできること・できないこと、そして bot が自分のファイルを維持する方法。'
tags: [shuvix, bot, format, spec]
status: stable
sources:
  - resource: https://github.com/wangdongdongc/ShuviX/blob/main/packages/agent-runtime/src/bot/botFile.ts
    title: botFile.ts —— パーサー（真実の源）
  - resource: https://github.com/wangdongdongc/ShuviX/blob/main/packages/agent-runtime/src/subagent/builtinAgents/md/bot.md
    title: bot.md —— bot チャットが動く `bot` ベース人格
  - resource: https://github.com/wangdongdongc/ShuviX/blob/main/packages/agent-runtime/src/security/builtinPolicies/md/ask-on-external-path.md
    title: ask-on-external-path —— bot が自分のファイルを編集するときに通る書き込み確認
---

# Bot ファイル

**bot** とは、普通のチャットセッションに結び付いた markdown ファイルです：**三つの身元キーと一つの
本文**。本文はその bot の**人格と記憶** —— 誰であり、どう話し、ユーザーについて何を学んだか —— で、
その bot とのすべての会話のシステムプロンプトに追加されます。形式はそれだけです：bot ファイルは
ツールもモデルもパイプラインも宣言しません。bot が*どう*働くかは組み込みの `bot` 人格が決め、*何の
上で*動くか（モデル、拡張機能）はセッションの仕事です。

- 場所：`~/.shuvix/bots/<name>.md`。
- マーカー：`shuvix: bot v2`。読み取り時は省略可ですが、**別の種別なら拒否**：`bots/` に落ちた agent
  ファイルは人格として読まれず、拒否されます。バージョンは検査されません。
- 存在すれば有効で、有効化スイッチはありません。ShuviX は初回起動時にこのフォルダへ bot を一つ書き込みます（デイリーボット、「トリガーのバインディング」を参照）。その後は普通のファイルです。

## 例

```markdown
---
shuvix: bot v2
name: mentor
shuvix-displayName: Mentor
description: A patient writing coach who remembers what I am working on.
---

## Who I am

You are Mentor, a writing coach. You ask before you rewrite, you quote the sentence you are
talking about, and you never pad feedback with praise.

## What I remember

- The user is drafting a novel set in 1920s Shanghai; chapters live in ~/Documents/novel.
- Prefers feedback on structure first, prose second.
```

## frontmatter キー

| キー                  | 型       | 必須   | 意味                                                                                                        |
| --------------------- | -------- | ------ | ----------------------------------------------------------------------------------------------------------- |
| `shuvix`              | `bot v2` | いいえ | ファイル種別マーカー。種別違い → ファイル全体を拒否。                                                       |
| `name`                | 文字列   | いいえ | bot の安定した身元 —— bot セッションが `settings.bot` に保存するもの。既定値はファイルのベース名。         |
| `shuvix-displayName`  | 文字列   | いいえ | サイドバーとセッションヘッダーのラベル。既定値は `name`。あれば文字列であること。                           |
| `description`         | 文字列   | いいえ | 一覧と「新しい bot チャット」ピッカーの一行。表示専用。あれば文字列であること。                             |
| `shuvix-bot-on`       | バインディングのリスト | いいえ | トリガーのバインディング（実験的）：`[{ trigger, when?, message }]` —— いつこの bot を起こし、起こすときに何を伝えるか。下の「トリガーのバインディング」を参照。無い = 誰かが話しかけたときだけ話す。 |
| `shuvix-id`           | 文字列   | いいえ | オブジェクト ID —— ファイルをどこへ移しても、ShuviX はこれで識別します。ShuviX が作成するファイルでは UUID、同梱ファイルでは `<種類>:builtin:<名前>`。コピーは元と同じ ID を共有します。ShuviX が書き込むので触れないでください。不正な値は警告が出るだけで、ファイル全体は拒否されません。 |

それ以外はすべて無視されますが、例外が一つ：廃止された v1 のキー `shuvix-bot-pipeline`（bot が
ワークフローを名指したパイプライン時代のもの）は解析されますが、**削除を求める警告**が出ます ——
設定のように見えて、何も制御していないからです。したがって `shuvix: bot v1` のファイルは動き続け、
残ったブロックだけがノイズです。

不正（ファイル全体を拒否、Bots グループに解析不能として一覧）：frontmatter がない、YAML エラー、
frontmatter がマッピングでない、`shuvix` マーカーが別の種別、`shuvix-displayName` / `description` が
文字列でない、`shuvix-bot-on` がバインディングのリストでない／`trigger` か `message` の無いバインディング、ほかのキー、
不正な CEL の `when`、セッションに属するトリガーへのバインド。

## 本文 —— 人格と記憶

前後の空白を除いた本文は、この bot に結び付いたすべてのセッションの**ルートエージェント**に、
`<bot_profile name="…" file="…">` フェンスの中で、自己維持の規則（後述）を述べる短いホスト前書きの後に
そのまま注入されます。システムプロンプトはローリング圧縮の外にあるので、注入は会話全体にわたって
残ります。

- **ルートエージェントだけが受け取ります。** bot が開くサブセッションや派遣するエージェントは、自分の
  agent ファイルからシステムプロンプトを組み立て、bot の本文を決して見ません。「人格は話し方を形作り、
  仕事のやり方は形作らない」は構造的な保証です。
- 本文は空でもかまいません（作ったばかりの bot はそうです）が、新規 bot テンプレートが植える二つの
  見出し（**私は誰か** / **私が覚えていること**）は残してください：bot は `edit` で自分のファイルを
  維持し、`edit` には足がかりとなる既存のテキストが必要です。最初の節はユーザーが書き、二つ目は bot が
  書きます。

## トリガーのバインディング（実験的）

`shuvix-bot-on` を使うと、bot は誰かに話しかけられる前に作業を始められます。バインディングごとに三つのキーがあります：

- `trigger` —— トリガーポイントの id。bot が結び付けられるのは**どのセッションにも属さない**トリガーポイントだけで、
  いまは一つ：`timer.fired`（内蔵タイマー。最初からオンで、毎分ちょうどに発火。設定 → トリガー でオフにできます）。
  セッション内のトリガーポイント（`session.*`、`permission.request`）は hook 用で、ここに書くとファイルが不正になります
  —— 発火のたびに新しいセッションが開くので、セッション内のイベントに結び付けるとセッションがセッションを生むからです。
- `when` —— 省略可能な CEL で、`{ event, env }` を見ます。hook の `when` と同じ規則です（`hook-md` を参照）。
  `timer.fired` の `event` は `{ sourceId, firedAt, local: { date, time, weekday, hour, minute }, trigger }`：
  ローカルのフィールドをそのまま比べれば（`event.local.time == '18:00'`）タイムゾーンに触れずに済みます。
  `activeSessions(date)` も呼べます —— そのローカル日に誰かがメッセージを書いたセッションの数（トリガーが bot の
  代わりに送ったもの、別のセッションから送られたものは数えません）。関数は評価がそこまで来たときだけ問い合わせるので、
  安い条件を左に書きます。
- `message` —— 必須。発火したときに bot に送る言葉。

発火すると ShuviX はこの bot に紐づく普通の一時セッションを新しく開き（タイトルは「表示名 · 時刻」）、`message` を
出所が「トリガー」のユーザーメッセージとして送り、後ろに `<trigger_event>` の囲みを付けます：イベントの全フィールドと
`lastFiredAt` —— このバインディングが前回発火した時刻で、bot はそれを手がかりに「前回以降」のことを扱います。
同じバインディングの前回の実行がまだ終わっていなければ（確認カードで止まっている場合も）今回は飛ばし、スリープ中や
ShuviX が閉じている間の分は補いません。トリガーのメッセージはユーザーの意思ではありません：自動レビューは委任として扱い、
許可としては扱いません。トリガーソース自体は誰が応じるかを知りません。一致するたびに（開いたセッションとその結果、スキップ、条件エラー）設定 → トリガー のトリガーログに記録され、そこで前回の生のイベント —— `when` が見る `event` —— も確認できます。

```yaml
shuvix-bot-on:
  - trigger: timer.fired
    when: event.local.time == '18:00' && activeSessions(event.local.date) > 0
    message: 前回の実行以降のセッションを整理し、追跡項目を更新してください。
```

ShuviX にはこうした bot が一つ付属しています：**デイリーボット**（`daily`、`shuvix-id: bot:builtin:daily`）。初回起動時に
UI 言語で `~/.shuvix/bots/daily.md` に書き込まれ、その後は普通の bot ファイルです —— 変更でき（発火の時刻など）、
削除すると二度と書き込まれません（書き込んだものは同じフォルダの `.builtin-seeded` に記録）。毎日夕方に最近のセッションと日記を
見直し、`~/.shuvix/tracking/` の追跡項目を管理します。手順はアプリ付属の `builtin:tracking` スキルにあり（bot ファイルは
一度しか書かれないので、手順はアプリと一緒に更新されます）、ユーザー自身の言葉でまだ終わっていないとわかることだけを直接作り、
それ以外は `suggest` で多くても三つ提案します。組み込みポリシー `daily-bot-access` により、直近 7 日間のセッションと
日記フォルダを読み、追跡項目フォルダを読み書きするときに確認されません（`policy-md` を参照）。

## Bot チャット

**bot セッション**は `settings.bot = <name>` で作られたセッションです（サイドバー → プロジェクト
グループのメニュー → 「新しい bot チャット」→ bot を選ぶ）。結び付きは作成時に決まり、**決して
変わりません** —— bot を替えるなら新しいセッションです。履歴はその bot の言葉だからです。それ以外は
普通のルート付きセッションです：モデルピッカー、拡張機能、圧縮、エクスポート、サブセッション、
バックグラウンドの自動再開はすべて通常どおり動きます。

そのルート人格は組み込みの **`bot`** ベースで、ツールリストは意図的に狭められています：`read, ls,
grep, glob, ask, suggest, write, edit, session, agent, knowledge, artifact, widget, skill` —— `bash`
はなく、組み込み機能サーバー `mcp:ssh` / `mcp:browser` / `mcp:database` も宣言していません（このセッションの
拡張機能でユーザーがオンにすることはでき、それはユーザー自身の選択です）。bot は作業を自分で行います（シェルはありません）。人格はあなたとの話し方だけを形づくり、bot が書くファイル・メモ・コードは平易に書かれます。大きな作業や独立した作業はサブセッションに渡せます（プログラミングは `agent_profile: coding`）。`~/.shuvix/bots/` 配下への書き込みはセッションの権限表の外への普通の書き込みで、
組み込みポリシー **ask-on-external-path** の確認になり、自動レビューがオンならレビュアーが答えることも
あります（そうした書き込みを必ずユーザーに届けたいなら、`vars.botsDir` に対する `force-ask` のポリシーを
書きます —— `policy-md` を参照）。
`notebook` と同じく、このベースはプロジェクト認識を宣言しますが指示ファイルは読みません（AGENTS.md /
CLAUDE.md は実際にコードを書くサブセッションのための約束事です）。
ベースは他の組み込みエージェントと同じく名前で上書きできます（`~/.shuvix/agents/bot.md`）。

## ライフサイクルの注意

- bot の**編集** = ShuviX でそのファイル（Bots グループの行）をノートブックセッションとして開くこと：
  ライブプレビュー、プロパティカード、自動保存。bot ページも保存ボタンもありません。
- frontmatter の `name` による**改名**は、ShuviX が次にディレクトリを走査したときに、古い名前に
  結び付いたセッションを移行します（各ファイルの名前を前回見たものと比較します）。ShuviX を閉じている
  間の改名や、古い名前・新しい名前がまだ別のファイルで使われている間の改名は移行されません。
- ファイルの**削除**はそのセッションに触れません（ユーザーのものです）。ヘッダーのチップは bot が
  消えたことを示し、セッションは人格なしのベースで動き続けます。
- 同名のコピーは `shuvix-files` エントリの規則に従います —— 負けたコピーは勝者の下に取り消し線付きで
  表示されます。
