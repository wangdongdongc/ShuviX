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
    session: { type: object, required: [id] }
    message: { type: object, required: [id, text] }
    window: { type: array }
---

## 这是什么

聊天会话绑定的那个 bot,每条消息都跑一遍这份文件。它就是一个 bot 做的全部事情,按序:
判定这条消息需要什么,然后作答。

bot 是一份绑定,不是一个 agent:它的 md 指向这份管线,并用 agent 定义填满管线的**槽位**
(`shuvix-bot-pipeline: {workflow: bot-chat, agents: {intent: …, task: …}}`)。bot md 的正文 —— 它的人设与它学到的东西 ——
不在下面任何一段提示词里。宿主把它围栏后追加到这次 run 派发的每一个 agent 的系统提示词
末尾,与项目上下文同一机制。把这份正文维护好是任务段 agent 自己的事,用它自己的文件工具;
没有单独的笔记段。

这里没有 `shuvix-workflow-on`:没有任何埋点通向这份文件。bot 指向它
(`shuvix-bot-pipeline.workflow: bot-chat`),由会话来 invoke。`parallel` 是刻意的:run 级重入
整个让位,「一次只做一件事」由 `turn()` 提供 —— 它串行化的是**这个会话**,
而不是这份被许多会话同时共用的文件。

也没有一个「只有 bot 才能调用」的键 —— 调用路径不是准入检查。让这份文件成为 bot 管线的,
只是它的脚本用了 `say` 与 `turn`,而只有 bot 调用方会把这两个名字装配进脚本
API。从别处启动它,它会在第一个名字上失败,和任何脚本踩到未定义函数一个样。

## 管线

脚本就是流程图,别的什么都不是:意图 → 一句话 / 真干活。一切都从 `input.*`
上读 —— 脚本作用域里是基础 API 加上调用方装配的那两个(`say` / `turn`),它**不会**
摊平 `input`;摊平只发生在 `md prompt=` 块的渲染作用域里,而提示词的每一个字都住在那些块里。

**这里不接住任何错误。** 哪一段超时、破坏契约、或指向一个不存在的 agent,就抛出去;
run 结束,宿主在聊天里说出来,措辞按失败的归类选(哪一段、坏在哪)。没有沉默这回事:
会话是一对一的,每条消息都是说给这个 bot 的,每次 run 都以一条回复或一条可见的失败收尾。

```js workflow
// The flow, top to bottom. Every prompt is a block below; every failure simply throws —
// the host says so in the chat, with wording picked from the failure's code.
const window = input.window || []

// 1 ── Intent: one tool-less call decides what this message needs. The chat is one-on-one,
//      so every message is for this bot by definition — the contract has no `ignore`.
const intent = await run(
  input.agents.intent,
  prompt('gate', { window: window.slice(-vars.gateWindow) }),
  { schema: schemas.intent, tools: [], timeoutSec: vars.gateTimeoutSec }
)

// 2 ── Answerable in one line (reply / clarify): say it, no task.
if (intent.decision !== 'task') {
  await say(intent.reply, { decision: intent.decision })
  return { outcome: intent.decision }
}

// 3 ── Work needs this session's turn: one job at a time, in arrival order. Queued behind a
//      reply of its own, the bot first re-checks whether that reply already covered this one;
//      a re-check that fails just means proceeding.
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

// 4 ── The task agent — whichever agent md the bot put in that slot, with its own tools —
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

几处容易被「好心修掉」的选择,先说明白:

- 任务段**不给 `tools` 选项**。`input.agents.task` 是 bot 在那个槽位填的那份 agent md;
  在这里收窄它的工具等于替那份 md 改口。门控收窄到零工具,是因为它是共享的内置件,
  职责只是一份结构化裁决。
- `attach` 传的是**句柄不是字节**,也没有哪段提示词宣告它们:宿主取到什么,就以一条真实的
  用户消息进上下文;一句「上面有 2 张图」恰恰会在取失败的那些 run 上撒谎。
- 任务段的 `fallback: 'prose'` 意味着:任务段 agent 把答案写成散文而没调 `next`,答案照样
  以普通消息交出。
- 复核刻意吞掉自己的失败:它只可能省掉一次重复,复核坏了就去做本来就要做的活。

## 契约

每个交回数据的段以调用 `next` 收尾,对象形状取自下面这些块(这条指令连同 schema 本身
在派发时附加)。门控没有 `ignore`:一对一会话里每条消息都是说给这个 bot 的,
裁决只关乎怎么答,从不关乎答不答。

```json schema=intent
{
  "type": "object",
  "required": ["decision", "reason"],
  "properties": {
    "decision": {
      "enum": ["reply", "task", "clarify"],
      "description": "reply = you can answer fully right now with no tools; task = it needs work; clarify = one question unblocks you. The chat is one-on-one: the message is addressed to you, so answering is not optional."
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

`{{path}}` 读这次 run 的 `input`(顶层摊平),外加 `vars`、`event`,以及脚本作为第二个参数
传给 `prompt()` 的东西 —— 切好的 `window` 就来自那里。`{{>name}}` 把这份文件里的另一个块
在同一作用域里渲染后贴进来;贴进来的块若占位符全空,就整块消失,连标题一起。下面的可选小节
就是这么工作的:`since` 只在请求排队期间发生了事情时出现。

```md prompt=gate
聊天会话里刚到了一条消息。替这个 bot 决定拿它怎么办。

## 你代言的 bot

{{bot.displayName}} —— {{bot.description}}

{{>window}}

## 新消息

{{message.text}}
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

{{>window}}

## 排队的那条消息

{{message.text}}

{{>since}}
```

```md prompt=since
## 它排队期间发生了什么

{{since}}
```

```md prompt=recheckSkipped
我刚才那条回复已经把这件事覆盖了 —— 这条就不再另答了。
```

```md prompt=task
你在替这个 bot 回答聊天会话里的一条消息。先把活干了,再作答。

## 你代言的 bot

{{bot.displayName}} —— {{bot.description}}

{{>window}}

## 这条消息

{{message.text}}

{{>since}}

## 你判定它需要什么

{{task.objective}}

{{>boundaries}}

## 作答

结论先行 —— 那一句话是读者最先看到、也常常是唯一会读的部分。然后选内容本来就有的
形状,而不是看起来周全的形状:解释天然是散文,归 `body`;一组并列事实是列点;
行与列是表格。把一个段落劈成三句半只为看着像列表,读者失去的是把它们串起来的那条论证。

说你实际做了什么、没做什么。没做完就在结论里说没做完 —— 一条读起来像做完了的含糊
回答,比一个承认了的缺口更糟。
```

```md prompt=boundaries
### 边界之内

{{task.boundaries}}
```
