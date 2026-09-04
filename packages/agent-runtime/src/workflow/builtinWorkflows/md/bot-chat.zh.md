---
shuvix: workflow v1
shuvix-builtin: true
name: bot-chat
description: bot 在聊天会话里跑的管线 —— 判定要不要说话,然后作答。
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

## 这是什么

聊天会话里的每个 bot、每条消息都跑一遍这份文件。它就是一个 bot 做的全部事情,按序:
判定要不要说话、裁定这条消息归谁、作答。

bot 是一份绑定,不是一个 agent:它的 md 指向这份管线,并用 agent 定义填满管线的**槽位**
(`shuvix-bot-pipeline: {workflow: bot-chat, agents: {intent: …, task: …}}`)。bot md 的正文 —— 它的人设与它学到的东西 ——
不在下面任何一段提示词里。宿主把它围栏后追加到这次 run 派发的每一个 agent 的系统提示词
末尾,与项目上下文同一机制。把这份正文维护好是任务段 agent 自己的事,用它自己的文件工具;
没有单独的笔记段。

这里没有 `shuvix-workflow-on`:没有任何埋点通向这份文件。bot 指向它
(`shuvix-bot-pipeline.workflow: bot-chat`),由会话来 invoke。`parallel` 是刻意的:run 级重入
整个让位,「一次只做一件事」由 `turn()` 提供 —— 它串行化的是**这个 bot 在这个会话里**,
而不是这份被许多 bot、许多会话同时共用的文件。

也没有一个「只有 bot 才能调用」的键 —— 调用路径不是准入检查。让这份文件成为 bot 管线的,
只是它的脚本用了 `say` 与 `turn`,而只有 bot 调用方会把这两个名字装配进脚本
API。从别处启动它,它会在第一个名字上失败,和任何脚本踩到未定义函数一个样。

## 管线

一切都从 `input.*` 上读。脚本作用域里是基础 API 加上调用方装配的那两个
(`say` / `turn`)—— 它**不会**摊平 `input`,裸写 `message` 或 `agents`
是 ReferenceError。摊平只发生在 `md prompt=` 块的渲染作用域里。

**可选上下文是嵌套提示词,不是裸占位符。** 模板语言只有一样东西 —— `{{path}}`,
没有条件没有循环 —— 一行只有当整行都是占位符时才会消失。所以要跟着值一起消失的标题,
必须住在那个值**里面**:每个可选小节各是一个 `md prompt=` 块,脚本把它变成
「要么完整要么为空」的一个字符串。

```js workflow
// ── The material. Prompts are prose and live in the blocks below; the script only picks.
const recent = (input.window || []).slice(-vars.gateWindow)
const otherLines = (input.session.others || []).map(function (o) {
  return '- ' + o.displayName + ': ' + o.description
})

// A message that named this bot — or that answers its own clarify — is addressed to it:
// silence is not on the table and `ignore` is not on the contract. Every other message goes
// through the normal gate, where this bot decides for itself whether it has anything to say.
const solo = input.session.directed

const othersBlock = otherLines.length ? prompt('others', { others: otherLines }) : ''
const windowBlock = recent.length ? prompt('window', { window: recent }) : ''
const addressed = solo ? prompt('addressed') : ''

// 1 ── The gate. One call, no tools, a minute of wall clock. The bot's own profile — persona
//      and memory — is not in this prompt: the host appends it to the system prompt of every
//      agent this run dispatches, the gate included.
let intent = null
let failure = null
try {
  intent = await run(
    input.agents.intent,
    prompt('gate', {
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

// 2 ── A broken contract or a timeout is a **fault, not a verdict**, and every bot answers
//      for its own ending: say so. Silence is reserved for one thing only — the gate deciding
//      this message was not for this bot.
if (!intent) {
  await say(prompt(failure === 'timeout' ? 'gateTimeout' : 'gateBroken'), { error: true })
  return { gate: failure, outcome: 'gate-' + failure }
}

// 3 ── The gate judged this message is not for this bot. That is the one silence a bot is
//      allowed: no message, no notice, just a line in the run journal.
if (intent.decision === 'ignore') {
  return { gate: 'ok', outcome: 'ignored' }
}

// 4 ── Anything answerable in one line is answered here — don't open a task for it.
if (intent.decision !== 'task') {
  const line = typeof intent.reply === 'string' ? intent.reply.trim() : ''
  if (!line) {
    // It said it would speak and then wrote nothing. Same class of fault as never calling
    // `next` — and it already committed to answering.
    await say(prompt('gateBroken'), { error: true })
    return { gate: 'broken', outcome: 'gate-broken' }
  }
  await say(line, { decision: intent.decision })
  return { gate: 'ok', outcome: intent.decision }
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

  // 6 ── The work itself. `input.agents.task` is whichever agent md the bot put in that slot:
  //      its own body is the system prompt, its own `shuvix-tools` the tool list, and the
  //      bot's profile rides along on the system prompt. There is deliberately no `tools`
  //      option here — narrowing it would overrule what that agent md said about itself, and
  //      unlike the gate (a shared builtin) this slot was chosen for exactly this job.
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

    // Nothing usable came back. The failure has to be said out loud — silence here is
    // indistinguishable from a dropped message, and this bot already took the turn.
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

在这里抛出的任何东西都会结束这个 run,而且会话会在聊天里说出来 —— 失败从不沉默。
沉默只留给一件事:门控判定这条消息不归这个 bot。

## 契约

每个交回数据的段以调用 `next` 收尾,对象形状取自下面这些块(这条指令连同 schema 本身
在派发时附加)。只有当别的 bot 还能接住这条消息时,门控才会被给到 `ignore`:
一对一会话里,沉默与坏掉的 bot 无从分辨。

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
      "properties": {
        "objective": { "type": "string" },
        "boundaries": { "type": "string" }
      }
    }
  }
}
```

```json schema=intentSolo
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

## 提示词

各段的原话。全部是可编辑的散文:把这份文件拷到 `~/.shuvix/workflows/bot-chat.md`,
它就是你的了。

```md prompt=gate
聊天会话里刚到了一条消息。替这个 bot 决定拿它怎么办。

## 你代言的 bot

{{bot.displayName}} —— {{bot.description}}

{{othersBlock}}

{{addressed}}

{{windowBlock}}

## 新消息

{{message.text}}
```

```md prompt=others
## 会话里的其他 bot

{{others}}

这些 bot 也看得到这条消息。明显冲着其中某个去的,是它的,不是你的。
```

```md prompt=addressed
这条消息就是冲这个 bot 来的 —— 它被点了名,或这条消息在回答它刚问出的问题。
作答不是可选项,契约里也没有 `ignore`。
```

```md prompt=window
## 最近的对话

{{window}}
```

```md prompt=recheck
这条请求在 bot 忙碌时排了队,而 bot 在这期间已经答过别的东西。判定这条排队的请求
还需不需要做。

## 你代言的 bot

{{bot.displayName}} —— {{bot.description}}

{{windowBlock}}

## 排队的那条消息

{{message.text}}

{{sinceBlock}}
```

```md prompt=since
## 它排队期间发生了什么

{{since}}
```

```md prompt=recheckSkipped
我刚才那条回复已经把这件事覆盖了 —— 这条就不再另答了。
```

```md prompt=gateBroken
我没能弄明白该怎么接这条 —— 我负责拿主意的那部分交回了一个我读不懂的形状。
再问一次,或者换个说法。
```

```md prompt=gateTimeout
我在「怎么接这条」上花了太久,放弃了。还要紧的话,再问一次。
```

```md prompt=task
你在替这个 bot 回答聊天会话里的一条消息。先把活干了,再作答。

## 你代言的 bot

{{bot.displayName}} —— {{bot.description}}

{{windowBlock}}

## 这条消息

{{message.text}}

{{sinceBlock}}

## 你判定它需要什么

{{objective}}

{{boundariesBlock}}

## 作答

结论先行 —— 那一句话是读者最先看到、也常常是唯一会读的部分。然后选内容本来就有的
形状,而不是看起来周全的形状:解释天然是散文,归 `body`;一组并列事实是列点;
行与列是表格。把一个段落劈成三句半只为看着像列表,读者失去的是把它们串起来的那条论证。

说你实际做了什么、没做什么。没做完就在结论里说没做完 —— 一条读起来像做完了的含糊
回答,比一个承认了的缺口更糟。
```

```md prompt=boundaries
### 边界之内

{{boundaries}}
```

```md prompt=taskNoAgent
我被配置成把这类活交给 `{{agent}}`,而这个 agent 并不存在。这是我这边的配置问题 ——
修好之前,再问也没用。
```

```md prompt=taskTimeout
这件事我做满了被允许的时长,没能做完。还要紧的话再问一次 —— 把范围收窄会有帮助。
```

```md prompt=taskFailed
这件事我接了,半路坏掉了。什么都没做完,这一条别指望我交出任何东西。
```
