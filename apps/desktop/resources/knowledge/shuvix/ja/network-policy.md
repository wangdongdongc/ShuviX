---
shuvix: okf v0.2
type: Guide
title: 'リモートアクセスのポリシー —— 誰が接続でき、各デバイスに何を許すか'
description: 'ShuviX のリモートアクセス向けセキュリティポリシーの書き方：network 主体とリクエストが運ぶすべての事実、四つの判定点（socket、request、channel、path）、`inCidr`、`ask` が拒否になる理由、組み込みの `network-admission` とその置き換え方、よくある構成の書き方、インストール前に `shuvix policy check` で下書きを確かめる方法、そしてポリシーにできないこと（認証ではない、デバイス ID、SSH トンネル、エージェント経由の迂回）。'
tags: [shuvix, policy, security, network, remote-access]
status: stable
sources:
  - resource: https://github.com/wangdongdongc/ShuviX/blob/main/apps/desktop/src/main/frontend/network/policyGate.ts
    title: policyGate.ts —— 判定点とそれが報告する事実
  - resource: https://github.com/wangdongdongc/ShuviX/blob/main/packages/agent-runtime/src/security/builtinPolicies/md/network-admission.md
    title: network-admission.md —— 組み込みの受け入れポリシー
  - resource: https://github.com/wangdongdongc/ShuviX/blob/main/apps/desktop/src/shared/channelAccess.ts
    title: channelAccess.ts —— 各チャネルのアクセス区分
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
   どうやって —— 同じローカルネットワーク、SSH トンネル、VPN；それぞれが何をする必要があるか —— 見るだけ、
   エージェントと話す、設定を変える；各デバイスをどう見分けるか —— アドレス、ネットワーク、デバイス ID（後述）。
   アドレスを推測しないこと。
2. まず**作業ディレクトリに下書き**を書きます。ファイル名はインストール後と同じ `network-admission.md`（**同じ名前**で
   ないと組み込みを置き換えられません。`deny` はすべての allow に勝つので、別のポリシーを足しても緩められない）。追加の
   制限は同じファイルにも、別のポリシーにも書けます。`~/.shuvix/policies/` に直接書かないこと：そこのポリシーは数秒で
   効き、間違った受け入れポリシーはユーザーがいまあなたと話しているデバイスをその場で切断します。`write` の結果は、
   ファイルが解析できたかとパーサーの警告を伝えます。
3. **下書きを確かめます**：`shuvix policy check network-admission.md`（bash）。インストールした場合と同じに判定し、
   表を出します —— このコンピューター、接続中と最近拒否されたデバイス、外部のアドレス × ページ / 読み / 書き / 管理 ——
   拒否されたセルにはどのルールかが付きます。**すべての行**をユーザーの要望と照らし合わせます。表にないもの（まだ
   現れていないデバイス、特定のチャネル、ファイルのパス）は一つずつ確かめます：
   `shuvix policy check network-admission.md --from 192.168.1.23 --channel session:prompt --expect allow`
   （デバイスで見分けるなら `--device <id>`。ほかに `--page`、`--read`、`--write`）。すべての行と期待が合うまで
   **ルール**を直します。このコンピューターは常に `allow` のままにします。`shuvix policy check --help` が全オプションを示します。
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
| すべての HTTP リクエスト（アップグレード含む） | `request`     | `request`        | `method`、`path`（URL パス）、`query`（map、同名は最初の値）、`route`（後述）                            | HTTP 403、本文はルールの `prompt` とデバイス ID |
| WebSocket 上のすべての呼び出し                 | `channel`     | `invoke`         | `channel`（`session:list`）、`group`（`session`）、`kind`（`invoke` / `send`）、`access`、`size`、`args` | 呼び出しはコード `denied` と `prompt` で失敗    |
| ネットワークが読み書きするファイル             | `path`        | `read` / `write` | `path`（実際に行き着く場所）、`requestedPath`、`displayPath`；`tool.name` / `tool.operation` は後述      | 403、またはファイルを表示しない / 保存しない    |

`route` は `page`（`/`）、`asset`（ページのスクリプトとスタイル）、`media`、`preview`、`download`（ファイル
ルート）、`lib`（グラフのライブラリ）、`widget`（`/w/…`）、`socket`（どのページも行う `/ws` のアップグレード）の
いずれかです。`path` の判定はファイルルート（`tool.name` が `files`、`tool.operation` が `media` / `preview` /
`download`）と、ディスク上の任意のファイルを読み書きできるチャネル —— `files:read` / `files:write`（`files`、
`read` / `write`）と `fs:listDirectories`（`fs`、`listDirectories`）—— で行われます。ShuviX 自身はこれらの
パスを制限しません。

**`access`** はすべてのチャネルを三つに分けます：`read`（データを読むだけで秘密を含まない）、`write`（ユーザーの
データを変える、または何かを起こす —— エージェントへのメッセージ送信、セッションの削除、ファイルの書き込み、
ターミナル）、`admin`（ShuviX 自身を変える —— ポリシー、hooks、エージェント、設定、モデルプロバイダー、ネットワーク
アクセス、アップデート —— または API キーのような秘密を返す）。全チャネルとその区分は `network-channels` エントリーに
あります。`args` は送られてきたままの引数（リスト）です。これを読むとルールが ShuviX の内部 API に縛られ、内部 API は
バージョンで変わります —— できるだけ `channel`、`group`、`access` を使ってください。

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

**読み取り専用のデバイス** —— 二つ目のルールで `read` 以外のチャネルと、ファイルの書き込みを拒否します：

```yaml
shuvix-policy-rules:
  - effect: deny
    subject.kind: [network]
    object.type: [channel]
    match: "inCidr(subject.address, '192.168.1.0/24') && object.access != 'read'"
    prompt: このデバイスは見ることしかできません。
  - effect: deny
    subject.kind: [network]
    object.type: [path]
    action: [write]
    match: "inCidr(subject.address, '192.168.1.0/24')"
```

判定は `object.access` に書いてください：グループを名指す（`object.group in ['session', …]`）のに
`&& object.access != 'read'` を付けない `deny` は、そのグループの読み取りまで拒否します。ページは表示のためだけに
いくつかの `read` 以外のチャネルを呼びます。読み取り専用のデバイスでページがおかしいときは、
「最近拒否されたもの」を見て、そのチャネル名を `match` で除外してください（`&& !(object.channel in ['…'])`）。
`project:list`、`project:listArchived`、`project:getById` は `admin` です。プロジェクトは環境変数（機密指定のものも
含む）を持っているからです：その値を見せてよい場合にだけ除外してください。

**制限付きのデバイスにルールを変えさせない。** 完全には信頼しないデバイスには、`admin` チャネル**と** ShuviX 自身の
フォルダーへのファイル書き込みを拒否してください —— さもないと、このポリシー自体を書き換えられます：

```yaml
- effect: deny
  subject.kind: [network]
  object.type: [channel]
  match: "!inCidr(subject.address, ['127.0.0.0/8', '::1']) && object.access == 'admin'"
- effect: deny
  subject.kind: [network]
  object.type: [path]
  action: [write]
  match: "!inCidr(subject.address, ['127.0.0.0/8', '::1']) && (inDir(object.path, vars.shuvixConfigDirs) || inDir(object.path, vars.botsDir))"
```

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
  すべてのセッションを見られます。
- パブリックアドレスは決して接続できません（固定のプライベートネットワークのチェックが先）。Tailscale の
  `100.64.0.0/10` のような VPN の範囲も同じです。

## 確認

- `shuvix policy check [<ファイル>]`（「ユーザーとの進め方」を参照）：誰が入れて、それぞれが何をできるかの表。実際の
  リクエストと同じエンジン、同じポリシーで判定します。`ERROR` のセルは評価に失敗するルールで（表の下に理由）、そうした
  リクエストをすべて拒否します。
- 設定 → 一般 → ネットワークアクセスには、`network-admission` の状態、接続中のブラウザーとそのデバイス ID、そして
  **最近拒否されたもの** —— 何が、どこから、どのルールで —— が表示されます。ポリシーが効いているか見るいちばん早い方法です。
- そのデバイスでアドレスを開くと、拒否されたリクエストにはルールの `prompt`、デバイス ID、アドレスが表示されます。
- 変更は数秒以内に効き、新しいルールが拒否する接続中のブラウザーは切断されます。
