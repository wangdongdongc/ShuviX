---
shuvix: okf v0.2
type: Guide
title: 'Agent 定義ファイル（shuvix: agent v1）'
description: 'ShuviX の agent ファイルの完全な仕様 —— すべての frontmatter キー、ツールホワイトリストの書き方、本文の `{{shuvix:*}}` プレースホルダー、ファイルが不正になる条件、組み込みエージェント、そして agent の使われ方。'
tags: [shuvix, agent, format, spec]
status: stable
sources:
  - resource: https://github.com/wangdongdongc/ShuviX/blob/main/packages/agent-runtime/src/agentProfile/definitionFile.ts
    title: definitionFile.ts —— パーサー（真実の源）
  - resource: https://github.com/wangdongdongc/ShuviX/blob/main/packages/agent-runtime/src/agentProfile/promptVars.ts
    title: promptVars.ts —— `{{shuvix:*}}` プレースホルダー
  - resource: https://github.com/wangdongdongc/ShuviX/blob/main/packages/agent-runtime/src/subagent/builtinAgents/md
    title: 組み込みエージェント、言語ごとに一つの md
---

# Agent 定義ファイル

**agent** とは人格 + ツールのホワイトリストです。ShuviX のすべてのエージェント —— 同梱のものも
ユーザーが書くものも —— はこの形式の一つの markdown ファイルです：YAML frontmatter に身元とスイッチ、
本文はそのエージェントの**システムプロンプト**です。

- 場所：`~/.shuvix/agents/<name>.md`（エージェントごとに一ファイル。ディレクトリはまだ無いかもしれない）。
- マーカー：先頭キーに `shuvix: agent v1`。ShuviX は書くとき必ず付け、読むときは省略可（古い手書き
  ファイルはこれが無くても読み込まれる）。
- 存在すれば有効：使われるときにファイルが読まれます。登録も再起動も不要。

## 例

```markdown
---
shuvix: agent v1
name: reviewer
description: Reads a change set and reports risks without editing anything.
shuvix-displayName: Code reviewer
shuvix-tools: read, ls, grep, glob, bash, skill:conventional-comments
shuvix-model: anthropic/claude-sonnet-4-5
shuvix-instruction-files: AGENTS.md, CLAUDE.md
shuvix-project-awareness: true
---

You are a code reviewer working in {{shuvix:workingDirectory}} on {{shuvix:date}}.
Read the diff the caller points you at, then report: correctness risks first, then
style, each with file and line. Never modify files.
```

## frontmatter キー

| キー                        | 型                 | 必須 | 意味                                                                                                                                                                                                                                                 |
| --------------------------- | ------------------ | ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `shuvix`                    | `agent v1`         | いいえ | ファイル種別マーカー。ShuviX は書くとき必ず付ける。読むときは省略可。                                                                                                                                                                                |
| `name`                      | 文字列             | いいえ | エージェントの身元 —— `agent` ツール、hook の `shuvix-hook-agent`、サブセッションの `agent_profile` が名指すもの。既定値はファイルのベース名（`reviewer.md` → `reviewer`）。                                                                         |
| `description`               | 文字列             | いいえ | エージェント一覧に表示される人間向けの一行。モデルには見せない。                                                                                                                                                                                     |
| `shuvix-displayName`        | 文字列             | いいえ | UI 上のラベル。既定値は `name`。                                                                                                                                                                                                                     |
| `shuvix-tools`              | カンマ区切り文字列 | いいえ | ツールのホワイトリスト（後述）。**YAML リストではなく文字列** —— リストにするとファイルは不正。省略 = ツールなし。                                                                                                                                    |
| `shuvix-model`              | 文字列             | いいえ | このエージェントが動くモデル：`<providerId>/<modelId>`（UI が書く形）か、素の `<modelId>`。省略 = 動いているセッション（または派遣元）に従う。設定で有効になっていないモデルは無いものとして扱われる。                                                    |
| `shuvix-instruction-files`  | カンマ区切り文字列 | いいえ | エージェントが読むプロジェクト指示ファイル。**作業ディレクトリからの相対パス**を優先順に並べる：存在して空でない最初の一つが注入され、最大一つ。絶対パス、`..` セグメント、ブール値はファイルを不正にする。省略 = 注入なし。                                  |
| `shuvix-project-awareness`  | ブール             | いいえ | `true` = エージェントにどのプロジェクトにいるかを伝える：プロジェクトのプロンプトとプロジェクト記憶の索引がシステムプロンプトに追加される（ルートセッションのプロジェクトで解決；プロジェクトが無ければ何も注入されない）。本物の YAML ブール値であること。既定 `false`。 |
| `shuvix-builtin`            | ブール             | いいえ | ShuviX が同梱するファイルの自己申告マーカー。パーサーは読まない。ユーザーファイルに加えないこと。                                                                                                                                                    |

**無視される**キー（未知のキーとして読まれ、エラーも効果もない）：汎用の `tools` キー（他アプリの
ツール名の意味で誤読されるため —— `shuvix-tools` を使う）、および廃止された `whenToUse`、
`displayName`、`shuvix-dispatch-only`、`shuvix-session-awareness`、`shuvix-prompt-sections`、
`shuvix-project-prompt`、`shuvix-project-memory`。

### `shuvix-tools` —— ホワイトリスト

カンマ区切りの文字列。各項目は次のいずれか：

- **組み込みツール名** —— 大文字小文字を区別せず、小文字に正規化：`bash`、`read`、`write`、`edit`、
  `ls`、`glob`、`grep`、`ask`、`browser`、`ssh`、`database`、`git`、`preview`、`session`、`knowledge`；
- `agent` —— `agent` ツールで**サブエージェントを派遣**することへのオプトイン（入れ子の上限に従う：
  派遣されたエージェントは深さの上限 —— 既定 2 —— が許す間だけ、さらに派遣できる）；
- `mcp:<server>` —— その MCP サーバーのすべてのツール（設定で構成した名前；接頭辞の後は大文字小文字を
  保持；エージェント作成時に遅延接続される）；
- `skill:<name>` —— その skill（名前空間付きの skill は `skill:<dir>:<name>` と書く）。

項目は順序を保って重複除去されます。このホストに存在しない名前は黙って落とされ、エージェントはそれ無しで
作られます。リストを狭めることは ShuviX で役割を表す方法では**ありません**：`grep` の無いエージェントは
`bash` で grep するだけです。組み込みの `work`、`chat`、`coding` は意図的に一つのリスト（`bash, read,
write, edit, ask, browser, ls, grep, glob, ssh, database, agent, session, knowledge`）を共有し、本文だけが
異なります。

### 本文 —— システムプロンプト

frontmatter の後の全部（前後の空白を除く）がシステムプロンプトです。`{{shuvix:name}}` 形式の
**プレースホルダー**を埋め込め、エージェント作成時に置換されます。デスクトップホストで使えるもの：

| プレースホルダー                 | 値                                                                   |
| -------------------------------- | -------------------------------------------------------------------- |
| `{{shuvix:workingDirectory}}`    | セッションの作業ディレクトリの絶対パス                               |
| `{{shuvix:isGitRepo}}`           | `Yes` / `No` —— そのディレクトリに `.git` があるか                    |
| `{{shuvix:platform}}`            | `darwin` / `win32` / `linux`                                          |
| `{{shuvix:shell}}`               | `zsh` / `bash` / `fish` / シェルのパス                                |
| `{{shuvix:os}}`                  | OS の種類とリリース                                                  |
| `{{shuvix:date}}`                | 今日、`YYYY-MM-DD`                                                    |
| `{{shuvix:language}}`            | UI の言語、例：`中文 (zh)` / `English (en)`                           |
| `{{shuvix:appVersion}}`          | ShuviX のバージョン                                                   |
| `{{shuvix:projectName}}`         | プロジェクト名、プロジェクト外では空                                 |
| `{{shuvix:notebookPath}}`        | ノートブックセッションが結び付いたファイル（ノートブックセッションのルートエージェントのみ） |

未知のプレースホルダーはそのまま残ります（警告がログされる）。空の値は周囲の空行を畳むので、空の変数に
基づく文はきれいに消えます。この構文は i18n テンプレートと衝突しません。本文のそれ以外は普通の文章です
—— 他のテンプレート構文はありません。

## ファイルが不正になる条件

次の場合、パーサーは**ファイル全体**を拒否します（スキップされ、設定 → Agent の「解析できません」に
一覧され、同名の組み込みを隠すことはありません）：

- YAML frontmatter ブロックが無い、YAML が解析できない、マッピングでない；
- `shuvix-tools` / `shuvix-model` / `shuvix-instruction-files` が文字列でない（YAML リストがよくある
  間違い）；
- `shuvix-project-awareness` がブールでない；
- `shuvix-instruction-files` の項目が絶対パスであるか `..` で作業ディレクトリを抜ける、またはこのキーが
  2026 年より前のブール形式（`shuvix-instruction-files: true` —— 代わりにファイル名を列挙する）。

空の frontmatter（`---` の直後に `---`）は有効です：すべてのフィールドが既定値になります。

## 組み込みエージェントとその上書き

アプリケーションに同梱（UI 言語ごとに一つ、同じパーサーで読まれる）：四つの**ベース**人格 `work`
（プロジェクト内セッションのルート）、`chat`（どのプロジェクトにも属さないセッションのルート）、
`notebook`（ノートブックセッションのルート）、`bot`（bot チャットのルート）—— に加えて、タスク型の
`coding`、`browser`、`explore`、`visualization`、`widget`、`wiki`、`wiki-writer`、`titler`、
`knowledge-writer`。

- **セッションのルート人格はセッションの形から導かれ、決して選ばれません**：ノートブック → `notebook`、
  bot チャット → `bot`、プロジェクト内 → `work`、それ以外 → `chat`。設定もピッカーもありません。
  メイン会話の振る舞いを変えるには、**ベースを名前で上書き**します：`~/.shuvix/agents/work.md` は
  組み込みの `work` を丸ごと置き換えます（設定 → Agent → 「上書きコピーを作成」で現在のテキストを
  出発点にできます）。
- `name` が組み込みと同じユーザーファイルは、その組み込みを置き換えます。ユーザーファイル同士の同名は
  `shuvix-files` エントリの規則で解決され、負けたコピーは上書き済みとして一覧されます。壊れた上書きが
  組み込みを隠すことはありません。
- ベースは**決して派遣されず、決して名指されません**：`agent` ツール、hook の `shuvix-hook-agent`、
  サブセッションの `agent_profile` はいずれも `work` / `chat` / `notebook` / `bot` を拒否します。

## Agent はどう使われるか

1. **`agent` ツールでサブエージェントとして派遣**（呼び出し側自身のリストに `agent` が必要）：`name` =
   このファイルの `name`、加えて `prompt` と短い `description`。サブエージェントはルートエージェントと
   対等にメモリ内で走り、`shuvix-model` が無ければセッションのモデルと思考レベルを継承し、ルート
   セッションのプロジェクトに対して解決された同じ指示ファイル / プロジェクト注入を受け取り、最終テキストを
   返します。このツールは利用可能なエージェントをモデルに列挙**しません** —— 名前はプロンプトか
   ユーザーから知る必要があります。
2. **サブセッションの人格として** —— `session` ツールの `agent_profile`（ベースでない任意の
   エージェント）。そのエージェントの `shuvix-tools` にある空でない `mcp:` / `skill:` 項目は、子が親から
   複写した拡張機能を置き換えます。空なら継承されたものを保ちます。
3. **hook のエージェントとして**（`shuvix-hook-agent` —— `hook-md` エントリを参照）。
4. **ベースの上書きとして**（上記）。

コンテキスト注入はどの場合にも適用されます：`shuvix-instruction-files` と `shuvix-project-awareness` は
**このファイル**から読まれ、ツールリストに `knowledge` があればナレッジベースの案内が注入されます。
