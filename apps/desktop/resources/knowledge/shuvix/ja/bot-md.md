---
shuvix: okf v0.2
type: Guide
title: 'Bot ファイル（shuvix: bot v2）'
description: 'ShuviX の bot ファイルの完全な仕様 —— 三つの身元キー、人格と記憶の本文、bot チャットがそれに結び付く仕組み、bot にできること・できないこと、そして bot が自分のファイルを維持する方法。'
tags: [shuvix, bot, format, spec]
status: stable
sources:
  - resource: https://github.com/wangdongdongc/ShuviX/blob/main/packages/agent-runtime/src/bot/botFile.ts
    title: botFile.ts —— パーサー（真実の源）
  - resource: https://github.com/wangdongdongc/ShuviX/blob/main/packages/agent-runtime/src/subagent/builtinAgents/md/bot.md
    title: bot.md —— bot チャットが動く `bot` ベース人格
  - resource: https://github.com/wangdongdongc/ShuviX/blob/main/packages/agent-runtime/src/security/builtinPolicies/md/protect-bot-files.md
    title: protect-bot-files —— bot ファイルへの常時確認ゲート
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
- 存在すれば有効。組み込みの bot はなく、有効化スイッチもありません。

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

それ以外はすべて無視されますが、例外が一つ：廃止された v1 のキー `shuvix-bot-pipeline`（bot が
ワークフローを名指したパイプライン時代のもの）は解析されますが、**削除を求める警告**が出ます ——
設定のように見えて、何も制御していないからです。したがって `shuvix: bot v1` のファイルは動き続け、
残ったブロックだけがノイズです。

不正（ファイル全体を拒否、Bots グループに解析不能として一覧）：frontmatter がない、YAML エラー、
frontmatter がマッピングでない、`shuvix` マーカーが別の種別、`shuvix-displayName` / `description` が
文字列でない。

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

## Bot チャット

**bot セッション**は `settings.bot = <name>` で作られたセッションです（サイドバー → プロジェクト
グループのメニュー → 「新しい bot チャット」→ bot を選ぶ）。結び付きは作成時に決まり、**決して
変わりません** —— bot を替えるなら新しいセッションです。履歴はその bot の言葉だからです。それ以外は
普通のルート付きセッションです：モデルピッカー、拡張機能、圧縮、エクスポート、サブセッション、
バックグラウンドの自動再開はすべて通常どおり動きます。

そのルート人格は組み込みの **`bot`** ベースで、ツールリストは意図的に狭められています：`read, ls,
grep, glob, ask, edit, session, agent, knowledge` —— `bash`、`write`、`ssh`、`database`、`browser` は
ありません。bot は見ることはできても触れません：変更や実行を伴うことはすべてサブセッションへ
（プログラミングは `agent_profile: coding`）。`edit` は一つの目的 —— 自分のファイルの維持 —— のために
あり、`~/.shuvix/bots/` 配下へのすべての書き込みは組み込みポリシー **protect-bot-files** を通り、
自動許可がオンでもユーザーに確認します。`notebook` と同じく、このベースはプロジェクト認識を宣言しますが
指示ファイルは読みません（AGENTS.md / CLAUDE.md は実際にコードを書くサブセッションのための約束事です）。
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
