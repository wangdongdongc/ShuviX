---
shuvix: policy v1
shuvix-builtin: true
name: ask-on-sub-session
shuvix-displayName: サブセッションを開く前に確認
description: エージェントがサブセッションを開くときに確認します —— それは自走してトークンを使う新しい会話です。
shuvix-policy-scope:
  subject.kind: [agent]
  object.type: [invocation]
shuvix-policy-rules:
  - effect: ask
    action: [execute]
    match: "tool.name == 'session' && tool.operation == 'create-sub-session'"
    prompt: 自走する新しい会話が始まります。以後は個別に確認されず、トークンも消費されます。
---

**このポリシーの動作**：エージェントがサブセッションを開こうとしたときに確認します。

サブセッションは 1 回のツール呼び出しではなく、**ひとつの会話まるごと**です。独自の
モデルとツールを持ち、エージェント自身が進めます。始める前に一度だけ判断する価値が
あります。

**やらないこと**：

- すでに開いたサブセッションへ後から送るメッセージや、その結果の待機・読み取りは
  ゲートしません（ここでの判断の延長にすぎません）。
- サブセッションの**中身**もゲートしません。そこでのツール呼び出しは、そのセッション内で
  同じポリシー群により通常どおり評価されます。
- 自動許可スイッチを入れると、別の組み込みポリシー session-auto-allow が引き継ぎ、
  この確認はスキップされます。

**調整するには**：上書きコピーを作って編集します。rules を空にすれば確認なしで開きます。
