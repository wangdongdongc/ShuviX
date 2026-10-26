---
shuvix: okf v0.2
type: Guide
title: 'リモートアクセスのポリシー —— 誰が接続でき、各デバイスに何を許すか'
description: 'ShuviX のリモートアクセス向けセキュリティポリシーの書き方：network 主体とリクエストが運ぶすべての事実、四つの判定点（socket、request、channel、path）、scope（ShuviX のどの部分か、15 個）と access（read / write / admin）で書くきめ細かなルール、`inCidr`、`ask` が拒否になる理由、組み込みの `network-admission` とその置き換え方、よくある構成の書き方、インストール前に `shuvix policy check` で下書きを確かめる方法、そしてポリシーにできないこと（認証ではない、デバイス ID、SSH トンネル、エージェント経由の迂回）。'
tags: [shuvix, policy, security, network, remote-access]
status: stable
sources:
  - resource: https://github.com/wangdongdongc/ShuviX/blob/main/apps/desktop/src/main/frontend/network/policyGate.ts
    title: policyGate.ts —— 判定点とそれが報告する事実
  - resource: https://github.com/wangdongdongc/ShuviX/blob/main/packages/agent-runtime/src/security/builtinPolicies/md/network-admission.md
    title: network-admission.md —— 組み込みの受け入れポリシー
  - resource: https://github.com/wangdongdongc/ShuviX/blob/main/apps/desktop/src/shared/channelAccess.ts
    title: channelAccess.ts —— 各チャネルの scope とアクセス区分、キーで決まる設定項目
---

# リモートアクセスのポリシー

**リモートアクセス**（設定 → 一般 → ネットワークアクセス、または `shuvix --headless`）では、ブラウザーが
ネットワーク越しに ShuviX を使えます —— このコンピューターで ShuviX ができることはすべて、しかも**パスワードなし**で。
ShuviX 自身が行うのは固定の三つのチェックだけです：送信元がプライベートネットワーク上（またはこのコンピューター）で
あること、`Host` ヘッダーが IP アドレスか `localhost` と ShuviX のポートであること、WebSocket が ShuviX 自身の
配信したページから来ること。**それ以外はすべてセキュリティポリシー**で、エージェント向けのゲートと同じポリシー
ファイルに書きます（完全な書式は `policy-md` エントリー）。ほかのアクセス制御はなく、ポリシーがなければ制限もありません。

ShuviX が同梱するネットワークポリシーは一つ、`network-admission` だけです：**このコンピューターだけが接続できます**。
ほかのデバイスを入れるには、これを置き換えます。

## ユーザーとの進め方

ユーザーにリモートアクセスの設定を頼まれたら：

1. 必要なことを一度にまとめて聞きます：どのデバイスが接続するか（スマートフォン、ノート PC、ネットワーク全体？）、
   どうやって —— 同じローカルネットワーク、SSH トンネル、VPN；それぞれが何をする必要があるか —— どの部分に触れて
   よいか（セッション、ファイル、ターミナル、設定……、「scope と access」を参照）と、それぞれをどこまで（見るだけ、
   変える、管理する）；各デバイスをどう見分けるか —— アドレス、ネットワーク、デバイス ID（後述）。アドレスを推測しないこと。
2. まず**作業ディレクトリに下書き**を書きます。ファイル名はインストール後と同じ `network-admission.md`（**同じ名前**で
   ないと組み込みを置き換えられません。`deny` はすべての allow に勝つので、別のポリシーを足しても緩められない）。追加の
   制限は同じファイルにも、別のポリシーにも書けます。`~/.shuvix/policies/` に直接書かないこと：そこのポリシーは数秒で
   効き、間違った受け入れポリシーはユーザーがいまあなたと話しているデバイスをその場で切断します。`write` の結果は、
   ファイルが解析できたかとパーサーの警告を伝えます。
3. **下書きを確かめます**：`shuvix policy check network-admission.md`（bash）。インストールした場合と同じに判定し、
   表を出します —— このコンピューター、接続中と最近拒否されたデバイス、外部のアドレス × ページ / 読み / 書き / 管理 ——
   拒否されたセルにはどのルールかが付きます。**すべての行**をユーザーの要望と照らし合わせます。ルールを scope で
   書いたときは `--scopes` も付けます：scope ごとに一行、デバイスごとに一列で、セルは read / write / admin それぞれの
   結果です（その段階のすべての呼び出しを判定）—— 各セルを「このデバイスはどの部分に、どこまで触れてよいか」という
   ユーザーの言葉と照らし合わせます。一台だけなら `--from <ip>`（または `--device <id>`）を付けます。表にないもの（まだ
   現れていないデバイス、特定のチャネル、ある設定、ファイルのパス）は一つずつ確かめます：
   `shuvix policy check network-admission.md --from 192.168.1.23 --channel agent:prompt --expect allow`
   （デバイスで見分けるなら `--device <id>`。ほかに `--setting <key>`、`--page`、`--read`、`--write`）。すべての行、
   すべてのセル、すべての期待が合うまで**ルール**を直します。このコンピューターは常に `allow` のままにします。
   `shuvix policy check --help` が全オプションを示します。
4. インストール：同じ内容を `~/.shuvix/policies/network-admission.md` に書き（ほかのポリシーファイルはその隣に）、
   ファイルなしでもう一度 `shuvix policy check` を実行して、いま有効なものを確かめます。
5. 各ルールを平易な言葉で説明し、何を**防げない**か（最後の二つの節）を伝え、確かめ方（「確認」）を教えます。

ポリシーにパスワードやトークンを書かないこと、そして結果が「安全」だと言わないこと：これは認証のないアクセス制御です。

## リクエスト文書

ネットワークの判定はすべて `subject.kind` が `network` のリクエストです。主体の固定フィールドに加えて、ネットワーク
主体は次の属性を持ちます —— **どの判定でもすべて揃っており**、まだ分からないものは空です（socket の判定時には
ヘッダーがまだない）：

| `subject.` 属性 | 型     | 意味                                                                                 | 信頼できるか                                 |
| --------------- | ------ | ------------------------------------------------------------------------------------ | -------------------------------------------- |
| `address`       | string | 送信元の IP アドレス（IPv4 射影の IPv6 は IPv4 で書く）                              | はい —— TCP 接続から                         |
| `port`          | int    | 送信元のポート                                                                       | はい                                         |
| `localAddress`  | string | 接続が入ってきた、このコンピューターのアドレス                                       | はい                                         |
| `localPort`     | int    | ShuviX のポート                                                                      | はい                                         |
| `family`        | string | `ipv4` または `ipv6`                                                                 | はい                                         |
| `interface`     | string | `localAddress` が属するネットワークインターフェース（`en0`、`eth1`）；不明なら `''`  | はい                                         |
| `headers`       | map    | すべてのリクエストヘッダー、名前は小文字；同名の複数値は `, ` で連結；HTTP 前は `{}` | **いいえ** —— ブラウザー（や誰か）が書くもの |
| `cookies`       | map    | リクエストの cookie                                                                  | **いいえ**                                   |
| `device`        | string | ブラウザーのデバイス ID（後述）；まだ持っていなければ `''`                           | **いいえ** —— 「デバイス ID」参照            |
| `userAgent`     | string | `User-Agent` ヘッダー                                                                | **いいえ**                                   |
| `connection`    | string | channel とファイルチャネルの判定ではその WebSocket 接続（`ws:7`）；それ以外は `''`   | はい                                         |

`env.host` は `desktop`（ヘッドレスでも）。`vars` には `policy-md` エントリーの表のうちセッションに属さない
ホスト変数 —— `home`、`shuvixConfigDirs`、`botsDir`、`skillsDirs` …… —— があり、セッションの権限表
（`aclRead` / `aclWrite`）はありません。

### 四つの判定点

| いつ                                           | `object.type` | `action`         | オブジェクトの属性                                                                                       | 拒否されたとき                                  |
| ---------------------------------------------- | ------------- | ---------------- | -------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| TCP 接続が開いた直後、HTTP を読む前            | `socket`      | `connect`        | なし                                                                                                     | 何も返さずに接続を閉じる                        |
| すべての HTTP リクエスト（アップグレード含む） | `request` | `request` | `method`、`path`（URL パス）、`query`（map、同名は最初の値）、`route`（後述）、`scope`、`access` | HTTP 403、本文はルールの `prompt` とデバイス ID |
| WebSocket 上のすべての呼び出し | `channel` | `invoke` | `channel`（`agent:prompt`）、`group`（`agent`）、`scope`、`kind`（`invoke` / `send`）、`access`、`size`、`args` | 呼び出しはコード `denied` と `prompt` で失敗 |
| ネットワークが読み書きするファイル | `path` | `read` / `write` | `path`（実際に行き着く場所）、`requestedPath`、`displayPath`、`scope`（常に `files`）、`access`（`action` と同じ）；`tool.name` / `tool.operation` は後述 | 403、またはファイルを表示しない / 保存しない |

`route` は `page`（`/`）、`asset`（ページのスクリプトとスタイル）、`media`、`preview`、`download`（ファイル
ルート）、`lib`（グラフのライブラリ）、`widget`（`/w/…`）、`socket`（どのページも行う `/ws` のアップグレード）の
いずれかです。`path` の判定はファイルルート（`tool.name` が `files`、`tool.operation` が `media` / `preview` /
`download`）と、ディスク上の任意のファイルを読み書きできるチャネル —— `files:read` / `files:write`（`files`、
`read` / `write`）と `fs:listDirectories`（`fs`、`listDirectories`）—— で行われます。ShuviX 自身はこれらの
パスを制限しません。

`scope` と `access` は次の節で説明します。`args` は送られてきたままの引数（リスト）です。これを読むとルールが ShuviX の
内部 API に縛られ、内部 API はバージョンで変わります —— ルールは `scope` と `access` に書き、例外を作るときだけ
`channel` を名指してください。

## scope と access：どの部分を、どこまで

socket 以外のすべての判定で、オブジェクトは二つの事実を持ちます：`object.scope` —— このリクエストが ShuviX の**どの部分**
に関わるか；`object.access` —— **どこまで**やるか。きめ細かなルールはこの二つに書きます：「このデバイスは sessions だけ」
「preferences は変えてよい、security は見るだけ」。後のバージョンで増えたチャネルもどこかの scope・どこかの段階に入り、
こうしたルールの対象になります。チャネル名の一覧ではそれを取りこぼします。

### 15 個の scope

scope は**それが何を扱うか**で分けたもので、設定画面のどのタブにあるかではありません（「一般」には外観、既定のモデル、
コマンド分類器、ネットワークアクセスが同居しています）。

| `scope` | 何を扱うか | 画面のどこか |
| --- | --- | --- |
| `app` | ページを開くたびに必要な読み取り（設定値、項目の説明、バージョン）とアプリの外枠（ウィンドウ、右クリックメニュー、通知、ピン留めチャット） | どこでも |
| `sessions` | セッションの一覧と内容、エージェントとの対話（送信、中止、確認カードへの回答）、サブセッション、バックグラウンドタスク、スラッシュコマンド、カレンダーと日報 | サイドバーのセッション、チャット、カレンダー |
| `projects` | プロジェクトの作成、変更、削除、一覧 —— プロジェクトは環境変数を持つので、一覧は `admin` | サイドバーのプロジェクト、プロジェクト設定 |
| `files` | 作業ディレクトリのファイルの一覧、読み、書き、プレビュー、ダウンロード、ノートブック、アーティファクト、フォルダーの閲覧 | ファイルツリー、プレビュー、ノートブック |
| `terminal` | ターミナル（`write` の段階だけ） | 下部のターミナルパネル |
| `browser` | アプリ内ブラウザー：タブ、閲覧、スクリーンショット、DevTools、サイトデータと Cookie、証明書の例外；その設定項目 | アプリ内ブラウザー、設定 → MCP → browser |
| `widgets` | ウィジェットの一覧、起動、名前の変更、アーカイブ、削除、エクスポート、独立ウィンドウ | サイドバーのウィジェット、設定 → アーカイブ |
| `knowledge` | ナレッジベースとエントリーの一覧、作成、オープン | サイドバーのナレッジ、入力欄の @ |
| `agents` | エージェントのプロファイルと Bot、既定のエージェント | サイドバーのエージェント / Bots |
| `extensions` | ツールの一覧、MCP サーバー、スキル、データベース接続、Chrome 拡張 | 設定 → LLM ツール / MCP、サイドバーのスキル |
| `models` | プロバイダー（API キーとサブスクリプションのサインインを含む）、モデル、既定のモデルと思考レベル；`read` はキーを含まないモデル一覧だけ | 設定 → プロバイダー、一般 → 既定のモデル、入力欄のモデル選択 |
| `security` | セキュリティポリシー、hooks（自動レビューは hook）、セッションの権限表、コマンドのサンドボックス、コマンド分類器、リモートアクセスそのもの | サイドバーのポリシー / Hooks、設定 → 一般 → ネットワークアクセス、LLM ツール → bash |
| `preferences` | 外観、言語、文字サイズ、拡大率、通知のオンオフ、音声と TTS | 設定 → 一般（外観の部分）、音声 |
| `telegram` | Telegram Bot の登録と変更・削除 | 設定 → Telegram Bot |
| `system` | アプリのアップデート、設定のインポート / エクスポート、モニターのログ（LLM リクエスト、分類器、アプリのログ） | 設定 → 情報、モニター |

各 scope に入るチャネル、HTTP ルート、設定項目は `network-channels` エントリーに一つずつ載っています。

### 三つの access

- `read` —— 見るだけ。秘密を含まず、副作用もない。
- `write` —— ユーザーのデータを変える、または何かを起こす：エージェントへの送信、セッションの作成・削除、ファイルの書き込み、
  ターミナル、テーマの変更。
- `admin` —— ShuviX 自身を変える（セキュリティポリシー、hooks、エージェント、プロバイダー、MCP、ネットワークアクセス、
  アップデート……）、または秘密を返す（API キー、プロジェクトの環境変数、Cookie）。

三つは種類であって、**上の段階が下を含むわけではありません**：`admin` を許しても `write` は許されず、段階ごとに別に判定
されます。HTTP リクエスト：GET / HEAD / OPTIONS は `read`、ほかのメソッドは `write`。ファイルの読み書き（`path`）の
`access` はその `action` です。

### 呼び出しの中身で決まる二つ

- **`settings:set`（設定を一つ変える）は変えるキーで決まります**：見た目と個人の好みにだけ関わるものは `write`、
  エージェントにできること、誰が支払うか、どこへ接続するか、誰が入れるかを変えるものは `admin`。

  | キー | `scope` | `access` |
  | --- | --- | --- |
  | テーマ、言語、文字サイズ、拡大率（`general.theme`、`general.language`……）、`appearance.*`、`notification.*`、`voice.*` | `preferences` | `write` |
  | `browser.*`（アドレスバーの検索エンジンなど） | `browser` | `write` |
  | `tool.browser.*`（アプリ内ブラウザーで証明書エラーを無視する） | `browser` | `admin` |
  | 既定のプロバイダー、モデル、思考レベル | `models` | `admin` |
  | 既定のエージェント | `agents` | `admin` |
  | `sandbox.*`、コマンド分類器（`general.classifierProvider` / `general.classifierModel`）、`network.*` | `security` | `admin` |
  | `httpLog.*`、`updates.*`、および知られていないキー | `system` | `admin` |

  完全な表は `network-channels` エントリーにあります。一つ確かめるには：
  `shuvix policy check <下書き> --from <ip> --setting general.theme`。
- **確認カードに「許可して記憶」で答える**（`agent:respondToInput`）とセッションの権限表に行が加わるので、`security` +
  `admin` として判定されます。記憶しないときは `sessions` + `write` です。

### ルールを書くとき

- `object.scope` / `object.access` を読むルールには `object.type: [request, channel, path]`（またはその一部）を書いて
  ください：socket の判定点にはまだこの二つの事実がなく、読むとエラーになり、失敗した `deny` は一致として扱われます。
- **`app` の `read` を拒否しないこと**：それがないとページが開きません。デバイスを丸ごと入れないなら、その `request`
  （受け入れ）を拒否します。
- `deny` の `match` では：`object.access != 'read'` は「何かを変えるもの」を拒否し、`!(object.scope in [...])` は
  「この部分以外」を拒否します。`object.access != 'read' && !(object.scope in [...])` は「この部分は変えてよく、ほかは
  見るだけ」になります。
- `object.group`（`agent`、`provider` などチャネルの技術的なグループ）と `object.channel` もあり、個別の例外に使えます。
  グループはバージョンで変わるので、ルールの本体は scope に書いてください。

## ネットワークの判定での効果

ネットワークの判定点では誰にも確認できません。エンジンはエージェントのときと同じように決着させ（deny > force-ask >
force-allow > ask > allow；ルールなし = allow）、`ask` または `force-ask` に決まったリクエストを**拒否**として扱います。
`deny` と書いてください —— `subject.kind` が `network` だけの `ask` ルールにはパーサーが警告を出します。`force-allow` は
他と同じく `ask` に勝ちます。

`match` の評価が失敗したルールは `deny` では一致扱い（フェイルセーフ）なので、雑な式はすべてを拒否します。よくある
原因はキーの欠落です：リクエストにそのヘッダーがないと `subject.headers['x-real-ip']` はエラーになります ——
`'x-real-ip' in subject.headers && …` と書いてください。`has()` はインデックスの後では使えません
（`has(object.args[0].x)` はエラー）。

## 評価できるルールを書く

`match` の評価に失敗した `deny` は、その種類の**すべての**リクエストを拒否します —— このコンピューター自身も。
三つの習慣で防げます：

- **このコンピューターを先頭に置き、`&&` でつなぐ：** `!inCidr(subject.address, ['127.0.0.0/8', '::1']) && …`。
  このコンピューターでは左辺が偽なので残りは評価されず、書き間違いがあっても締め出されません。
- **`lets` から見えるのは `vars` だけ。** `subject`、`object`、`action`、`tool`、`env` を読む let はファイル全体を
  不正にします。定数（`phone: "'Xq3…'"`、ネットワークの一覧）は `lets` に、リクエストについての条件はルールの
  `match` に書きます。
- **`write` の結果を読む。** `network` 主体のルールごとに、パーサーはそのルールが対象とする各種類のサンプル
  リクエストで `match` を試算します。「the match fails on a sample … request」と出たら、そのルールは対象をすべて
  拒否します。終える前に直してください。

## `inCidr(ip, cidrs)`

`ip` が `cidrs` —— 文字列、または `a.b.c.d/n`、`x::/n`、単一アドレスのリスト —— のいずれかに含まれるとき真。IPv4
射影の IPv6 は IPv4 として扱い、正しくない項目は決して一致せず、`ip` がアドレスでないときも一致しません。

```
inCidr(subject.address, ['127.0.0.0/8', '::1'])                  # このコンピューター
inCidr(subject.address, ['192.168.1.0/24', '10.8.0.0/16'])       # 二つのネットワーク
inCidr(subject.address, '192.168.1.23')                          # 一つのアドレス
```

## 組み込みの `network-admission`

```yaml
shuvix-policy-scope:
  subject.kind: [network]
  object.type: [request]
shuvix-policy-rules:
  - effect: deny
    action: [request]
    match: "!inCidr(subject.address, ['127.0.0.0/8', '::1'])"
```

ほかのデバイスからの HTTP リクエストはすべて拒否され、相手には何をすればよいかを伝えるページが表示されます。SSH
トンネルは `127.0.0.1` から来るので通ります。同じ `name` のユーザーファイルで置き換えてください（サイドバーの
「上書きコピーを作成」で今のテキストを出発点として書き出せます）。解析に失敗した置き換えファイルは何も置き換えず ——
組み込みは拒否し続け —— サイドバーのセキュリティポリシーに琥珀色で表示されます。置き換えずに組み込みを無効にすると、
ローカルネットワーク上のすべてのデバイスが入れます。設定 → 一般 → ネットワークアクセスで、今どちらが有効かが
分かります。

## よくある構成の書き方

各ブロックは `~/.shuvix/policies/network-admission.md` の frontmatter です（`shuvix: policy v1` と
`name: network-admission` を加える）。このコンピューター（`127.0.0.0/8`、`::1`）は必ず残してください。

**一つまたは複数のネットワーク：**

```yaml
shuvix-policy-scope:
  subject.kind: [network]
  object.type: [request]
shuvix-policy-rules:
  - effect: deny
    action: [request]
    match: "!inCidr(subject.address, ['127.0.0.0/8', '::1', '192.168.1.0/24', '10.8.0.0/16'])"
    prompt: このコンピューターと、自宅と VPN のネットワーク上のデバイスだけが接続できます。
```

**特定のデバイス。** ブラウザーは初めて来たとき、拒否されてもデバイス ID を受け取り、拒否のページにそれが表示されます
（`Device: …`）。設定 → ネットワークアクセスにも、接続中と最近拒否されたデバイスの ID が並びます。ユーザーに ID を
聞いてから：

```yaml
shuvix-policy-scope:
  subject.kind: [network]
  object.type: [request]
shuvix-policy-rules:
  - effect: deny
    action: [request]
    match: "!inCidr(subject.address, ['127.0.0.0/8', '::1']) && !(subject.device in ['Xq3…', 'Pb9…'])"
    prompt: このデバイスはリストにありません。持ち主にデバイス ID を追加してもらってください。
```

以下の各節は、受け入れのルールの後ろに足すルールです（同じ `shuvix-policy-rules` のリストに、または別のポリシーに）。
どれもまず `match` でデバイスを見分け、それから scope と access で判定します。

**読み取り専用のデバイス** —— 一つのルールで三つの判定点をまとめて押さえます：何かを変えるチャネル、ファイルの書き込み、
ウィジェットへの書き込みリクエスト：

```yaml
shuvix-policy-rules:
  - effect: deny
    subject.kind: [network]
    object.type: [request, channel, path]
    match: "inCidr(subject.address, '192.168.1.0/24') && object.access != 'read'"
    prompt: このデバイスは見ることしかできません。
```

ページは表示のためだけにいくつかの `read` 以外のチャネルを呼びます（セッションを開くときの `agent:getInfo` など）。
読み取り専用のデバイスでページがおかしいときは、「最近拒否されたもの」を見て、そのチャネル名を `match` で除外して
ください（`&& !(object.channel in ['…'])`）。プロジェクトの一覧（`projects` の `admin`）は環境変数の値を持っています：
その値を見せてよい場合にだけ許してください。

**エージェントと話すことしかできないスマートフォン** —— `app` と `sessions` だけ：

```yaml
shuvix-policy-rules:
  - effect: deny
    subject.kind: [network]
    object.type: [request, channel, path]
    match: "inCidr(subject.address, '192.168.1.23') && !(object.scope in ['app', 'sessions'])"
    prompt: このスマートフォンはエージェントと話すことしかできません。
```

ファイル、ターミナル、設定は見えませんが、「エージェントと話せる」こと自体が大きな権限です（「ポリシーにできないこと」
を参照）。入力欄でモデルを切り替えさせたいなら、`models` の `read`（モデル一覧だけ）も許します：`match` の後半を
`!(object.scope in ['app', 'sessions'] || (object.scope == 'models' && object.access == 'read'))` にします。

**一部は変えてよく、ほかは見るだけ** —— 家のタブレットはセッション、ファイル、ナレッジを使え、外観も変えられるが、
それ以外は見るだけ：

```yaml
shuvix-policy-rules:
  - effect: deny
    subject.kind: [network]
    object.type: [request, channel, path]
    match: "inCidr(subject.address, '192.168.1.0/24') && object.access != 'read' && !(object.scope in ['app', 'sessions', 'files', 'knowledge', 'preferences'])"
    prompt: このデバイスはここでは見ることしかできません。
```

**制限付きのデバイスにルールを変えさせない。** 完全には信頼しないデバイスには、`security` の部分と `admin` のすべて、
**そして** ShuviX 自身のフォルダーへのファイル書き込みを拒否してください —— さもないと `files:write` 経由でこのポリシー
自体を書き換えられます（ファイルの書き込みは `files` であって `security` ではありません）：

```yaml
- effect: deny
  subject.kind: [network]
  object.type: [request, channel]
  match: "!inCidr(subject.address, ['127.0.0.0/8', '::1']) && (object.scope == 'security' || object.access == 'admin')"
  prompt: セキュリティ設定と ShuviX の設定を変えられるのはこのコンピューターだけです。
- effect: deny
  subject.kind: [network]
  object.type: [path]
  action: [write]
  match: "!inCidr(subject.address, ['127.0.0.0/8', '::1']) && (inDir(object.path, vars.shuvixConfigDirs) || inDir(object.path, vars.botsDir))"
```

`object.scope == 'security'` は見ることまで拒否します（ポリシーの一覧、権限表）。変更だけを拒否するなら
`object.scope == 'security' && object.access != 'read'` と書きます。

**ユーザーが求めたとおりに書き、足しも削りもしない。** ユーザーが言っていない制限を加えないでください：「何でもできる」
と言われたデバイスは制限付きのデバイスではないので、上の二つのルールを足さない（`admin` も拒否しない）。デバイス ID で
見分けるよう言われていなければ、デバイス ID を求めない。使ってよいと言われた部分（セッション、ターミナル、モデルの選択……）
はどれも拒否しない。リスクが気になるならルールを説明するときに伝えてユーザーに決めてもらい、ルールにはユーザーが望むこと
だけを書きます。

**一つのフォルダーのファイルだけ：** その外の `path` の読み取りを拒否します（`!inDir(object.path, [vars.home + '/Shared'])`）。
ほかの場所のファイルのプレビューも使えなくなります。

## ポリシーにできないこと

- **認証ではありません。** 同じネットワーク上なら誰でもアドレスを使えます。ヘッダー、cookie、user agent は送信元が
  好きに書けます。**デバイス ID** は ShuviX が cookie（`shuvix_device`、同じアドレスへのリクエストに自動で付く）で
  各ブラウザーに渡すランダムな値です：ブラウザーを見分けられますが、通信（平文の HTTP）を見られる人やそのブラウザーを
  使える人は値を写し取れます。サイトデータを消したりプライベートウィンドウを使ったりすると変わり、同じブラウザーでも
  `127.0.0.1` とローカルネットワークのアドレスでは別の ID になります。
- **SSH トンネルはこのコンピューターに見えます**：トンネル経由の接続はすべて `127.0.0.1` から来るので、アドレスでは
  区別できません。
- **エージェントは迂回路になります。** `agent:prompt`（またはエージェントの確認カードに答える `agent:respondToInput`）を
  呼べるデバイスは、エージェント自身のポリシーが許すことなら何でもエージェントにさせられます。エージェント側の
  ポリシーは、メッセージをどのデバイスが送ったかを知りません。「エージェントと話せる」は完全な操作として扱ってください。
- **ポリシーはリクエストを通すかどうかを決めるだけで、返す内容を絞りません。** `session:list` を許されたデバイスは
  すべてのセッションを見られます。ページを開けるデバイスはすべての設定値を読めます（`settings:getAll` は `app` に
  あります。設定表に秘密はありません）。
- パブリックアドレスは決して接続できません（固定のプライベートネットワークのチェックが先）。Tailscale の
  `100.64.0.0/10` のような VPN の範囲も同じです。

## 確認

- `shuvix policy check [<ファイル>]`（「ユーザーとの進め方」を参照）：誰が入れて、それぞれが何をできるかの表。実際の
  リクエストと同じエンジン、同じポリシーで判定します。`ERROR` のセルは評価に失敗するルールで（表の下に理由）、そうした
  リクエストをすべて拒否します。`--scopes` を付けると scope × デバイスの行列になります：`r` / `w` / `a` はその段階の
  呼び出しがすべて許可、`-` はすべて拒否、`~` は一部が拒否（拒否された呼び出しは表の下に）、`.` はその scope にその段階が
  ない、`E` は評価に失敗したルールがある、という意味です。
- 設定 → 一般 → ネットワークアクセスには、`network-admission` の状態、接続中のブラウザーとそのデバイス ID、そして
  **最近拒否されたもの** —— 何が、どの scope で、どこから、どのルールで —— が表示されます。ポリシーが効いているか見るいちばん早い方法です。
- そのデバイスでアドレスを開くと、拒否されたリクエストにはルールの `prompt`、デバイス ID、アドレスが表示されます。
- 変更は数秒以内に効き、新しいルールが拒否する接続中のブラウザーは切断されます。
