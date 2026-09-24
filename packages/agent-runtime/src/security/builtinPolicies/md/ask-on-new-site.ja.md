---
shuvix: policy v1
shuvix-builtin: true
name: ask-on-new-site
shuvix-displayName: Chrome で新しいサイトを使う前に確認
description: あなた自身の Chrome で、この会話でまだ使っていないサイトを開く・操作する前に確認する。
shuvix-policy-scope:
  subject.kind: [agent]
  object.type: [url]
shuvix-policy-rules:
  - effect: ask
    action: [navigate]
    match: object.browser == 'chrome' && object.scheme in ['http', 'https', 'blob'] && object.host != ''
    prompt: これはあなた自身の Chrome で、あなたのアカウントでログインしている —— エージェントはあなたとしてこのサイトを閲覧・操作できる。
---

**このポリシーの役割**：Chrome の ShuviX サイドパネルから動くエージェントが、サイトを開く、または
あるサイトを表示しているタブを読み取り・操作する前に、あなたに確認する —— サイト（ホスト）ごとに
会話ごと一回だけ。メッセージと一緒に送ったタブ（入力欄の上のチップ。既定ではこのタブ）のサイトは
すでに許可済み：タブを送ることが、そのタブについて尋ねることだから。エージェントが自分で開いた
タブや、ページが自分で移動した先の別サイトはこれに含まれない。

**カバーしないこと**：

- ShuviX アプリ内のブラウザーパネルには適用しない：そちらは普段のブラウザーとは別のログイン状態を持つ。
- どのサイトにも属さないページ —— 空白ページ、`data:` ページ、Chrome 自身の `chrome://` ページ ——
  には確認しない。ローカルファイルはファイル関連のポリシーが扱う。
- 会話をまたいで記憶しない：サイドパネルの会話ごとに改めて確認する。
- ページの中身は見ない：一度許可したサイトでは、その会話内のエージェントの操作は確認なしで進む。
- 自動許可のスイッチをオンにすると、別の組み込みポリシー session-grants が
  効いて確認はスキップされる。

**調整するには**：上書きコピーを作成して一致条件を絞る。信頼するサイトで確認を止めるには、
例えば `object.browser == 'chrome' && object.scheme in ['http', 'https', 'blob'] && object.host != '' && !(object.host in ['docs.example.com'])` のように除外する。
