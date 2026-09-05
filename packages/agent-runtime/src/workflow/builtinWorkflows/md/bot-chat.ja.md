---
shuvix: workflow v1
shuvix-builtin: true
name: bot-chat
description: チャット会話で bot が走らせるパイプライン —— 話すかを判定し、答える。
shuvix-workflow-concurrency: parallel
shuvix-workflow-limits:
  maxAgents: 4
  maxDurationSec: 2400
shuvix-workflow-vars:
  gateWindow: 8
  taskWindow: 20
  gateTimeoutSec: 60
  taskTimeoutSec: 1800
  recheckStale: true
shuvix-workflow-input:
  type: object
  required: [bot, agents, session, message]
  properties:
    bot: { type: object, required: [name, displayName, description, file] }
    agents:
      type: object
      required: [intent, task]
      properties:
        intent:
          type: string
          description: Decides whether the bot speaks, and how — one call, no tools, structured verdict
        task:
          type: string
          description: Does the work when the gate says so — its own tools, the bot's profile on its system prompt
        recheck:
          type: string
          description: Optional; re-judges a queued request after the bot already replied to something else (defaults to intent)
    session: { type: object, required: [id, directed, members] }
    message: { type: object, required: [id, text] }
    window: { type: array }
---

## これは何か

チャット会話の各 bot が、メッセージごとにこのファイルを一度走らせる。bot のやること
全部が、順にここにある:そのメッセージが自分にとって何かを判定し、答える。

bot は束ねであって agent ではない:その md はこのパイプラインを指し、パイプラインの
**スロット**を agent 定義で埋める(`shuvix-bot-pipeline: {workflow: bot-chat, agents: {intent: …, task: …}}`)。bot md の
本文 —— その人格と、学んだこと —— は下のどのプロンプトにもない。ホストがそれを囲って、
この run が派遣する全ての agent のシステムプロンプト末尾に付け足す。プロジェクト文脈と
同じ仕組みだ。その本文を最新に保つのはタスク段 agent 自身の仕事であり、自分のファイル
ツールで行う;別立てのノート段はない。

ここに `shuvix-workflow-on` はない:どのトリガーもこのファイルには通じない。bot が
それを指し(`shuvix-bot-pipeline.workflow: bot-chat`)、会話が invoke する。`parallel` は意図的:
run 級の再入は完全に脇へ退き、「一度に一つ」は `turn()` が提供する —— それが直列化
するのは**この会話のこの bot** であって、多くの bot と会話が同時に共有するこの
ファイルではない。

「bot だけが呼べる」という鍵もない —— 呼び出し経路は入場検査ではない。このファイルを
bot パイプラインたらしめるのは、スクリプトが `say`・`turn` を使うこと、
そしてその二つは bot 呼び出し側だけがスクリプト API に組み込むこと。組み込まない場所
から起動すれば、未定義関数を踏んだスクリプトと同じように最初の名前で失敗する。

## パイプライン

スクリプトはフローチャートそのもので、それ以外ではない:意図 → 自分宛てでない / 一言 /
本当の仕事。すべて `input.*` から読む —— スクリプトのスコープは基礎 API + 呼び出し側が
組み込んだもの(`say` / `turn`)であり、`input` を**フラット化しない**。フラット化は
`md prompt=` ブロックの描画スコープだけで起こり、プロンプトの一語一語はそのブロックに住む。

**ここではどの失敗も捕まえない。** タイムアウトした段、契約を破った段、存在しない agent を
指した段は投げる;run は終わり、ホストがチャットでそれを言う。言い回しは失敗の分類
(どの段か、何が壊れたか)から選ばれる。沈黙が許されるのは一つだけ:ゲートが「この
メッセージはこの bot のものではない」と判定したときだ。

```js workflow
// The flow, top to bottom. Every prompt is a block below; every failure simply throws —
// the host says so in the chat, with wording picked from the failure's code.
const window = input.window || []

// 1 ── Intent: one tool-less call decides what this message is to this bot. A message that
//      named the bot, or answers its own clarify, gets the directed prompt and contract —
//      the ones without `ignore`.
const directed = input.session.directed
const intent = await run(
  input.agents.intent,
  prompt(directed ? 'gateDirected' : 'gate', { window: window.slice(-vars.gateWindow) }),
  {
    schema: directed ? schemas.intentDirected : schemas.intent,
    tools: [],
    timeoutSec: vars.gateTimeoutSec
  }
)

// 2 ── Not for this bot: the one silence a bot is allowed.
if (intent.decision === 'ignore') return { outcome: 'ignored' }

// 3 ── Answerable in one line (reply / clarify): say it, no task.
if (intent.decision !== 'task') {
  await say(intent.reply, { decision: intent.decision })
  return { outcome: intent.decision }
}

// 4 ── Work needs this bot's turn in this session: one job at a time, in arrival order.
//      Queued behind a reply of its own, the bot first re-checks whether that reply already
//      covered this one; a re-check that fails just means proceeding.
const slot = await turn()
if (vars.recheckStale && slot.selfReplied) {
  const again = await run(
    input.agents.recheck || input.agents.intent,
    prompt('recheck', {
      window: window.slice(-vars.gateWindow),
      since: slot.since.slice(-vars.gateWindow)
    }),
    { schema: schemas.recheck, tools: [], timeoutSec: vars.gateTimeoutSec }
  ).catch(() => null)
  if (again && again.verdict === 'skip') {
    await say(again.reply || prompt('recheckSkipped'), { decision: 'reply' })
    return { outcome: 'recheck-skipped', queuedMs: slot.queuedMs }
  }
}

// 5 ── The task agent — whichever agent md the bot put in that slot, with its own tools —
//      does the work and answers. Prose instead of the contract still ships: someone is
//      waiting, and an answer with no shape beats no answer.
const reply = await run(
  input.agents.task,
  prompt('task', {
    task: intent.task || { objective: intent.reason },
    window: window.slice(-vars.taskWindow),
    since: slot.since
  }),
  {
    schema: schemas.reply,
    timeoutSec: vars.taskTimeoutSec,
    attach: input.message.attachments,
    fallback: 'prose'
  }
)
await say(reply, { decision: 'task' })
return { outcome: 'task', queuedMs: slot.queuedMs, superseded: slot.superseded }
```

「親切心で直されやすい」選択がいくつかあるので、先に言っておく:

- タスク段には **`tools` オプションを与えない**。`input.agents.task` は bot がその
  スロットに入れた agent md であり、ここでツールを絞ることはその md の自己申告を
  上書きすることになる。ゲートをツールゼロに絞るのは、それが共有の組み込み部品で、
  仕事が構造化された裁定ひとつだからだ。
- `attach` が運ぶのは**バイトではなくハンドル**で、どのプロンプトもそれを告知しない:
  ホストが取れたものは実際のユーザーメッセージとして文脈に入り、「上に 2 枚の画像がある」
  という一文は、取得に失敗した run でこそ嘘になる。
- タスク段の `fallback: 'prose'` は、タスク段 agent が `next` を呼ばずに散文で答えを
  書いた場合でも、その答えを普通のメッセージとして出すという意味だ。
- 再確認は自分の失敗をわざと飲み込む:それが節約できるのは重複だけであり、失敗すれば
  どのみちやるはずだった仕事をするだけだ。

## 契約

データを返す各段は、以下のブロックの形をしたオブジェクトで `next` を呼んで終わる
(その指示は schema 本体とともに派遣時に付加される)。`ignore` がゲートに提示される
のは、そのメッセージがこの bot 宛てでないときだけ:名指しされた、または自分の問い返しへの
答えであるメッセージには `intentDirected` が渡される。

```json schema=intent
{
  "type": "object",
  "required": ["decision", "reason"],
  "properties": {
    "decision": {
      "enum": ["reply", "task", "clarify", "ignore"],
      "description": "reply = you can answer fully right now with no tools; task = it needs work; clarify = one question unblocks you; ignore = plainly meant for another bot"
    },
    "reason": { "type": "string", "maxLength": 200 },
    "reply": { "type": "string", "description": "The reply itself, for decision reply or clarify" },
    "task": {
      "type": "object",
      "required": ["objective"],
      "properties": {
        "objective": { "type": "string" },
        "boundaries": { "type": "string" }
      }
    }
  }
}
```

```json schema=intentDirected
{
  "type": "object",
  "required": ["decision", "reason"],
  "properties": {
    "decision": {
      "enum": ["reply", "task", "clarify"],
      "description": "This message was addressed to you, so answering is not optional. reply = answer now; task = it needs work; clarify = ask the one question that unblocks you."
    },
    "reason": { "type": "string", "maxLength": 200 },
    "reply": { "type": "string" },
    "task": {
      "type": "object",
      "required": ["objective"],
      "properties": {
        "objective": { "type": "string" },
        "boundaries": { "type": "string" }
      }
    }
  }
}
```

```json schema=recheck
{
  "type": "object",
  "required": ["verdict"],
  "properties": {
    "verdict": {
      "enum": ["proceed", "skip"],
      "description": "proceed = the queued request still needs doing; skip = your own later reply already covers it"
    },
    "reply": { "type": "string", "description": "One line to close it out when skipping" }
  }
}
```

```json schema=reply
{
  "type": "object",
  "required": ["headline"],
  "properties": {
    "headline": { "type": "string", "description": "The answer in one sentence, first" },
    "body": {
      "type": "string",
      "description": "Markdown prose, when the answer really is an explanation"
    },
    "points": { "type": "array", "items": { "type": "string" } },
    "table": {
      "type": "object",
      "required": ["columns", "rows"],
      "properties": {
        "columns": { "type": "array", "items": { "type": "string" } },
        "rows": { "type": "array", "items": { "type": "array", "items": { "type": "string" } } }
      }
    },
    "status": { "enum": ["ok", "warn", "error"] },
    "followups": { "type": "array", "items": { "type": "string" } }
  }
}
```

## プロンプト

各段の言葉そのもの。全部が編集できる散文:このファイルを
`~/.shuvix/workflows/bot-chat.md` にコピーすれば、あなたのものだ。

`{{path}}` はこの run の `input`(最上位でフラット化)、加えて `vars`・`event`、そして
スクリプトが `prompt()` の第二引数に渡したものを読む —— 切り出された `window` はそこから
来る。`{{>name}}` はこのファイルの別のブロックを同じスコープで描画して貼り込む;貼り込まれた
ブロックのプレースホルダが全て空なら、見出しごと丸ごと消える。下の任意セクションはそう
動く:`others` は他の bot がいるときだけ、`since` は待っている間に何かが起きたときだけ現れる。

```md prompt=gate
チャット会話にメッセージが届いた。この bot に代わって、どうするかを決めよ。

## あなたが代弁する bot

{{bot.displayName}} —— {{bot.description}}

{{>others}}

{{>window}}

## 新しいメッセージ

{{message.text}}
```

```md prompt=gateDirected
{{>gate}}

このメッセージはこの bot 宛てだ —— 名指しされたか、この bot がいま尋ねた質問への
答えだ。答えることは選択肢ではなく、契約に `ignore` はない。
```

```md prompt=others
## この会話にいる他の bot

{{session.others}}

これらの bot もこのメッセージを見ている。明らかにそのどれかに向けられたものは、
その bot のものであって、あなたのものではない。
```

```md prompt=window
## 直近の会話

{{window}}
```

```md prompt=recheck
このリクエストは bot が忙しい間に列に並び、その間に bot は別のものに返信した。
並んでいたリクエストがまだ必要かを判定せよ。

## あなたが代弁する bot

{{bot.displayName}} —— {{bot.description}}

{{>window}}

## 並んでいたメッセージ

{{message.text}}

{{>since}}
```

```md prompt=since
## 待っている間に起きたこと

{{since}}
```

```md prompt=recheckSkipped
さっきの返信でもう触れました —— この件はこれ以上ありません。
```

```md prompt=task
この bot に代わって、チャット会話のメッセージに答える。仕事をしてから、答えよ。

## あなたが代弁する bot

{{bot.displayName}} —— {{bot.description}}

{{>window}}

## メッセージ

{{message.text}}

{{>since}}

## これに必要だとあなたが判定したこと

{{task.objective}}

{{>boundaries}}

## 答え方

結論を先に —— その一文が読者の最初に見るものであり、しばしば読む全てだ。それから、
内容が元々持っている形を選ぶ。周到に見える形ではなく:説明は散文であり `body` に
属する;並列の事実は箇条書き;行と列は表だ。リストに見せるために段落を三つの半端な
文に割れば、読者はそれらを繋いでいた論旨を失う。

実際にやったこと・やらなかったことを言う。終えられなかったなら結論でそう言う ——
終わったように読める曖昧な答えは、認めた欠落より悪い。
```

```md prompt=boundaries
### この範囲の内で

{{task.boundaries}}
```
