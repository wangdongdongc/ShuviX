---
shuvix: okf v0.2
type: Guide
title: 'ShuviX が読む Skill（SKILL.md）'
description: 'ShuviX が skill を発見・解析・有効化・配達する仕組み —— 実際に読まれる SKILL.md の frontmatter、三つの skill ソース（グローバル、プロジェクト、外部ディレクトリ）、`.config.json`、スラッシュコマンド展開、`skill` ツール、agent ファイルとセッション拡張機能の `skill:<name>`。'
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

ShuviX はちょうど二つの frontmatter キーを、**行ベース**のパーサーで読みます（YAML パーサーでは
ありません）：

| キー          | 必須     | 意味                                                                                                                                                                              |
| ------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`        | **はい** | skill の名前 —— スラッシュコマンドであり、`skill:<name>` で使う値。一行。外側の引用符は剥がされる。単純な識別子（文字、数字、`-`）に保つ。                                        |
| `description` | いいえ   | 一行。`skill` ツールがモデルに見せ、スラッシュコマンドのポップオーバーがユーザーに見せるもの —— *いつこの skill を使うか*として、ユーザーやモデルが検索しそうな語で書く。一行、引用符は剥がされる。 |

パーサーの規則：ファイルは `---` で始まらなければならない；frontmatter は次の `---` で終わる；各行は
最初の `:` で分割される；複数行の値は**サポートされない**。`name` が無ければ frontmatter はまったく
認識されません：ディレクトリ名が名前になり、**frontmatter のテキストを含むファイル全体**が skill の
内容になります。閉じる `---` の後のすべてが skill の本文です。

ShuviX が読むのは `SKILL.md` だけです。同梱ファイルは、エージェントが skill を読み込んだ後に `read`
で開くためのもので、skill のベースディレクトリからのパスで参照します。

## Skill の場所

| ソース             | パス                                         | ShuviX が見る名前      | 有効化状態                                                              |
| ------------------ | -------------------------------------------- | ---------------------- | ----------------------------------------------------------------------- |
| グローバル         | `~/.shuvix/skills/<dir>/SKILL.md`            | `<name>`               | 既定でオン；無効化できる                                                |
| プロジェクト       | `<project>/.claude/skills/<dir>/SKILL.md`    | `<name>`               | そのプロジェクトのセッションでは**常にオン**；名前が衝突すれば優先      |
| 外部ディレクトリ   | 設定 → Skills で登録した任意のフォルダ       | `<dirName>:<name>`     | 既定でオン；ディレクトリ全体または個々の skill を無効化できる           |

ディレクトリ名と `name` は違っていてもよく、ShuviX は `name` で一致させます。組み込みの skill は
ありません。有効化状態は `~/.shuvix/skills/.config.json` にあります：

```json
{ "disabled": ["<name>", "<dirName>:<name>"], "disabledDirs": ["<dirName>"], "dirs": [{ "name": "<dirName>", "path": "/abs/path" }] }
```

設定 → Skills から編集してください。このファイルは ShuviX のもので、手で編集する場所ではありません。

## Skill はどうモデルに届くか

1. **スラッシュコマンド** —— 入力欄で `/<name>` と打つと、skill がメッセージとして挿入されます：
   `Base directory for this skill: <abs dir>` の一行に本文が続き、`${CLAUDE_SKILL_DIR}` は skill の
   ディレクトリに、`${CLAUDE_SESSION_ID}` は現在のセッション id に置換されます。本文全体がユーザーの
   テキストとして会話に入ります。
2. **`skill` ツール** —— セッション（または agent ファイル）が `skill:<name>` の項目を有効にすると、
   エージェントは `skill` ツールを得ます。その説明は有効な skill を `<name> / <description> /
   file://<dir>` として一覧し、モデルは `name` を付けて `skill` を呼び、完全な `SKILL.md` 本文と同梱
   ファイルの見本一覧を受け取り、必要なものを読みます。これは遅延です：モデルが求めるまで何も注入
   されないので、長い skill も使われない間はコストゼロです。
   - **セッションごと**：セッション設定の拡張機能セクション（と入力欄のツールピッカー）——
     セッションの `settings.enabledTools` に `skill:<name>` として保存される；プロジェクト自身の既定が
     新しいセッションに植えられる；この選択はセッションのエージェント作成時に一度だけ読まれ、その
     エージェントが存在する間は読み取り専用。
   - **agent ファイルごと**：agent md の `shuvix-tools: …, skill:<name>` —— セッションが何を選んで
     いようと、そのエージェントは常にその skill を持つ。
   - プロジェクトレベルの skill は、そのプロジェクトで働くどのルートエージェントの `skill` ツール
     からも見える。
3. **読むファイルとして** —— エージェントが `SKILL.md` を直接読むことを妨げるものはありません。
   上の二つの仕組みはパス探しを省くだけです。

## ShuviX 向けの良い skill を書く

- 発動条件は `description` に、手順は本文に。読み込むと決める前にモデルが見るのは description だけ
  です。
- 本文は自己完結で命令形に。同梱ファイルは相対パスで、テキストをスラッシュコマンドとして使うなら
  `${CLAUDE_SKILL_DIR}` で参照します。
- ディレクトリ名を skill と同じにし（`conventional-comments/SKILL.md`）、二つがずれないように
  します。
- 作ったら、ユーザーに設定 → Skills を確認するよう（または入力欄に `/<name>` が現れたと）伝えます。
  グローバルな skill は次の走査で拾われ、再起動は不要です。
