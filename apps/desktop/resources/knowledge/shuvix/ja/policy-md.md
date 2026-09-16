---
shuvix: okf v0.2
type: Guide
title: 'セキュリティポリシーファイル（shuvix: policy v1）'
description: 'ShuviX セキュリティポリシーの完全な仕様 —— 規則が見るリクエスト文書（subject / action / tool / object / env / vars）、五つの条件キー、CEL `match`、効果とその優先順位、`lets`、ファイルが不正になる条件、組み込みポリシー、そしてゲートの緩め方と締め方。'
tags: [shuvix, policy, security, format, spec, cel]
status: stable
sources:
  - resource: https://github.com/wangdongdongc/ShuviX/blob/main/packages/agent-runtime/src/security/policyFile.ts
    title: policyFile.ts —— パーサー（真実の源）
  - resource: https://github.com/wangdongdongc/ShuviX/blob/main/packages/agent-runtime/src/security/celMatch.ts
    title: celMatch.ts —— CEL 環境、`inDir`、`hasShortFlags`、strict セマンティクス
  - resource: https://github.com/wangdongdongc/ShuviX/blob/main/packages/agent-runtime/src/security/builtinPolicies/md
    title: 組み込みポリシー、言語ごとに一つの md
---

# セキュリティポリシーファイル

ShuviX の権限システムは**確認モデルであって、サンドボックスではありません**。すべてのツール呼び出しは
プロセス内で規則の集合に照らされ、**許可 / 確認 / 拒否**のいずれかになります。規則はユーザーが読み、
上書きし、削除できる markdown ファイルです。第一原則は**ポリシーなし = 許可**：どの規則にも一致しない
操作は自由に実行され、ShuviX が同梱するすべての保護は目に見えるポリシーです。（許可された `bash`
コマンドはユーザーの完全な権限で実行されます —— ここに OS レベルの隔離はありません。）

- 場所：`~/.shuvix/policies/<name>.md`。
- マーカー：`shuvix: policy v1`。読み取り時は省略可、書くときは必ず付く。
- 存在すれば有効。セッションの規則が組み立てられるときに読み直されます。組み込みと同じ `name` の
  ユーザーファイルはそれを**置き換え**、不正なユーザーファイルが組み込みを隠すことはありません。

## 例

```markdown
---
shuvix: policy v1
name: protect-drafts
shuvix-displayName: Never overwrite my drafts
description: Files under ~/Documents/drafts can be read but never written by an agent.
shuvix-policy-scope:
  subject.kind: [agent]
  object.type: [path]
  env.host: [desktop]
shuvix-policy-lets:
  drafts: "[vars.home + '/Documents/drafts']"
shuvix-policy-rules:
  - effect: deny
    action: [write]
    match: inDir(object.path, drafts)
    prompt: Write refused — the drafts folder is read-only for agents; ask the user to move the file out first.
---

**What it does**: any write under `~/Documents/drafts` is refused, even with auto-allow on.
The body is documentation only — the engine never reads it.
```

## frontmatter キー

| キー                    | 型                          | 必須   | 意味                                                                                                                                                                                                   |
| ----------------------- | --------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `shuvix`                | `policy v1`                 | いいえ | ファイル種別マーカー。                                                                                                                                                                                 |
| `name`                  | 文字列                      | いいえ | 身元（上書きはこれで一致させる）。既定値はファイルのベース名。                                                                                                                                         |
| `shuvix-displayName`    | 文字列                      | いいえ | 設定 → ポリシーと確認カード上のラベル。既定値は `name`。                                                                                                                                               |
| `description`           | 文字列                      | いいえ | 一覧の一行。                                                                                                                                                                                           |
| `shuvix-policy-scope`   | マッピング                  | いいえ | このポリシーの**すべての規則**が共有する条件（各規則に AND される）。規則の条件と同じキー。規則自身の条件が scope と矛盾する（共通部分が空）場合、ファイルは不正。                                       |
| `shuvix-policy-lets`    | マッピング 名前 → CEL 文字列 | いいえ | `{vars}` から一度計算される名前付きの値で、各規則の `match` にトップレベルの名前として注入される。名前は識別子で、`subject`、`action`、`tool`、`object`、`env`、`vars`、`inDir` は不可。必要時に遅延評価。 |
| `shuvix-policy-rules`   | 規則のリスト                | **はい** | エンジンが評価する唯一のもの。空リストでもよい（`[]` での上書きは組み込みゲートを切る）。                                                                                                            |

素の `rules:`、`lets:`、`scope:` キーはファイルを不正にします —— 綴りを誤ったキーが黙って「規則なし」
を意味してはならないからです。接頭辞のない他の未知キーは無視されます。

### 規則

| 規則のキー                                                     | 意味                                                                                                                                                                                 |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `effect`                                                       | **必須**：`allow`、`force-allow`、`ask`、`force-ask`、`deny` のいずれか。                                                                                                              |
| `subject.kind`、`action`、`object.type`、`env.host`、`tool.name` | 構造化条件：文字列または文字列のリスト（リスト内は OR、キー間は AND）。`'*'` = 任意。空リストや空文字列は不正。**`subject.kind` は必須** —— 規則上か scope に。「任意の主体」は意図して `'*'` と書く。 |
| `match`                                                        | 省略可能な CEL 式。リクエスト文書（後述）に対して評価され、条件と AND される。構文エラーはファイルを不正にする。                                                                        |
| `prompt`                                                       | 省略可能な一行。`ask` なら確認カードに表示、`deny` なら拒否理由としてエージェントに返り、許可系の規則では設定に表示されるだけ。最大 1000 文字。ファイルを不正にしない唯一のキー。          |

規則内の他のいかなるキーもファイルを不正にします（古い入れ子の `object:` / `subject:` / `when:`
マッチャーを含む）。

### 効果と優先順位

すべてのポリシーの一致した全規則のうち、最も強い効果が勝ちます：

```
deny  >  force-ask  >  force-allow  >  ask  >  allow  >  （何も一致しない = allow）
```

- `ask` は呼び出しをユーザーの前に出し、`allow` はそのまま通し、`deny` は拒否します（エージェントは
  `prompt` を理由として受け取る）。
- `force-allow` はあらゆる `ask` にも勝つ許可 —— ShuviX はセッションの許諾（「自動許可」と
  「許可して記憶」）にこれを使います。
- `force-ask` は `force-allow` でさえ飛ばせない確認 —— 「このゲートはセッション単位の同意を受け付けない」
  （bot ファイルのゲートがそれです）。
- `deny` はすべてに勝ちます。

条件はネイティブな述語にコンパイルされ、CEL の**前**に評価されるので、条件が外れた規則はその `match`
もポリシーの `lets` も決して実行しません。

## リクエスト文書

すべての検査は五つの部分からなるリクエストです。`match` からはこう見えます：

```
subject  { kind: 'agent' | 'user', agentKind: 'root' | 'spawned', profile: <エージェント名>, sessionId, depth }
action   'read' | 'write' | 'execute'
tool     { name: <ツール名>, operation: <ツール固有の操作。無ければ ''> }
object   { type: <オブジェクト種別>, ...属性 }        ← 開かれた属性文書
env      { host: 'desktop' | 'extension', platform: 'darwin' | 'win32' | 'linux' }
vars     ホスト変数表（後述）+ セッションの許諾
```

`subject.kind` はツール呼び出しでは `agent`、UI 自身の受動的な検査では `user` です —— だからすべての
組み込み規則が `subject.kind: [agent]` を持っています。

### オブジェクト種別とその属性

| `object.type`  | 発生元                                                       | `action`         | 属性                                                                                                                                                                                                                                                      |
| -------------- | ------------------------------------------------------------ | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `path`         | `read`、`write`、`edit`、`knowledge` ツール、ファイルプレビュー | `read` / `write` | `path`（解決済みの絶対パス）、`displayPath`                                                                                                                                                                                                              |
| `command`      | `bash`、`ssh`                                                | `execute`        | `command`（生のテキスト）、`channel`（`bash` / `ssh`）、およびシェルパーサーから遅延で：`parsed`（ブール）、`commands`（`{ base, argv, wrappers, complete, depth }` のリスト —— `base` は `sudo` / `env` / `timeout` を剥がした後の本当のプログラム、動的な語は `''`）、`writes`（リダイレクト先の絶対パス） |
| `gitTool`      | `git` ツール                                                 | `execute`        | `gitAction`、`command`、`force`（ブール）、`delete`（ブール）                                                                                                                                                                                           |
| `database`     | `database` ツール                                            | `execute`        | `sql`、`credential`、`dbType`、`readonly`（ブール —— 接続が読み取り専用か）                                                                                                                                                                              |
| `invocation`   | **すべての**ツール呼び出し、実行前                           | `execute`        | なし —— `tool.name` / `tool.operation` で判断する（例：`session` / `create-sub-session`）。ここでの規則はツールを名指す必要がある。対象を定めない invocation の確認はすべての呼び出しを止めてしまう。                                                       |

**strict セマンティクス**：オブジェクトに無い属性を読む（例：`command` に対して `object.path`）のは
エラーで、エラーは**効果に応じてフェイルセーフ**します —— `deny` / `ask` の規則は一致扱い（警告付き）、
許可系の規則は不一致扱い。常に種別で守ってください：`object.type == 'path' && inDir(object.path, …)`、
または `object.type` を条件として宣言します。

### `match` で使える関数

- `inDir(path, dirs)` —— `dirs` は文字列かリスト。`path` がそのいずれかの中にあれば真（パスセグメント
  境界で判定：`/foo` は `/foobar` に一致しない）。空や文字列でない項目は決して一致しない。
- `hasShortFlags(argv, 'rf')` —— `argv` 内の GNU 風の短いフラグ群がそれらの文字をすべて含むか
  （`-rf`、`-fr`、`-r -f` はすべて該当）。
- 通常の CEL 演算子、`in`、`startsWith`、`has(...)`、文字列とリストの関数。

### `vars` —— ホスト変数表

| 名前                          | 型       | 意味                                                                          |
| ----------------------------- | -------- | ----------------------------------------------------------------------------- |
| `workspace`                   | string   | セッションの作業ディレクトリ                                                  |
| `home`                        | string   | ユーザーのホームディレクトリ                                                  |
| `toolResultsBase`             | string   | 大きなツール結果をスプールする場所                                            |
| `skillsDirs`                  | string[] | skill ディレクトリ（グローバル、組み込み、登録された外部）                    |
| `memoryDirs`                  | string[] | 旧プロジェクト記憶のルート                                                    |
| `botsDir`                     | string   | `~/.shuvix/bots`                                                              |
| `builtinKnowledgeDir`         | string   | ShuviX が同梱する読み取り専用のナレッジベース（このベース）                   |
| `systemDirs`                  | string[] | 追加の OS ディレクトリ（Windows のシステム / プログラムディレクトリ）          |
| `autoAllow`                   | boolean  | セッションの「自動許可」スイッチ                                              |
| `grantedRead`、`grantedWrite` | string[] | ユーザーがこのセッションで「許可して記憶」と答えたパス（書き込みは読み取りを含意） |

ホストが供給せず、かつ規則が `inDir` のディレクトリ引数として**だけ**使う `vars.x` は「そのような
ディレクトリはない」として扱われます（正の `inDir` はそれを通して一致できず、否定形は真、すなわち
規則はより多く確認する）。欠けた変数のそれ以外の使い方はエラーとなりフェイルセーフに入ります。

## ファイルが不正になる条件

次の場合、ファイル全体が拒否されます（スキップされ、設定 → ポリシーの「解析できません」に一覧され、
組み込みを隠すことはない）：frontmatter がない / YAML エラー / マッピングでない；素の `rules` /
`lets` / `scope` キー；`shuvix-policy-rules` がリストでない；未知のキー、未知の `effect`、不正な
条件値、解析できない `match` を持つ規則；`subject.kind` のない規則（規則にも scope にも）；条件が
scope と交差して空になる規則；不正な `lets`（不正な名前、予約名、文字列でないか解析できない式）。
`object.type` を宣言せずに `object.*` を読む `match` は警告付きで受理されます。

## 組み込みポリシー

アプリケーションに十四本同梱（UI 言語ごとに一つ；**規則は常に英語ファイルから取られ**、翻訳は人が読む
テキストだけを変える）：

| 名前                            | ゲート                                                                                                       |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `protect-credentials`           | 認証情報ディレクトリ（`.ssh`、`.aws`……）への書き込みを拒否、読み取りを確認                                    |
| `protect-system`                | OS ディレクトリへの書き込みを拒否                                                                             |
| `block-catastrophic-commands`   | マシンを破壊する少数のコマンドを、解析された構造で判断して拒否（`rm -rf /`、`mkfs`、デバイスへの `dd`……）     |
| `protect-bot-files`             | `~/.shuvix/bots` 配下のあらゆる書き込みを **force-ask**                                                       |
| `protect-builtin-knowledge`     | ShuviX の組み込みナレッジベースへの書き込みを拒否                                                             |
| `ask-on-read`                   | ワークスペース、ツール結果、skill ディレクトリの外の読み取りを確認                                            |
| `ask-on-write`                  | すべてのファイル書き込みを diff プレビュー付きで確認                                                          |
| `review-memory-writes`          | 旧記憶ストアへの書き込みを force-ask                                                                          |
| `ask-on-command`                | すべての `bash` / `ssh` コマンドを確認                                                                        |
| `git-safety`                    | 破壊的な git 操作を確認（`init`、`restore`、強制 checkout、ブランチ削除）                                     |
| `ask-on-database`               | 書き込み可能なデータベース接続上のすべての文を確認                                                            |
| `ask-on-sub-session`            | サブセッションを開くときに一度確認（`tool.name == 'session' && tool.operation == 'create-sub-session'`）       |
| `session-auto-allow`            | セッションの自動許可スイッチがオンの間、すべてを `force-allow`                                                |
| `session-path-grants`           | ユーザーが「許可して記憶」と答えたパス配下の読み書きを `force-allow`                                          |

設定 → ポリシーは各ポリシーとその規則を表示します。「上書きコピーを作成」は現在のテキストを
`~/.shuvix/policies/<name>.md` に書き出します。

## 緩める、締める

- **ゲートを外す**：名前で上書きし、`shuvix-policy-rules: []`。
- 組み込みに触れずに**一箇所を確認から免除**：`force-allow` の規則を持つ新しいポリシー
  （`force-allow` は `ask` に勝つ）。例：あるディレクトリ配下の書き込み。
- **強い停止を加える**：`deny` の規則 —— 自動許可を含むすべてに勝つ。
- **ゲートを飛ばせなくする**：`force-ask`。
- 規則は狭く：deny は呼び出しごとに免除できないので、日常の作業で発火する規則は、見逃す規則より
  悪い。

## ファイルに無いもの

エンジンは本文を決して読みません（人のための根拠のみ）。ツールごとのスキーマも、生のコマンドテキストに
対する正規表現マッチもなく（構造化された `commands` / `writes` がそのためにある）、ツールが*何をするか*
を変える方法もありません —— ポリシーは呼び出しを進めるかどうかだけを決めます。
