/**
 * 聊天会话（`settings.bots` 非空 = **无根会话**）的端到端语义（M3′ / v3）：
 *
 *   - 没有根 Agent：`agent.getInfo` 连 `{ ensure: true }` 都是 null，而 `agent.init`
 *     照常成功（打开会话不该报错）；
 *   - **没有开场白**（v3）：`session.create` resolve 时会话里零条消息，加成员也不补任何消息；
 *   - 发消息只落一条 user 消息、只广播 user_message，**不派发任何管线**；
 *   - 档案切换、引导/追加/下一轮对它一律拒绝或安静早退；
 *   - 署名自带 displayName：bot md 被删或改名，历史消息的署名不变；
 *   - 清空 / 回退 / 删除三处的 `abortSession` 会师点不抛。
 *
 * v2 起聊天会话的存储是 `chat_messages` 表（一行一条消息，`authorKind` 分 user/bot/system），
 * 不再是会话树 JSONL —— 所以「回退越过署名侧车」那类断言换成了表的语义（删掉这条及其之后），
 * 而「不留空 jsonl」变成了更强的一句：聊天会话**从头到尾**不建那个文件。
 *
 * 全程 no-LLM：需要一条 bot 消息做语料的用例（署名 / 回退）让成员指向 `s-say-probe` ——
 * 一份只 `say` 一句的探针管线（v3 没有开场白之后，这是零 LLM 拿到 bot 消息的唯一办法）。
 * 断言走 IPC + 事件录制器，不碰 DOM。
 */
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { launchApp, type E2EApp } from '../../harness/launch'
import {
  createBotSession,
  eventRecorder,
  promptBotSession,
  waitRendererReady,
  writeBotMd,
  type EventRecorder,
  type RecordedEvent
} from '../../harness/seed'

let app: E2EApp
let events: EventRecorder

/** 只 say 一句的探针管线（零 LLM）；说什么由各 bot md 的 shuvix-bot-input 给 */
const PROBE = 's-say-probe'
const PROBE_MD = [
  '---',
  'shuvix: workflow v1',
  `name: ${PROBE}`,
  'description: session e2e probe — say one line, zero LLM.',
  'shuvix-workflow-concurrency: parallel',
  '---',
  '',
  '会话语义探针：只 say 一句。v3 没有开场白，bot 消息只能这样零 LLM 地造出来。',
  '',
  '```js workflow',
  "await say(input.sayLine || 'ok')",
  "return { outcome: 'reply' }",
  '```',
  ''
].join('\n')

/** 只声明本 spec 会读的字段 */
interface Msg {
  id: string
  role?: string
  content?: unknown
  metadata?: { sender?: { kind: string; name: string; displayName: string } } | null
}

const listMessages = (sid: string): Promise<Msg[]> =>
  app.main.eval(`window.api.message.list(${JSON.stringify(sid)})`)

const getInfo = (sid: string, ensure = false): Promise<unknown> =>
  app.main.eval(
    `window.api.agent.getInfo(${JSON.stringify(sid)}${ensure ? ', { ensure: true }' : ''})`
  )

const getSettings = (sid: string): Promise<Record<string, unknown> | undefined> =>
  app.main.eval(`window.api.session.getById(${JSON.stringify(sid)}).then((s) => s && s.settings)`)

/** 该会话上录到的事件类型序列 */
async function typesFor(sid: string): Promise<string[]> {
  const all = await events.all<RecordedEvent>()
  return all.filter((e) => e.sessionId === sid).map((e) => e.type)
}

/** 落一个探针 bot（一句话回复，零 LLM），返回文件路径 */
function sayBot(name: string, displayName: string, sayLine: string): string {
  return writeBotMd(app, name, {
    description: `says one line (${name})`,
    displayName,
    pipeline: PROBE,
    botInput: { sayLine }
  })
}

beforeAll(async () => {
  app = await launchApp()
  await waitRendererReady(app.main)
  events = eventRecorder(app.main)
  await events.install()

  const wfDir = join(app.home, '.shuvix', 'workflows')
  mkdirSync(wfDir, { recursive: true })
  writeFileSync(join(wfDir, `${PROBE}.md`), PROBE_MD)

  writeBotMd(app, 'e2e-alpha', { description: 'alpha bot', displayName: 'Alpha' })
  writeBotMd(app, 'e2e-beta', { description: 'beta bot', displayName: 'Beta' })
  writeBotMd(app, 'e2e-silent', { description: 'silent bot', displayName: 'Silent' })
  sayBot('e2e-sayer', 'Sayer', 'sayer 报到')
}, 120_000)

afterAll(async () => {
  await app?.stop()
})

describe('聊天会话 = 无根会话', () => {
  it('创建之后 agent.getInfo 与 getInfo({ensure:true}) 均为 null', async () => {
    const sid = await createBotSession(app.main, { bots: ['e2e-alpha'] })
    expect(await getInfo(sid)).toBeNull()
    // ensure 走到 create 注入拿到 null 档案后返回 undefined，不是抛
    expect(await getInfo(sid, true)).toBeNull()
  })

  it('agent.init 仍然成功并给出默认 provider/model/workingDirectory', async () => {
    const sid = await createBotSession(app.main, { bots: ['e2e-alpha'] })
    const res = await app.main.eval<{
      success: boolean
      created: boolean
      workingDirectory: string
    }>(`window.api.agent.init({ sessionId: ${JSON.stringify(sid)} })`)
    expect(res.success).toBe(true)
    expect(res.created).toBe(false)
    expect(res.workingDirectory).toBeTruthy()
  })

  it('新建的聊天会话零条消息 —— 没有开场白（v3），多成员也一样', async () => {
    // v2 的开场白（`shuvix-bot-greeting`）随 bot 变成「绑定」一并退场：一个 bot 没有自己
    // 的台词，只有人设与记忆；会话从用户的第一句开始
    const one = await createBotSession(app.main, { bots: ['e2e-alpha'] })
    expect(await listMessages(one)).toEqual([])

    const many = await createBotSession(app.main, {
      bots: ['e2e-beta', 'e2e-silent', 'e2e-alpha']
    })
    expect(await listMessages(many)).toEqual([])
    expect((await getSettings(many))?.bots).toEqual(['e2e-beta', 'e2e-silent', 'e2e-alpha'])
  })

  it('发一条消息：user 行先落库，随后管线起跑（首个事件恒为 user_message）', async () => {
    const sid = await createBotSession(app.main, { bots: ['e2e-alpha'] })
    await events.clear()

    const msgs = await promptBotSession(app.main, sid, 'e2e bot hello')
    // prompt resolve 时用户消息已经落库（bot 的回复可能还在路上，那是 pipeline.e2e 的事）
    expect(msgs.some((m) => m.role === 'user' && m.content === 'e2e bot hello')).toBe(true)
    // 顺序契约：先 append 拿到 id 再广播 —— user_message 恒为这一轮的第一个事件
    expect((await typesFor(sid))[0]).toBe('user_message')
  })

  it('发消息之后仍然没有根 Agent（没偷偷建）', async () => {
    const sid = await createBotSession(app.main, { bots: ['e2e-alpha'] })
    await promptBotSession(app.main, sid, 'still rootless')
    expect(await getInfo(sid)).toBeNull()
  })

  it('updateAgentProfile 被拒且会话设置分毫不动', async () => {
    const sid = await createBotSession(app.main, { bots: ['e2e-alpha'] })
    const res = await app.main.eval<{ success: boolean; error?: string }>(
      `window.api.session.updateAgentProfile({ id: ${JSON.stringify(sid)}, name: 'coding' })`
    )
    expect(res.success).toBe(false)
    expect(res.error).toMatch(/no root agent/i)
    expect((await getSettings(sid))?.agentProfile).toBeUndefined()
  })

  it('bots: [] 创建出来的是普通会话（空数组不写键、不劫持根 Agent）', async () => {
    const sid = await createBotSession(app.main, { bots: [] })
    const settings = await getSettings(sid)
    expect(settings && 'bots' in settings).toBe(false)

    expect(await getInfo(sid, true)).not.toBeNull()
    const res = await app.main.eval<{ success: boolean }>(
      `window.api.session.updateAgentProfile({ id: ${JSON.stringify(sid)}, name: 'coding' })`
    )
    expect(res.success).toBe(true)
  })
})

describe('署名自带 displayName —— 历史不因配置变动而改写', () => {
  /** 该会话第一条 bot 消息的署名 */
  const firstSender = async (sid: string): Promise<Msg['metadata']> =>
    (await listMessages(sid)).find((m) => m.role === 'assistant')?.metadata

  it('删掉 bot md 之后，老消息仍显示当初的署名', async () => {
    const filePath = sayBot('e2e-doomed', 'Doomed', 'doomed 报到')
    const sid = await createBotSession(app.main, { bots: ['e2e-doomed'] })
    // 探针管线零 LLM；聊天会话的 prompt 直到 cohort 收尾才 resolve，回复此刻已在库里
    await promptBotSession(app.main, sid, '报到')
    expect((await firstSender(sid))?.sender?.displayName).toBe('Doomed')

    unlinkSync(filePath)
    expect(existsSync(filePath)).toBe(false)
    expect((await firstSender(sid))?.sender).toMatchObject({
      name: 'e2e-doomed',
      displayName: 'Doomed'
    })
  })

  it('改 bot 的 shuvix-displayName 之后，老消息不跟着变', async () => {
    sayBot('e2e-renamed', 'OldName', 'renamed 报到')
    const sid = await createBotSession(app.main, { bots: ['e2e-renamed'] })
    await promptBotSession(app.main, sid, '报到')
    expect((await firstSender(sid))?.sender?.displayName).toBe('OldName')

    sayBot('e2e-renamed', 'NewName', 'renamed 报到')
    expect((await firstSender(sid))?.sender?.displayName).toBe('OldName')
  })
})

describe('引导/追加/中止/清空/回退/删除对聊天会话的安全性', () => {
  it('steer / followUp / nextTurn 安静早退：不抛，也不产生 error 事件', async () => {
    const sid = await createBotSession(app.main, { bots: ['e2e-alpha'] })
    await events.clear()

    await app.main.eval(
      `(async () => {
        const id = ${JSON.stringify(sid)}
        await window.api.agent.steer({ sessionId: id, text: 'steer' })
        await window.api.agent.followUp({ sessionId: id, text: 'followUp' })
        await window.api.agent.nextTurn({ sessionId: id, text: 'nextTurn' })
      })()`
    )
    // 今天的行为是完全静默（按钮的隐藏归 A2）；改成显式提示时这条要一起改
    expect(await typesFor(sid)).toEqual([])
  })

  it('agent.abort 不抛（对聊天会话并列停掉在飞管线）', async () => {
    const sid = await createBotSession(app.main, { bots: ['e2e-alpha'] })
    await expect(
      app.main.eval(`window.api.agent.abort(${JSON.stringify(sid)})`)
    ).resolves.toMatchObject({ success: true })
  })

  it('message.clear 之后可继续发消息', async () => {
    const sid = await createBotSession(app.main, { bots: ['e2e-alpha'] })
    await app.main.eval(`window.api.message.clear(${JSON.stringify(sid)})`)
    expect(await listMessages(sid)).toEqual([])

    const msgs = await promptBotSession(app.main, sid, 'after clear')
    expect(msgs.map((m) => m.content)).toContain('after clear')
  })

  it('message.rollback 回退到 bot 消息：这条及其之后一并撤回，之后照常能发', async () => {
    // 群聊里「回退」就是撤回这条与后续 —— 表上是一句 `seq >= ?` 的删除，没有会话树那种
    // 「保留旧分支」（这里既没有 regenerate 的分叉需求，也没有压缩）
    const sid = await createBotSession(app.main, { bots: ['e2e-sayer'] })
    await promptBotSession(app.main, sid, '先来一句')
    // 走本 spec 自己那个带 sender 类型的 listMessages —— harness 的返回值是宽松形状
    const msgs = await listMessages(sid)
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant'])
    const reply = msgs[1]
    expect(reply.metadata?.sender?.name).toBe('e2e-sayer')

    await app.main.eval(
      `window.api.message.rollback({ sessionId: ${JSON.stringify(sid)}, messageId: ${JSON.stringify(
        reply.id
      )} })`
    )
    // 回退到 bot 那条：它没了，它前面的用户消息还在
    expect((await listMessages(sid)).map((m) => m.id)).toEqual([msgs[0].id])

    // 回退不该在会话上留下任何会污染下一条消息的残留：用户消息就是用户消息，没有署名
    await promptBotSession(app.main, sid, 'after rollback')
    const user = (await listMessages(sid)).find((m) => m.content === 'after rollback')!
    expect(user.role).toBe('user')
    expect(user.metadata?.sender).toBeUndefined()
  })

  it('session.delete 聊天会话不抛，会话随之消失', async () => {
    const sid = await createBotSession(app.main, { bots: ['e2e-alpha'] })
    await app.main.eval(`window.api.session.delete(${JSON.stringify(sid)})`)
    expect(await app.main.eval(`window.api.session.getById(${JSON.stringify(sid)})`)).toBeFalsy()
  })

  it('聊天会话自始至终不建会话树文件（发过消息、按过停止都不建）', async () => {
    // v1 这条问的是「drain 会不会顺手把空 jsonl 建出来」（它曾借写锁实现，锁体里的
    // ensureSessionTree 会造文件）。v2 的判据强了一档也简单了一档：聊天会话的存储是
    // chat_messages 表，那条路径根本不该碰 sessions/ 目录 —— 建出文件即回归
    const sid = await createBotSession(app.main, { bots: ['e2e-silent'] })
    const file = join(app.home, 'userdata', 'data', 'sessions', `${sid}.jsonl`)
    expect(existsSync(file)).toBe(false)

    await promptBotSession(app.main, sid, '发一条看看')
    expect(existsSync(file)).toBe(false)

    await app.main.eval(`window.api.agent.abort(${JSON.stringify(sid)})`)
    expect(existsSync(file)).toBe(false)
  })
})

describe('updateBots —— 中途增删成员', () => {
  const updateBots = (
    sid: string,
    bots: string[]
  ): Promise<{ success: boolean; error?: string; bots?: string[]; added?: string[] }> =>
    app.main.eval(
      `window.api.session.updateBots({ id: ${JSON.stringify(sid)}, bots: ${JSON.stringify(bots)} })`
    )

  it('加一个成员：名单落库，消息列表分毫不动（v3 没有开场白可补）', async () => {
    const sid = await createBotSession(app.main, { bots: ['e2e-alpha'] })
    expect(await listMessages(sid)).toEqual([])

    const res = await updateBots(sid, ['e2e-alpha', 'e2e-beta'])
    expect(res).toMatchObject({ success: true, added: ['e2e-beta'] })
    expect((await getSettings(sid))?.bots).toEqual(['e2e-alpha', 'e2e-beta'])
    // 新成员不往会话里塞任何东西：名单变了，对话没变
    expect(await listMessages(sid)).toEqual([])
  })

  it('删一个成员：名单变短，历史消息与署名分毫不动', async () => {
    const sid = await createBotSession(app.main, { bots: ['e2e-sayer', 'e2e-beta'] })
    // 先造一条带署名的历史（只点名 sayer，beta 不派发）
    await promptBotSession(app.main, sid, '@Sayer 报到')
    const before = await listMessages(sid)
    expect(before.some((m) => m.metadata?.sender?.name === 'e2e-sayer')).toBe(true)

    expect(await updateBots(sid, ['e2e-beta'])).toMatchObject({ success: true, added: [] })
    expect((await getSettings(sid))?.bots).toEqual(['e2e-beta'])
    // 移除成员不动历史：老消息连署名带 id 都不变
    expect(await listMessages(sid)).toEqual(before)
  })

  it('成员 md 全被删之后仍能把名单改回可用的（逃生口）', async () => {
    const filePath = sayBot('e2e-gone', 'Gone', 'gone 报到')
    const sid = await createBotSession(app.main, { bots: ['e2e-gone'] })
    await promptBotSession(app.main, sid, '报到')
    unlinkSync(filePath)

    // 会话仍是聊天会话（判定只看名单非空），所以 updateBots 够得着它
    expect(await updateBots(sid, ['e2e-alpha'])).toMatchObject({ success: true })
    expect((await getSettings(sid))?.bots).toEqual(['e2e-alpha'])
    // 老消息的署名不因成员被移除而改写
    const reply = (await listMessages(sid)).find((m) => m.role === 'assistant')!
    expect(reply.metadata?.sender?.displayName).toBe('Gone')
  })

  it('空名单与非聊天会话都被拒（形态不被顺手改掉）', async () => {
    const chat = await createBotSession(app.main, { bots: ['e2e-alpha'] })
    const empty = await updateBots(chat, [])
    expect(empty.success).toBe(false)
    expect((await getSettings(chat))?.bots).toEqual(['e2e-alpha'])

    const plain = await createBotSession(app.main, { bots: [] })
    const res = await updateBots(plain, ['e2e-alpha'])
    expect(res.success).toBe(false)
    expect((await getSettings(plain))?.bots).toBeUndefined()
  })
})
