---
shuvix: workflow v1
shuvix-builtin: true
name: bot-chat
description: チャット会話で bot が走らせるパイプライン —— 話すかを判定し、答え、あとで静かに自分のノートを整える。
shuvix-workflow-concurrency: parallel
shuvix-workflow-limits:
  maxAgents: 4
  maxDurationSec: 2400
shuvix-workflow-vars:
  gateWindow: 8
  taskWindow: 20
  gateTimeoutSec: 60
  taskTimeoutSec: 1800
  notesTimeoutSec: 300
  notesWindow: 60
  notesBudget: 2000
  recheckStale: true
shuvix-workflow-input:
  type: object
  required: [occasion, bot, agents, session]
  properties:
    occasion: { enum: [message, notes] }
    bot: { type: object, required: [name, displayName, description, file] }
    agents: { type: object, required: [intent, task, notes] }
    session: { type: object, required: [id, arbitrated, directed, members] }
    message: { type: object, required: [id, text] }
    window: { type: array }
    notes: { type: string }
    since: { type: array }
---

## これは何か

チャット会話の各 bot が、メッセージごとにこのファイルを一度走らせる。bot のやること
全部が、順にここにある:話すかを判定し、そのメッセージが誰のものかを決め、答え、
そして —— あとで、クリティカルパスの外で —— 自分のノートを整える。

ここに `shuvix-workflow-on` はない:どのトリガーもこのファイルには通じない。bot が
それを指し(`shuvix-bot-pipeline: bot-chat`)、会話が invoke する。`parallel` は意図的:
run 級の再入は完全に脇へ退き、「一度に一つ」は `turn()` が提供する —— それが直列化
するのは**この会話のこの bot** であって、多くの bot と会話が同時に共有するこの
ファイルではない。

「bot だけが呼べる」という鍵もない —— 呼び出し経路は入場検査ではない。このファイルを
bot パイプラインたらしめるのは、スクリプトが `say`・`claim`・`turn` を使うこと、
そしてその三つは bot 呼び出し側だけがスクリプト API に組み込むこと。組み込まない場所
から起動すれば、未定義関数を踏んだスクリプトと同じように最初の名前で失敗する。

> **状態。** 三段とも本物:ゲート、タスク段(M8′)、ノートの場(M9′)まで全て着地済み。

## パイプライン

すべて `input.*` から読む。スクリプトのスコープは基礎 API + 呼び出し側が組み込んだもの
(`say` / `claim` / `turn`)であり、`input` を**フラット化しない** —— 裸の `message` や
`agents` は ReferenceError になる。フラット化は `md prompt=` ブロックの描画スコープ
だけで起こる。

**任意の文脈はネストしたプロンプトであり、裸のプレースホルダではない。** テンプレート
言語には `{{path}}` の一つしかない —— 条件も繰り返しもなく、行はプレースホルダしか
含まないときだけ消える。だから値と一緒に消えるべき見出しは、その値の**内側**に住む:
任意のセクションはそれぞれ自分の `md prompt=` ブロックであり、スクリプトがそれを
「丸ごとあるか空か」の一つの文字列にする。

```js workflow
if (input.occasion === 'notes') {
  // The notes occasion. Nobody is waiting: this runs off the critical path, long after the
  // bot answered. The stage edits the bot's own markdown **in place with `read`/`edit`** —
  // nothing comes back through here, and the script never touches the notes text itself.
  //
  // No result contract on purpose: the work *is* the edit. A schema would only invite the
  // model to describe what it changed instead of changing it, and there is no reader for
  // that description.
  try {
    // `notesWindow` is the ceiling on how much new material one pass reads. Without it a bot
    // busy in three sessions for half an hour ships a thousand lines into this prompt.
    const sinceLines = (input.since || []).slice(-vars.notesWindow)
    await run(
      input.agents.notes,
      prompt('notesTask', {
        file: input.bot.file,
        sinceBlock: sinceLines.length ? prompt('sinceNotes', { since: sinceLines }) : ''
      }),
      {
        // Same reason the gate narrows to nothing: this is a shared builtin, and a user's
        // override of it should not be able to grow a tool list behind the pipeline's back.
        tools: ['read', 'edit'],
        timeoutSec: vars.notesTimeoutSec
      }
    )
  } catch (e) {
    // Being torn down is not a failed pass — it is no pass at all. Rethrow so the run ends as
    // aborted (the same thing `recheck()` does, and for the same reason): swallowing it would
    // report a tidy `notes-failed` for something the user chose.
    if (e && e.code === 'step_aborted') throw e
    // A failed pass changes nothing and is nobody's emergency — the next one sees the same
    // material, because the host advances its checkpoints only on the `notes` outcome.
    log('notes failed: ' + String((e && e.code) || (e && e.message) || e))
    return { outcome: 'notes-failed' }
  }
  return { outcome: 'notes' }
}

// ── The material. Prompts are prose and live in the blocks below; the script only picks.
const recent = (input.window || []).slice(-vars.gateWindow)
const notes = trimNotes(input.notes, vars.notesBudget)
const otherLines = (input.session.others || []).map(function (o) {
  return '- ' + o.displayName + ': ' + o.description
})

// A message that named this bot — or that answers its own clarify — is addressed to it,
// exactly like a one-on-one session: silence is not on the table and `ignore` is not on the
// contract. `arbitrated` stays a separate question: it asks whether anyone else could still
// pick this message up, which is what the degrade path below turns on.
const solo = !input.session.arbitrated || input.session.directed

const notesBlock = notes ? prompt('notes', { notes: notes }) : ''
const othersBlock = otherLines.length ? prompt('others', { others: otherLines }) : ''
const windowBlock = recent.length ? prompt('window', { window: recent }) : ''
const addressed = solo ? prompt('addressed') : ''

// 1 ── The gate. One call, no tools, a minute of wall clock.
let intent = null
let failure = null
try {
  intent = await run(
    input.agents.intent,
    prompt('gate', {
      notesBlock: notesBlock,
      othersBlock: othersBlock,
      windowBlock: windowBlock,
      addressed: addressed
    }),
    {
      schema: solo ? schemas.intentSolo : schemas.intent,
      // Narrows whatever the profile declares down to nothing. The builtin gate declares no
      // tools already; this line is what keeps a user's own override of it from growing any.
      tools: [],
      timeoutSec: vars.gateTimeoutSec
    }
  )
} catch (e) {
  const code = e && e.code
  // Being torn down is not evidence that the gate is broken: a faster bot won this message,
  // or the session was stopped. Yielding is the correct outcome and it costs nothing.
  if (code === 'step_aborted') return { outcome: 'aborted' }
  if (code !== 'next_not_called' && code !== 'step_timeout') throw e
  failure = code === 'step_timeout' ? 'timeout' : 'broken'
  log('gate ' + failure + ': ' + String((e && e.message) || e))
}

// 2 ── A broken contract or a timeout is a **fault, not a verdict**. With other bots around,
//      step aside and let one of them answer. Alone, say so: in a one-on-one session silence
//      and a broken bot look exactly alike.
if (!intent) {
  if (input.session.arbitrated) return { gate: failure, outcome: 'gate-' + failure }
  await say(prompt(failure === 'timeout' ? 'gateTimeout' : 'gateBroken'), { error: true })
  return { gate: failure, outcome: 'gate-' + failure }
}

// 3 ── Whose message is this? The host joins here. With one bot, or when this bot was named,
//      it degenerates to a constant: no waiting, no grace window.
const verdict = await claim(intent)
if (!verdict.won) {
  // "I judged this was not mine" and "someone else was judged a better fit" are different
  // endings, and the run journal is where you go to tell them apart. Collapsing both into
  // `yielded` is the same mistake as writing a slow claim down as a silent one.
  const ending = verdict.reason === 'ignored' ? 'ignored' : 'yielded'
  // `memorable` travels even when this bot does not answer. A bot that heard the preference
  // clearly and handed the turn to a better-placed peer still learned it — tying what gets
  // remembered to who won the message would teach exactly one bot per conversation.
  return { gate: 'ok', outcome: ending, to: verdict.winner, memorable: !!intent.memorable }
}

// 4 ── Anything answerable in one line is answered here — don't open a task for it.
if (intent.decision !== 'task') {
  const line = typeof intent.reply === 'string' ? intent.reply.trim() : ''
  if (!line) {
    // It said it would speak and then wrote nothing. Same class of fault as never calling
    // `next` — and past the claim there is nobody left to cover for us.
    await say(prompt('gateBroken'), { error: true })
    return { gate: 'broken', outcome: 'gate-broken' }
  }
  await say(line, { decision: intent.decision })
  return { gate: 'ok', outcome: intent.decision, memorable: !!intent.memorable }
}

// 5 ── Take this bot's turn in this session: one job at a time, in arrival order.
return await turn(async function (slot) {
  if (slot.superseded.length) log('merged ' + slot.superseded.join(','))

  // Queued behind our own reply: that reply may already have covered this one.
  if (vars.recheckStale && slot.selfReplied) {
    const second = await recheck(slot, windowBlock)
    if (second && second.verdict === 'skip') {
      const line = typeof second.reply === 'string' ? second.reply.trim() : ''
      // Always one line out loud — a skip that says nothing is indistinguishable from a
      // dropped message.
      await say(line || prompt('recheckSkipped'), { decision: 'reply' })
      return { gate: 'ok', outcome: 'recheck-skipped', queuedMs: slot.queuedMs }
    }
  }

  // 6 ── The work itself. The agent **is** the bot (`bot:<name>`): its own body is the system
  //      prompt, its own `shuvix-tools` the tool list. There is deliberately no `tools`
  //      option here — narrowing it would overrule what the bot md said about itself, and
  //      unlike the gate (which is a shared builtin) this agent was written for this job.
  const objective = (intent.task && intent.task.objective) || intent.reason
  const boundaries = (intent.task && intent.task.boundaries) || ''
  const taskLines = (input.window || []).slice(-vars.taskWindow)
  // Handles, not bytes (the script's own input is written to the run journal verbatim).
  // Nothing in the prompt announces them: whatever the host manages to fetch arrives as a
  // real user message in context, and a sentence claiming "2 images are above" would be a
  // lie on exactly the runs where the fetch failed.
  const attached = (input.message && input.message.attachments) || []

  let reply = null
  try {
    reply = await run(
      input.agents.task,
      prompt('task', {
        objective: objective,
        boundariesBlock: boundaries ? prompt('boundaries', { boundaries: boundaries }) : '',
        // No notes block here on purpose. The gate is a shared builtin and has to be told
        // what this bot has learned; the task agent **is** the bot, so its own body already
        // carries the notes. Sending them again costs a second copy per task message — and a
        // truncated one at that, so the model would see the same facts twice, disagreeing.
        windowBlock: taskLines.length ? prompt('window', { window: taskLines }) : '',
        sinceBlock: slot.since && slot.since.length ? prompt('since', { since: slot.since }) : ''
      }),
      {
        schema: schemas.reply,
        timeoutSec: vars.taskTimeoutSec,
        // Whatever the user attached to the message. These are opaque handles, not bytes:
        // the script's own input is written into the run journal verbatim, so images travel
        // by reference and the host fetches them at dispatch.
        attach: attached
      }
    )
  } catch (e) {
    const code = e && e.code
    // Someone stopped the session, or this run lost its place. Saying so would be noise.
    if (code === 'step_aborted') return { gate: 'ok', outcome: 'aborted', queuedMs: slot.queuedMs }

    // It did the work and then wrote prose instead of filling in the contract. Someone is
    // waiting for an answer, and an answer with no shape beats no answer at all — so the
    // first line becomes the conclusion and the rest becomes the explanation.
    // A task agent that does not exist is a configuration mistake, not a run that broke:
    // retrying will never fix it, and "it broke partway through" sends the reader looking at
    // the wrong thing.
    if (code === 'unknown_agent') {
      await say(prompt('taskNoAgent', { agent: String(input.agents.task) }), { error: true })
      return { gate: 'ok', outcome: 'task-no-agent', queuedMs: slot.queuedMs }
    }

    const prose = ((e && e.finalText) || '').trim()
    if (code === 'next_not_called' && prose) {
      await say(wrapProse(prose), { decision: 'task' })
      return { gate: 'ok', outcome: 'task-unshaped', queuedMs: slot.queuedMs }
    }

    // Nothing usable came back. Past the claim there is nobody left to cover for us, so the
    // failure has to be said out loud — silence here is indistinguishable from a dropped
    // message, and this bot already took the turn.
    await say(prompt(code === 'step_timeout' ? 'taskTimeout' : 'taskFailed'), { error: true })
    return {
      gate: 'ok',
      outcome: code === 'step_timeout' ? 'task-timeout' : 'task-failed',
      queuedMs: slot.queuedMs
    }
  }

  await say(reply, { decision: 'task' })
  return { gate: 'ok', outcome: 'task', queuedMs: slot.queuedMs, superseded: slot.superseded }
})

// ── helpers ──────────────────────────────────────────────────────────────────

/** Prose with no shape → the least shape a reply is allowed to have. The first line carries
 *  the conclusion often enough to be worth promoting to one; a leading `#` is markdown
 *  furniture rather than a headline, so it goes. The last resort matters more than it looks:
 *  a `wrapProse` that returns an empty headline would make `say` throw **inside the
 *  degradation path**, turning "answer with no shape" into "no answer". */
function wrapProse(text) {
  const lines = text.split('\n')
  let i = 0
  while (i < lines.length && !stripHeading(lines[i])) i++
  const first = stripHeading(lines[i] || '')
  if (!first) return { headline: text.trim().slice(0, 200) }
  const rest = lines
    .slice(i + 1)
    .join('\n')
    .trim()
  return rest ? { headline: first, body: rest } : { headline: first }
}

function stripHeading(line) {
  return String(line || '')
    .replace(/^#+\s*/, '')
    .trim()
}

/** Cut the notes to budget, then back off to the last paragraph break — a slice that lands
 *  mid-sentence or mid-heading reads to the model as a fact that stops halfway. */
function trimNotes(text, budget) {
  const s = typeof text === 'string' ? text : ''
  if (s.length <= budget) return s
  const cut = s.slice(0, budget)
  const at = cut.lastIndexOf('\n\n')
  return (at > budget / 2 ? cut.slice(0, at) : cut.replace(/\n[^\n]*$/, '')) + '\n\n…'
}

/** The dequeue re-check. Failing it means proceeding: the queued request was going to be done
 *  anyway, and the check only ever saves a repeat. */
async function recheck(slot, windowBlock) {
  const sinceLines = (slot.since || []).slice(-vars.gateWindow)
  try {
    return await run(
      input.agents.recheck || input.agents.intent,
      prompt('recheck', {
        windowBlock: windowBlock,
        sinceBlock: sinceLines.length ? prompt('since', { since: sinceLines }) : ''
      }),
      { schema: schemas.recheck, tools: [], timeoutSec: vars.gateTimeoutSec }
    )
  } catch (e) {
    if (e && e.code === 'step_aborted') throw e
    log('recheck skipped: ' + String((e && e.code) || (e && e.message) || e))
    return null
  }
}
```

ここで投げられたものは run を終わらせ、会話はそれをチャットで言う —— 失敗は決して
沈黙しない。沈黙が許されるのは一つだけ:ゲートが「このメッセージはこの bot のもの
ではない」と判定したときだ。

## 契約

データを返す各段は、以下のブロックの形をしたオブジェクトで `next` を呼んで終わる
(その指示は schema 本体とともに派遣時に付加される)。`ignore` がゲートに提示される
のは、他の bot がそのメッセージを拾えるときだけ:一対一の会話では、沈黙は壊れた bot
と見分けがつかない。

```json schema=intent
{
  "type": "object",
  "required": ["decision", "relevance", "reason"],
  "properties": {
    "decision": {
      "enum": ["reply", "task", "clarify", "ignore"],
      "description": "reply = you can answer fully right now with no tools; task = it needs work; clarify = one question unblocks you; ignore = plainly meant for another bot"
    },
    "relevance": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9,
      "description": "How squarely this message falls in YOUR remit — not how eager you are. One bot wins the message on this number."
    },
    "reason": { "type": "string", "maxLength": 200 },
    "reply": { "type": "string", "description": "The reply itself, for decision reply or clarify" },
    "task": {
      "type": "object",
      "properties": {
        "objective": { "type": "string" },
        "boundaries": { "type": "string" }
      }
    },
    "memorable": {
      "type": "boolean",
      "description": "This message carries a durable preference, correction or fact — set it even when you are only replying"
    }
  }
}
```

```json schema=intentSolo
{
  "type": "object",
  "required": ["decision", "relevance", "reason"],
  "properties": {
    "decision": {
      "enum": ["reply", "task", "clarify"],
      "description": "This message was addressed to you, so answering is not optional. reply = answer now; task = it needs work; clarify = ask the one question that unblocks you."
    },
    "relevance": { "type": "integer", "minimum": 0, "maximum": 9 },
    "reason": { "type": "string", "maxLength": 200 },
    "reply": { "type": "string" },
    "task": {
      "type": "object",
      "properties": {
        "objective": { "type": "string" },
        "boundaries": { "type": "string" }
      }
    },
    "memorable": { "type": "boolean" }
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

```md prompt=gate
チャット会話にメッセージが届いた。この bot に代わって、どうするかを決めよ。

## あなたが代弁する bot

{{bot.displayName}} —— {{bot.description}}

{{notesBlock}}

{{othersBlock}}

{{addressed}}

{{windowBlock}}

## 新しいメッセージ

{{message.text}}
```

```md prompt=notes
## この bot が覚えていること

{{notes}}
```

```md prompt=notesTask
下の会話は終わった。この bot 自身の markdown を最新にせよ。

ファイルは `{{file}}` にある。読んでから、その場で編集する —— 外科的に、変わる行だけ。
何がそこに属するかは、あなた自身の指示に全部書いてある。

何も変えないのは普通の結末だ。来週も意味を持つことを何も教えてくれない会話なら、
ファイルを読み、そう判断して、やめよ。

{{sinceBlock}}
```

```md prompt=others
## この会話にいる他の bot

{{others}}

これらの bot もこのメッセージを見ている。明らかにそのどれかに向けられたものは、
その bot のものであって、あなたのものではない。
```

```md prompt=addressed
このメッセージはこの bot 宛てだ —— 名指しされたか、この bot がいま尋ねた質問への
答えだ。答えることは選択肢ではなく、契約に `ignore` はない。
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

{{windowBlock}}

## 並んでいたメッセージ

{{message.text}}

{{sinceBlock}}
```

```md prompt=sinceNotes
## これらの会話

{{since}}
```

```md prompt=since
## 待っている間に起きたこと

{{since}}
```

```md prompt=recheckSkipped
さっきの返信でもう触れました —— この件はこれ以上ありません。
```

```md prompt=gateBroken
どう答えるべきか分かりませんでした —— 判断を担う部分が読めない形で返ってきました。
もう一度聞くか、言い方を変えてみてください。
```

```md prompt=gateTimeout
どう答えるかを決めるのに時間をかけすぎて、諦めました。まだ必要ならもう一度どうぞ。
```

```md prompt=task
この bot に代わって、チャット会話のメッセージに答える。仕事をしてから、答えよ。

## あなたが代弁する bot

{{bot.displayName}} —— {{bot.description}}

{{windowBlock}}

## メッセージ

{{message.text}}

{{sinceBlock}}

## これに必要だとあなたが判定したこと

{{objective}}

{{boundariesBlock}}

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

{{boundaries}}
```

```md prompt=taskNoAgent
その種の仕事は `{{agent}}` に渡す設定になっていますが、その agent は存在しません。
こちら側の設定の問題です —— 直るまで、もう一度聞いても変わりません。
```

```md prompt=taskTimeout
許された時間いっぱい取り組みましたが、終わりませんでした。まだ必要ならもう一度 ——
範囲を絞ると助かります。
```

```md prompt=taskFailed
引き受けましたが、途中で壊れました。何も仕上がっていないので、この件について私からの
成果は当てにしないでください。
```
