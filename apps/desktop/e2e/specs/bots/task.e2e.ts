/**
 * 任务段的端到端（M8′ / v3）—— **只放穿透进程边界的那几件事**。
 *
 * 管线脚本的分支、`wrapProse` 的退化输入、BotReply 的全键投影、失败文案都是确定性纯
 * 逻辑，它们在单测里跑真 md、真投影，一轮几毫秒（`packages/agent-runtime/src/workflow/
 * __tests__/botChatTask.test.ts` 与 `packages/chat-protocol/src/botReply.test.ts`）。
 * 放进这里只会让每条断言都先付一次真实例 + 真 LLM 往返的代价，还换不来新信息。
 *
 * 留在这里的是**只有跨了进程才成立**的五件事：
 *   1. 任务段真的带着 task 槽位那份 agent md 自己声明的工具被派发出去（工具解析在主进程，
 *      脚本看不见），而 bot 的正文以 `<bot_profile>` 围栏落在**门控与任务段两者**的系统
 *      提示词末尾 —— v3 起 bot 不再是 agent，工具与人格分属两份文件；
 *   2. 用户附的图真的到了 provider 的请求体里，而 run journal 里只有句柄没有字节
 *      —— 两个观测面分处网络与磁盘，任何一层的单测都只看得到其中一半；
 *   3. 聊天会话与有根会话的埋点 payload 形状一致（两个 emit 侧分处两个模块，
 *      只有让它们各跑一轮再对账才作数）；
 *   4. 自动标题对聊天会话也生效（内置工作流 + 埋点 + 会话表三者的合流）；
 *   5. 任务段在飞时按停止 / 删会话不留残骸（会师点、附件目录、进程级未处理异常）。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { launchApp, type E2EApp } from '../../harness/launch'
import { startFakeProvider, type FakeProvider, type FakeRequest } from '../../harness/fakeProvider'
import { until } from '../../harness/cdp'
import {
  createBotSession,
  seedFakeProvider,
  waitRendererReady,
  writeAgentMd,
  writeBotMd
} from '../../harness/seed'

let app: E2EApp
let provider: FakeProvider

const MODEL = 'e2e-model'

/** 4×4 RGB PNG（zlib 生成，CRC 正确）—— 落进请求体的就是这串 base64 */
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAAEElEQVR4nGM4IWcDRwzEcQDgQxIh0JD36gAAAABJRU5ErkJggg=='

/** 任务段回复的全键样本 —— 六个字段各非空，好让 markdown 投影的每一段都能被验到 */
const REPLY = {
  headline: '查完了，两处待修',
  body: '鉴权中间件的空值判断没跟上。',
  points: ['auth.ts:42 缺判空', 'router 顺序变了'],
  table: { columns: ['接口', '状态'], rows: [['/login', '待修']] },
  status: 'warn',
  followups: ['要我直接改吗？']
}

/** task 槽位那份 agent md 的正文 —— 它才是任务段的系统提示词主体 */
const WORKER_AGENT_BODY = 'WORKER AGENT PERSONA.'
/** bot 的正文 —— 人设与记忆，围栏后追加到门控与任务段两者的系统提示词末尾 */
const WORKER_BOT_BODY = 'WORKER BOT BODY — the bot remembers things here.'

interface Msg {
  id: string
  role?: string
  content?: string
  metadata?: {
    sender?: { kind: string; name: string; displayName: string }
    reply?: Record<string, unknown>
  } | null
}

const listMessages = (sid: string): Promise<Msg[]> =>
  app.main.eval(`window.api.message.list(${JSON.stringify(sid)})`)

const prompt = (sid: string, text: string, extra = ''): Promise<void> =>
  app.main.eval(
    `window.api.agent.prompt({ sessionId: ${JSON.stringify(sid)}, text: ${JSON.stringify(text)}${extra} }).catch(() => undefined)`
  )

/**
 * 发消息但**不等它跑完**。
 *
 * 聊天会话的 `agent.prompt` 直到整个 cohort 收尾才 resolve（有根会话那侧是发出去就返回），
 * 所以「任务段挂着的时候按停止」这类用例必须脱手发送 —— 否则测试自己先卡在那条 prompt 上，
 * 停止键根本没机会被按下。
 */
const promptDetached = (sid: string, text: string, extra = ''): Promise<void> =>
  app.main.eval(
    `void window.api.agent.prompt({ sessionId: ${JSON.stringify(sid)}, text: ${JSON.stringify(text)}${extra} }).catch(() => undefined); 1`
  )

/** 一次 next 调用（意图段 / 任务段都靠它交回结构化结果） */
const next = (
  args: Record<string, unknown>,
  when?: (r: FakeRequest) => boolean,
  holdMs?: number
): Parameters<FakeProvider['script']>[0] => ({
  toolCalls: [{ id: 'call_next', name: 'next', args: JSON.stringify(args) }],
  usage: { prompt: 200, completion: 20 },
  ...(when ? { when } : {}),
  ...(holdMs ? { holdMs } : {})
})

/** 这一请求是哪一段 —— 提示词的开头一句就是最稳的判据 */
const isGate = (r: FakeRequest): boolean =>
  !r.isTitle && r.raw.includes('A message has just arrived in a chat session')
const isTask = (r: FakeRequest): boolean =>
  !r.isTitle && r.raw.includes('You are answering a message in a chat session')

/** 请求体里的系统提示词（openai-completions 把它放在 messages 头部，role 为 system 或 developer） */
function systemPromptOf(r: FakeRequest): string {
  const m = (r.body.messages ?? []).find((x) => x.role === 'system' || x.role === 'developer')
  const c = m?.content
  if (typeof c === 'string') return c
  if (Array.isArray(c)) {
    return c.map((b) => (b as { text?: string }).text ?? '').join('')
  }
  return ''
}

/** 等到该会话上出现 n 条 assistant 消息 */
const untilReplies = (sid: string, n: number): Promise<Msg[]> =>
  until(async () => {
    const msgs = await listMessages(sid)
    return msgs.filter((m) => m.role === 'assistant').length >= n ? msgs : undefined
  }, `${n} assistant message(s) on ${sid}`)

// ── run journal（bot 路径重定向到该 bot 自己的目录） ──

const botRunsDir = (bot: string): string => join(app.home, '.shuvix', 'bots', '.runs', bot)
const runRecords = (bot: string): Array<Record<string, unknown>[]> => {
  const dir = botRunsDir(bot)
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((f) => f.endsWith('.jsonl') && f !== 'decisions.jsonl')
    .map((f) =>
      readFileSync(join(dir, f), 'utf-8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Record<string, unknown>)
    )
}
/** 该 bot 在这条会话上的那一份 run journal */
const runForSession = (bot: string, sid: string): Promise<Record<string, unknown>[]> =>
  until(
    () => runRecords(bot).find((rs) => rs.find((r) => r.type === 'meta')?.sessionId === sid),
    `run journal of ${bot} for ${sid}`
  )

beforeAll(async () => {
  app = await launchApp()
  provider = await startFakeProvider()
  await seedFakeProvider(app.main, { baseUrl: provider.baseUrl, modelId: MODEL })
  await waitRendererReady(app.main)

  // v3：任务段是 task 槽位指向的那份 agent md —— 正文即系统提示词，shuvix-tools 即它的工具清单；
  // bot 自己只剩人设与记忆（正文），经围栏进每个参与 agent 的系统提示词
  writeAgentMd(app, 't-worker-agent', {
    description: 'the agent behind Worker',
    tools: 'read, grep',
    body: WORKER_AGENT_BODY
  })
  writeBotMd(app, 't-worker', {
    description: 'does the actual work',
    displayName: 'Worker',
    agents: { intent: 'bot-intent', task: 't-worker-agent' },
    body: WORKER_BOT_BODY
  })
  writeBotMd(app, 't-quiet', { description: 'hangs on the task stage', displayName: 'Quiet' })
}, 120_000)

afterAll(async () => {
  await app?.stop()
  await provider?.close()
})

describe('E-1 —— 任务段全链：门控判 task → task 槽位的 agent 带着自己的工具干活 → 结构化回复落库', () => {
  it('工具清单、两段的系统提示词（agent 正文 + bot 围栏）、结果契约、落库的三种形态逐项落位', async () => {
    provider.reset()
    provider.script(
      next({ decision: 'task', reason: '要动手', task: { objective: '查鉴权' } }, isGate),
      next(REPLY, isTask)
    )
    const sid = await createBotSession(app.main, { bots: ['t-worker'] })
    await prompt(sid, '帮我查一下鉴权那块')

    const msgs = await untilReplies(sid, 1)
    const reply = msgs.find((m) => m.role === 'assistant')!

    // ① 任务段带的是 **task 槽位那份 agent md 声明的那几个工具** + 结果契约的 next。
    //    工具名解析发生在主进程（`resolveTools`），管线脚本压根看不见这一步 ——
    //    只有真跑一次才知道槽位表里的名字确实被解析成了那份档案
    const taskReq = provider.chatRequests().find(isTask)!
    const toolNames = (taskReq.body.tools ?? []).map(
      (t) => (t as { function?: { name?: string } }).function?.name
    )
    expect(toolNames).toContain('read')
    expect(toolNames).toContain('grep')
    expect(toolNames).toContain('next')
    // 系统提示词主体是那份 agent 的正文；bot 的正文以围栏缀在末尾（带身份键与文件路径）
    const taskSys = systemPromptOf(taskReq)
    expect(taskSys).toContain(WORKER_AGENT_BODY)
    expect(taskSys).toContain(
      `<bot_profile name="t-worker" file="${join(app.botsDir, 't-worker.md')}">`
    )
    expect(taskSys).toContain(WORKER_BOT_BODY)
    expect(taskSys.indexOf(WORKER_AGENT_BODY)).toBeLessThan(taskSys.indexOf('<bot_profile'))

    // ② 对照：门控段是共享内置件，被管线显式锁成「只有 next」；它拿到**同一份**围栏
    //    （这次 run 派发的每一个 agent 都拿），但没有任务段 agent 的正文
    const gateReq = provider.chatRequests().find(isGate)!
    const gateToolNames = (gateReq.body.tools ?? []).map(
      (t) => (t as { function?: { name?: string } }).function?.name
    )
    expect(gateToolNames).toEqual(['next'])
    const gateSys = systemPromptOf(gateReq)
    expect(gateSys).toContain('<bot_profile name="t-worker"')
    expect(gateSys).toContain(WORKER_BOT_BODY)
    expect(gateSys).not.toContain(WORKER_AGENT_BODY)

    // ③ content 是**全键 markdown**（模型可见的唯一权威），行上的 reply 列是同源的
    //    结构（UI 用）—— v2 起它就是消息那一行的一列，不再是紧邻的一条署名 entry
    const content = String(reply.content)
    for (const trace of [
      REPLY.headline,
      REPLY.body,
      '- auth.ts:42 缺判空',
      '| 接口 | 状态 |',
      'Status: warn',
      'Follow-ups:'
    ]) {
      expect(content).toContain(trace)
    }
    expect(reply.metadata?.reply).toEqual(REPLY)
    expect(reply.metadata?.sender).toMatchObject({ name: 't-worker', displayName: 'Worker' })
  })
})

describe('E-2 —— 附件：图片到得了 provider，字节进不了 journal', () => {
  it('任务段请求体含 base64；journal 只记句柄；门控段不带图', async () => {
    provider.reset()
    provider.script(
      next({ decision: 'task', reason: '看图', task: { objective: '看这张图' } }, isGate),
      next({ headline: '看到了一张 4×4 的图' }, isTask)
    )
    const sid = await createBotSession(app.main, { bots: ['t-worker'] })
    await prompt(
      sid,
      '这张图什么意思',
      `, images: [{ type: 'image', data: ${JSON.stringify(PNG_B64)}, mimeType: 'image/png' }]`
    )
    await untilReplies(sid, 1)

    // ① 字节真的到了模型那边 —— 句柄是在派发那一刻才按路径回读文件换成真消息的
    //    （v2 起字节落 `<userData>/data/chat-attachments/<会话>/`，行里只存描述符）
    expect(provider.chatRequests().find(isTask)!.raw).toContain(PNG_B64)

    // ② 门控段不带图：判断该不该接话不需要看图，也省一次读盘
    expect(provider.chatRequests().find(isGate)!.raw).not.toContain(PNG_B64)

    // ③ journal 里只有句柄。脚本的 input 被原样写进 run 记录 —— 让 base64 进 input
    //    等于每条带图消息都在磁盘上留下一份**逐 bot** 的副本
    const records = await runForSession('t-worker', sid)
    const journal = JSON.stringify(records)
    expect(journal).not.toContain(PNG_B64)
    const meta = records.find((r) => r.type === 'meta')!
    expect(meta.sessionId).toBe(sid)
    // 句柄本身不进 meta（meta 刻意不抄整份信封），但它确实自包含且不含字节 ——
    // 形状的逐格用例在 botServiceAttachments.test.ts
    expect(meta.event).toBeUndefined()
  })
})

describe('E-3 —— 两种会话的 turn-completed 形状一致', () => {
  it('聊天会话的 payload 比有根会话恰好多一个 bots 键', async () => {
    // 两个 emit 侧分处两个模块（AgentSession / botService），共用同一个事实构造器。
    // 它们迟早会在「什么算一轮」上错开，而订阅方的 CEL `when` 是照着同一份形状写的 ——
    // 错开之后只表现为「某类会话的工作流莫名其妙不触发」
    const wfDir = join(app.home, '.shuvix', 'workflows')
    mkdirSync(wfDir, { recursive: true })
    writeFileSync(
      join(wfDir, 'probe.md'),
      [
        '---',
        'shuvix: workflow v1',
        'name: probe',
        'shuvix-workflow-on:',
        '  - trigger: session.turn-completed',
        '---',
        '',
        'E2E probe: hand the埋点 payload back verbatim.',
        '',
        '```js workflow',
        'return event',
        '```',
        ''
      ].join('\n')
    )

    const probeRunsDir = join(wfDir, '.runs', 'probe')
    const outputFor = (sid: string): Promise<Record<string, unknown>> =>
      until(() => {
        if (!existsSync(probeRunsDir)) return undefined
        for (const f of readdirSync(probeRunsDir).filter((n) => n.endsWith('.jsonl'))) {
          const records = readFileSync(join(probeRunsDir, f), 'utf-8')
            .trim()
            .split('\n')
            .filter(Boolean)
            .map((l) => JSON.parse(l) as Record<string, unknown>)
          if (records.find((r) => r.type === 'meta')?.sessionId !== sid) continue
          const end = records.find((r) => r.type === 'end')
          if (end?.output) return end.output as Record<string, unknown>
        }
        return undefined
      }, `probe run output for ${sid}`)

    // 有根会话：没有 API key 也没关系 —— 埋点在轮结束时恒触发，成败不过滤
    const rooted = await app.main.eval<string>(`window.api.session.create({}).then((s) => s.id)`)
    await prompt(rooted, 'rooted turn')

    provider.reset()
    provider.script(next({ decision: 'reply', reason: '寒暄', reply: '你好。' }, isGate))
    const chat = await createBotSession(app.main, { bots: ['t-worker'] })
    await prompt(chat, 'chat turn')
    await untilReplies(chat, 1)

    const rootedKeys = Object.keys(await outputFor(rooted)).sort()
    const chatKeys = Object.keys(await outputFor(chat)).sort()
    expect(chatKeys.filter((k) => !rootedKeys.includes(k))).toEqual(['bots'])
    expect(rootedKeys.filter((k) => !chatKeys.includes(k))).toEqual([])
  })
})

describe('E-4 —— 自动标题对聊天会话也生效', () => {
  it('起过 auto-title 的 quick run，会话标题被改写且记为自动来源', async () => {
    // 「聊天会话也 fire 会话域埋点」这条改动的用户可见收益就是它：内置工作流一个字没改、
    // titler 一个字没改，聊天会话顺带就有了自动标题。三件东西分处三个模块，只有真跑一轮
    // 才知道它们确实合流了
    const isTitler = (r: FakeRequest): boolean => !r.isTitle && r.raw.includes('<conversation>')
    provider.reset()
    provider.script(
      next({ decision: 'reply', reason: '寒暄', reply: '你好，我在。' }, isGate),
      // titler 自己动手改名（session 工具），下一轮才交结构化结果
      {
        toolCalls: [
          {
            id: 'call_cfg',
            name: 'session',
            args: JSON.stringify({ action: 'set-title', title: '鉴权排查' })
          }
        ],
        usage: { prompt: 100, completion: 10 },
        when: isTitler
      },
      next({ title: '鉴权排查' }, isTitler)
    )
    // 标题必须是**当前语言下的默认标题** —— 不传 title 让 session.create 自己填
    const sid = await app.main.eval<string>(
      `window.api.session.create({ bots: ['t-worker'] }).then((s) => s.id)`
    )
    await prompt(sid, '帮我看看鉴权')
    await untilReplies(sid, 1)

    const session = await until(async () => {
      const s = await app.main.eval<{ title?: string; settings?: { titleOrigin?: string } } | null>(
        `window.api.session.getById(${JSON.stringify(sid)})`
      )
      return s?.settings?.titleOrigin === 'auto' ? s : undefined
    }, 'auto-generated title on the chat session')

    expect(session.title).toBe('鉴权排查')
    // quick run 确实是这条会话起的（.runs 目录里按会话认领）
    const autoTitleRuns = join(app.home, '.shuvix', 'workflows', '.runs', 'auto-title')
    expect(existsSync(autoTitleRuns)).toBe(true)
    const forThisSession = readdirSync(autoTitleRuns)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => readFileSync(join(autoTitleRuns, f), 'utf-8'))
      .filter((raw) => raw.includes(sid))
    expect(forThisSession.length).toBeGreaterThan(0)
  })
})

describe('E-5/E-6 —— 任务段在飞时被打断，不留残骸', () => {
  /**
   * 让任务段的那次 LLM 调用挂住，返回该会话 id（此时管线正卡在任务段里）。
   *
   * `withImage` 让用户消息带一张图 —— 附件字节落在
   * `<userData>/data/chat-attachments/<会话>/`，E-6 用那个目录当「残骸还在不在」的观测面
   * （v1 用的是会话树的 jsonl，v2 聊天会话根本不建那个文件）。
   */
  async function startHangingTask(withImage = false): Promise<string> {
    provider.reset()
    provider.script(
      next({ decision: 'task', reason: '慢活', task: { objective: '慢慢查' } }, isGate),
      next({ headline: '不会走到这里' }, isTask, 60_000)
    )
    const sid = await createBotSession(app.main, { bots: ['t-quiet'] })
    await promptDetached(
      sid,
      '开始一个很慢的活',
      withImage
        ? `, images: [{ type: 'image', data: ${JSON.stringify(PNG_B64)}, mimeType: 'image/png' }]`
        : ''
    )
    await until(
      async () => (provider.chatRequests().some(isTask) ? true : undefined),
      'task stage dispatched'
    )
    return sid
  }

  it('E-5 在飞时按停止：abort 5 秒内落定，且不多出一条错误气泡', async () => {
    // 用户自己按的停止不属于「无从解释的沉默」—— 管线的 step_aborted 分支就是为它写的
    const sid = await startHangingTask()

    const startedAt = Date.now()
    await expect(
      app.main.eval(`window.api.agent.abort(${JSON.stringify(sid)})`)
    ).resolves.toMatchObject({ success: true })
    expect(Date.now() - startedAt).toBeLessThan(5_000)

    provider.release()
    // 给脱手跑完的脚本一点时间去犯错（它若没走 step_aborted 分支就会在这里出声）
    await new Promise((r) => setTimeout(r, 800))
    expect((await listMessages(sid)).filter((m) => m.role === 'assistant')).toHaveLength(0)
  })

  it('E-6 在飞时删会话：消息与附件目录随之消失，进程没有未处理异常', async () => {
    // 会师点的全部意义：Promise 落定时保证不会再有人往这条会话里写。少了它，被删掉的
    // 数据会被一条还在收尾的管线重新写出来 —— 一个再也回不到列表里的孤儿会话。
    //
    // v2 的观测面换了两处：会话树 jsonl 不再存在（聊天会话是 chat_messages 表），
    // 附件目录取而代之成为**磁盘上**唯一能被残骸重建的东西
    const sid = await startHangingTask(true)
    const attachmentsDir = join(app.home, 'userdata', 'data', 'chat-attachments', sid)
    const treeFile = join(app.home, 'userdata', 'data', 'sessions', `${sid}.jsonl`)
    expect(existsSync(attachmentsDir)).toBe(true)
    // 顺带钉住形态：聊天会话从来不建会话树文件
    expect(existsSync(treeFile)).toBe(false)
    expect((await listMessages(sid)).length).toBeGreaterThan(0)

    await app.main.eval(`window.api.session.delete(${JSON.stringify(sid)})`)
    provider.release()
    await new Promise((r) => setTimeout(r, 800))

    expect(existsSync(attachmentsDir)).toBe(false)
    expect(await app.main.eval(`window.api.session.getById(${JSON.stringify(sid)})`)).toBeFalsy()
    // 主进程还活着并且照常服务（未处理异常会让 Electron 主进程崩掉，下面这句就取不到值）
    expect(
      typeof (await app.main.eval<string>(`window.api.session.create({}).then((s) => s.id)`))
    ).toBe('string')
  })
})
