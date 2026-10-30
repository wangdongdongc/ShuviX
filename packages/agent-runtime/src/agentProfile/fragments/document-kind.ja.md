## このドキュメントは何か

<!-- shuvix:agent-start -->
このドキュメントは ShuviX の agents フォルダにある**エージェントプロファイル**（`shuvix: agent v1`）です。frontmatter がエージェントのツール、モデル、コンテキストを決め（`shuvix-tools`、`shuvix-model`、`shuvix-instruction-files` …）、本文がそのエージェントのシステムプロンプトのすべてです。ShuviX はこのファイルからエージェントを作るたびに読み直すので、保存した変更はその後に作られるエージェントに効きます。動作中のエージェントは起動時の版のままです。`name` が組み込みプロファイル（work、chat、coding、notebook …）と同じファイルは、その組み込みを置き換えます。

<!-- shuvix:manual-start -->
完全な仕様 —— すべてのキー、プレースホルダー、ファイルが無効になる条件、例 —— は ShuviX マニュアルの項目 `<<manual>>agent-md.md` です。自信のない箇所を変える前にそれを `read` し、他のファイルから形式を推測しないこと。
<!-- shuvix:manual-end -->
<!-- shuvix:agent-end -->

<!-- shuvix:bot-start -->
このドキュメントは **bot ファイル**（`shuvix: bot v2`）です。本文はその bot の人格と記憶で、その bot とのすべての会話のシステムプロンプトの一部になり、bot 自身も記憶を保つためにこれを編集します。frontmatter にあるのは `name`、`description`、`shuvix-displayName` だけで、bot のツールとモデルはこのファイルではなく ShuviX が決めます。保存した変更はその bot の各会話の次のメッセージから効きます。`name` を変えると、それらの会話は新しい名前に移ります。

<!-- shuvix:manual-start -->
完全な仕様は ShuviX マニュアルの項目 `<<manual>>bot-md.md` です。自信のない箇所を変える前にそれを `read` し、他のファイルから形式を推測しないこと。
<!-- shuvix:manual-end -->
<!-- shuvix:bot-end -->

<!-- shuvix:policy-start -->
このドキュメントは**セキュリティポリシー**（`shuvix: policy v1`）です。ShuviX はエージェントのあらゆる操作 —— ファイルの読み書き、コマンドの実行、別のセッションやウィジェットの利用 —— をすべてのポリシーと照らし合わせます。条件が一致したポリシーは許可、確認、拒否のいずれかで答え、確認はまず自動レビューに回り、そこから必要に応じてユーザーに届きます。どのポリシーにも一致しない操作は許可されます。ファイルは保存されて解析できた時点で効くので、書き間違いは保護を黙って外すことも、ある種類の操作をすべて止めることもあります。`name` が組み込みポリシーと同じファイルは、その組み込みを置き換えます。

<!-- shuvix:manual-start -->
完全な仕様 —— ルールが見るリクエスト文書、条件キー、CEL `match`、効果とその優先順位、ファイルが無効になる条件、組み込みポリシー —— は ShuviX マニュアルの項目 `<<manual>>policy-md.md` です。リモートアクセスのルール（`subject.kind: network`）は `<<manual>>network-policy.md`、自動マスキングは `<<manual>>redaction.md` にあります。自信のない箇所を変える前に該当する項目を `read` し、他のファイルから形式を推測しないこと。
<!-- shuvix:manual-end -->
<!-- shuvix:policy-end -->

<!-- shuvix:hook-start -->
このドキュメントは **hook**（`shuvix: hook v1`）です。`shuvix-hook-on` に挙げたトリガーポイントが発火し、その CEL `when` が成り立つと、ShuviX は `shuvix-hook-agent` で指定したエージェントを、この本文をタスクとし、イベントを添えて実行します。観察型のトリガーではバックグラウンドで動き、その答えは使われません。判断型のトリガー `permission.request` では、その答えが承認リクエストを決めます。ShuviX はトリガーのたびにファイルを読み直すので、保存した変更は次のトリガーから効きます。`name` が組み込み hook と同じファイルは、その組み込みを置き換えます。

<!-- shuvix:manual-start -->
完全な仕様 —— キー、トリガーポイントとそのイベント、`when`、組み込み hook —— は ShuviX マニュアルの項目 `<<manual>>hook-md.md` です。自信のない箇所を変える前にそれを `read` し、他のファイルから形式を推測しないこと。
<!-- shuvix:manual-end -->
<!-- shuvix:hook-end -->

<!-- shuvix:skill-start -->
このドキュメントは**スキルの `SKILL.md`**（Claude Code も使う Agent Skills 形式）です。`name` はスキルの識別子で、オン・オフのスイッチもこの名前に結び付いています。`description` はエージェントがスキルを読み込むか決める前に見るすべてで、本文は読み込んだ後に読む内容です。`SKILL.md` の隣のファイルは本文が参照する資料です。スキルツールを持つエージェントは有効なスキルをすべて受け取り、保存した変更はその後に作られるエージェントに効きます。

<!-- shuvix:manual-start -->
完全な仕様は ShuviX マニュアルの項目 `<<manual>>skills.md` です。自信のない箇所を変える前にそれを `read` し、他のファイルから形式を推測しないこと。
<!-- shuvix:manual-end -->
<!-- shuvix:skill-end -->

<!-- shuvix:knowledge-start -->
このドキュメントは**ナレッジベースのノート**です。エージェントは `knowledge` ツールの `search` でノートを探しますが、照合するのはタイトル、説明、タグ、見出しで、本文ではありません。だからノートが見つかるかどうかはこれらで決まります。ShuviX がチェックした項目は OKF の frontmatter（`shuvix: okf v0.2`、`type`、`title`、`description`、`status`、`sources` …）を持ちます。`generated` と `verified` は ShuviX が付けるもので、手で書いてはいけません。

<!-- shuvix:manual-start -->
完全な仕様は ShuviX マニュアルの項目 `<<manual>>knowledge-entry.md` です。frontmatter を変える前にそれを `read` し、他のノートから形式を推測しないこと。
<!-- shuvix:manual-end -->
<!-- shuvix:knowledge-end -->

<!-- shuvix:checked-start -->
変更するそばから ShuviX がファイルをチェックします。`doc_edit` / `doc_insert` の結果はまだ解析できるかを伝え、`doc_read` はいま解析できるかを伝えます。解析できないファイルは直るまで効きません。ユーザーはドキュメントのプロパティカードで同じ判定を見ています。
<!-- shuvix:checked-end -->
