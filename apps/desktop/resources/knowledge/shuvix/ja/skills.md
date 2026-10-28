---
shuvix: okf v0.2
type: Guide
title: 'ShuviX が読む Skill（SKILL.md）'
description: 'ShuviX が skill を発見・解析・有効化・配達する仕組み —— 実際に読まれる SKILL.md の frontmatter、各 skill ソース（グローバル、プロジェクト、共用、外部ディレクトリ）、`.config.json`、スラッシュコマンド展開、`skill` ツール、それを持つエージェント。'
tags: [shuvix, skills, format, spec]
status: stable
sources:
  - resource: https://github.com/wangdongdongc/ShuviX/blob/main/apps/desktop/src/main/services/skillService.ts
    title: skillService.ts —— 発見、解析、有効化状態、スラッシュコマンド展開（真実の源）
  - resource: https://github.com/wangdongdongc/ShuviX/blob/main/apps/desktop/src/main/services/skillTool.ts
    title: skillTool.ts —— skill をオンデマンドで読み込む `skill` ツール
---

# Skill

**skill** とは再利用できる指示パックです：`SKILL.md` を持つディレクトリと、任意の同梱ファイル
（スクリプト、テンプレート、参考資料）。ShuviX はコミュニティの **Agent Skills** レイアウトを使い ——
同じファイルが他のツールでも動きます —— 形式には何も足しません。ShuviX 固有なのは、skill が*どこで*
見つかり、*どう*有効化され、*どう*エージェントに届くかです。

## ファイル

```markdown
---
name: conventional-comments
description: Use when reviewing code or writing review comments — the conventional-comments labels (praise, nitpick, suggestion, issue, …) and when each applies.
---

# Conventional comments

Prefix every review comment with a label…
Scripts for this skill live in ${CLAUDE_SKILL_DIR}/scripts.
```

ShuviX は四つの frontmatter キーを、**行ベース**のパーサーで読みます（YAML は複数行の
`description` を読むときだけ使われます。後述）：

| キー          | 必須     | 意味                                                                                                                                                                              |
| ------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`        | **はい** | skill の名前 —— スラッシュコマンドであり、`skill` ツールが一覧する名前。一行。外側の引用符は剥がされる。単純な識別子（文字、数字、`-`）に保つ。                                        |
| `description` | いいえ   | なるべく一行（YAML の `>` ブロックも読める）。`skill` ツールがモデルに見せ、スラッシュコマンドのポップオーバーがユーザーに見せるもの —— *いつこの skill を使うか*として、ユーザーやモデルが検索しそうな語で書く。 |
| `disable-model-invocation` | いいえ | `true` なら `skill` ツールに載らない：ユーザーが `/<name>` で実行するだけ。Claude Code と同じキー。 |
| `user-invocable` | いいえ | `false` なら `/` メニューに出ない：モデルだけが読み込める。Claude Code と同じキー。 |

パーサーの規則：ファイルは `---` で始まらなければならない；frontmatter は次の `---` で終わる；各行は
最初の `:` で分割される。複数行で書かれた `description` —— YAML の `>` / `|` ブロック、または次の
インデント行に続けて書いた一文 —— は、frontmatter が正しい YAML なら YAML を通して読まれる。それ以外の値
（`name` は常に含む）は行ごとに読んだそのままです。`name` が無ければ frontmatter はまったく
認識されません：ディレクトリ名が名前になり、**frontmatter のテキストを含むファイル全体**が skill の
内容になります。閉じる `---` の後のすべてが skill の本文です。

ShuviX が読むのは `SKILL.md` だけです。同梱ファイルは、エージェントが skill を読み込んだ後に `read`
で開くためのもので、skill のベースディレクトリからのパスで参照します。

## Skill の場所

| ソース             | パス                                         | ShuviX が見る名前      | 有効化状態                                                              |
| ------------------ | -------------------------------------------- | ---------------------- | ----------------------------------------------------------------------- |
| グローバル         | `~/.shuvix/skills/<dir>/SKILL.md`            | `<name>`               | 既定でオン；無効化できる                                                |
| プロジェクト       | `<project>/.claude/skills/<dir>/SKILL.md`    | `<name>`               | そのプロジェクトのセッションでは**常にオン**；名前が衝突すれば優先      |
| 共用ディレクトリ   | `~/.claude/skills/<dir>/SKILL.md`、`~/.agents/skills/<dir>/SKILL.md` | `claude:<name>`、`agents:<name>` | **既定でオフ**；行メニューからディレクトリ全体をオンにする |
| 外部ディレクトリ   | サイドバーの「スキル」グループから追加した任意のフォルダ | `<dirName>:<name>`     | 既定でオン；ディレクトリ全体または個々の skill を無効化できる           |
| 組み込み           | アプリに同梱、読み取り専用                   | `builtin:<name>`       | 既定でオン；無効化できる                                                |

二つの**共用ディレクトリ**は、ほかのエージェントツールが使う場所です：`~/.claude/skills` は Claude Code の、
`~/.agents/skills` は Agent Skills のツール横断の慣例的な場所です（Codex や pi が読み、`npx skills add -g`
が実体を置く）。ShuviX は追加しなくてもこれらを一覧に出します —— skill があればそれぞれ一行になり、その行は
削除できません —— が、ユーザーがディレクトリをオンにするまでは**オフ**のままです。中身はほかのツールのために
入れられたものだからです。中の skill はユーザー自身のファイルで、編集できるノートとして開きます。skill
フォルダ内のシンボリックリンクは skill として読まれないので、`npx skills add` が `~/.claude/skills` に張った
リンク先の skill は `agents` の下に一度だけ現れます。同じフォルダをすでに外部ディレクトリとして追加していれば、
そちらが優先されます。

ディレクトリ名と `name` は違っていてもよく、ShuviX は `name` で一致させます。組み込みの skill はアプリに
同梱され（UI 言語ごとに一つのディレクトリ）、編集できません。その中に `builtin:drawing` —— インライン SVG
で図を描く手わざ —— と `builtin:widget` —— ウィジェットの作成と保守 —— があります。ほかの有効な skill と同じく、
`skill` ツールを持つすべてのエージェントの棚に載ります：`work`、`chat`、`coding`、`bot`、`notebook`、`tab` の
各エージェントが `shuvix-tools` にそれを書いています。`builtin:drawing` をオフにすると、それ以降に作られる
エージェントのシステムプロンプトから作図の節も消えます。

有効化状態は `~/.shuvix/skills/.config.json` にあります：

```json
{ "disabled": ["<name>", "<dirName>:<name>"], "disabledDirs": ["<dirName>"], "enabledDirs": ["agents"], "dirs": [{ "name": "<dirName>", "path": "/abs/path" }] }
```

`enabledDirs` は `disabledDirs` と逆向きで、既定でオフの共用ディレクトリにだけ使われます。

サイドバーの「スキル」グループから変更してください（行メニューの有効化 / 無効化）。このファイルは ShuviX のもので、手で編集する場所ではありません。

**skill を読むのは確認なし、変えるのは確認あり。** 組み込みの skill、`~/.shuvix/skills`、無効化されて
いないすべての外部ディレクトリ、オンにしたすべての共用ディレクトリは、どのセッションの権限表でも読み取り専用の行です（`policy-md`
エントリの `vars.aclRead`）：ファイルツールは確認なしで読め、サンドボックス内のコマンドも読めます。
そこへの書き込みは確認が出ます —— skill はエージェント自身が従う指示だからです —— ので、ユーザーの代わりに
グローバルや外部の skill を作成・編集するときは承認を経ます。プロジェクトレベルの skill は作業
ディレクトリの中にあり、プロジェクトの他のファイルと同じ扱いです。

## Skill はどうモデルに届くか

1. **スラッシュコマンド** —— 入力欄で `/<name>` と打つと、skill がメッセージとして挿入されます：
   `Base directory for this skill: <abs dir>` の一行に本文が続き、`${CLAUDE_SKILL_DIR}` は skill の
   ディレクトリに、`${CLAUDE_SESSION_ID}` は現在のセッション id に置換されます。本文全体がユーザーの
   テキストとして会話に入ります。
2. **`skill` ツール** —— `shuvix-tools` に `skill` と書いたエージェントは `skill` ツールを得ます。その説明は
   **有効なすべての skill**（`disable-model-invocation: true` のものを除く）を `<name> / <description> /
   file://<dir>` として一覧し、モデルは `name` を付けて `skill` を呼び、完全な `SKILL.md` 本文と同梱
   ファイルの見本一覧を受け取り、必要なものを読みます。これは遅延です：モデルが求めるまでは名前と説明だけ
   なので、長い skill も使われない間はほとんどコストがかかりません。Claude Code や Codex と同じ使い方です：
   - **セッションごと・プロジェクトごとの選択はない**：セッション設定、入力欄のツールピッカー、プロジェクト
     設定のどこにも skill の欄はありません。モデルに使わせたくない skill は、サイドバーでそれ（またはその
     ディレクトリ）をオフにします。
   - **エージェント作成時に決まる**：棚はセッションのエージェントが作られるときに読まれ、そのエージェントに
     付いていきます。skill のオン・オフはそれ以降に作られるエージェントに効き、動いているエージェントは作り
     直されるまで（エージェントチップの X）元の棚のままなので、プロンプトキャッシュが切れません。
   - **agent ファイルごと**：`skill` と書けば棚全体を持ちます。agent ファイルは個々の skill を選べません
     （古い書き方の `skill:<name>` は `skill` として読まれます）。
   - プロジェクトレベルの skill は、そのプロジェクトで働くエージェントの棚に載ります。
3. **読むファイルとして** —— エージェントが `SKILL.md` を直接読むことを妨げるものはありません。
   上の二つの仕組みはパス探しを省くだけです。

## ShuviX 向けの良い skill を書く

- 発動条件は `description` に、手順は本文に。読み込むと決める前にモデルが見るのは description だけ
  です。
- 本文は自己完結で命令形に。同梱ファイルは相対パスで、テキストをスラッシュコマンドとして使うなら
  `${CLAUDE_SKILL_DIR}` で参照します。
- ディレクトリ名を skill と同じにし（`conventional-comments/SKILL.md`）、二つがずれないように
  します。
- 作ったら、ユーザーにサイドバーの「スキル」グループを確認するよう（または入力欄に `/<name>` が現れたと）伝えます。
  グローバルな skill は次の走査で拾われ、再起動は不要です。
