/**
 * 聊天会话（`settings.bots` 非空 = **无根会话**）的端到端语义（M3′）：
 *
 *   - 没有根 Agent：`agent.getInfo` 连 `{ ensure: true }` 都是 null，而 `agent.init`
 *     照常成功（打开会话不该报错）；
 *   - 开场白在 `session.create` resolve 时即可见（IPC 改 async 就是为了这个）；
 *   - 发消息只落一条 user 消息、只广播 user_message，**不派发任何管线**；
 *   - 档案切换、引导/追加/下一轮对它一律拒绝或安静早退；
 *   - 署名自带 displayName：bot md 被删或改名，历史消息的署名不变；
 *   - 清空 / 回退 / 删除三处的 `abortSession` 会师点不抛。
 *
 * 全程 no-LLM（聊天会话的 prompt 根本不碰模型），断言走 IPC + 事件录制器，不碰 DOM。
 */
import { existsSync, unlinkSync } from 'node:fs'
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

beforeAll(async () => {
  app = await launchApp()
  await waitRendererReady(app.main)
  events = eventRecorder(app.main)
  await events.install()

  writeBotMd(app, 'e2e-alpha', {
    description: 'alpha bot',
    displayName: 'Alpha',
    greeting: 'alpha 打个招呼'
  })
  writeBotMd(app, 'e2e-beta', {
    description: 'beta bot',
    displayName: 'Beta',
    greeting: 'beta 打个招呼'
  })
  // 没写 greeting 的成员：播种时跳过
  writeBotMd(app, 'e2e-silent', { description: 'silent bot', displayName: 'Silent' })
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

  it('开场白在 session.create resolve 时即可见（不必等重载）', async () => {
    const sid = await createBotSession(app.main, { bots: ['e2e-alpha'] })
    const msgs = await listMessages(sid)
    expect(msgs.map((m) => m.content)).toEqual(['alpha 打个招呼'])
    expect(msgs[0].metadata?.sender).toMatchObject({
      kind: 'bot',
      name: 'e2e-alpha',
      displayName: 'Alpha'
    })
  })

  it('多成员开场白按名单顺序，没写 greeting 的成员被跳过', async () => {
    const sid = await createBotSession(app.main, {
      bots: ['e2e-beta', 'e2e-silent', 'e2e-alpha']
    })
    const msgs = await listMessages(sid)
    expect(msgs.map((m) => m.metadata?.sender?.name)).toEqual(['e2e-beta', 'e2e-alpha'])
  })

  it('发一条消息：只落 user 消息，事件序列恰为 [user_message]，不派发任何管线', async () => {
    const sid = await createBotSession(app.main, { bots: ['e2e-alpha'] })
    await events.clear()

    const msgs = await promptBotSession(app.main, sid, 'e2e bot hello')
    expect(msgs[msgs.length - 1]).toMatchObject({ role: 'user', content: 'e2e bot hello' })
    expect(await typesFor(sid)).toEqual(['user_message'])
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
  it('删掉 bot md 之后，老消息仍显示当初的署名', async () => {
    const filePath = writeBotMd(app, 'e2e-doomed', {
      description: 'about to be deleted',
      displayName: 'Doomed',
      greeting: 'doomed 打个招呼'
    })
    const sid = await createBotSession(app.main, { bots: ['e2e-doomed'] })
    expect((await listMessages(sid))[0].metadata?.sender?.displayName).toBe('Doomed')

    unlinkSync(filePath)
    expect(existsSync(filePath)).toBe(false)
    expect((await listMessages(sid))[0].metadata?.sender).toMatchObject({
      name: 'e2e-doomed',
      displayName: 'Doomed'
    })
  })

  it('改 bot 的 shuvix-displayName 之后，老消息不跟着变', async () => {
    writeBotMd(app, 'e2e-renamed', {
      description: 'about to be renamed',
      displayName: 'OldName',
      greeting: 'renamed 打个招呼'
    })
    const sid = await createBotSession(app.main, { bots: ['e2e-renamed'] })
    expect((await listMessages(sid))[0].metadata?.sender?.displayName).toBe('OldName')

    writeBotMd(app, 'e2e-renamed', {
      description: 'about to be renamed',
      displayName: 'NewName',
      greeting: 'renamed 打个招呼'
    })
    expect((await listMessages(sid))[0].metadata?.sender?.displayName).toBe('OldName')
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

  it('agent.abort 不抛（对聊天会话并列排空写锁）', async () => {
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
    expect(msgs.map((m) => m.content)).toEqual(['after clear'])
  })

  it('message.rollback 回退到 bot 消息之前，署名侧车一并越过', async () => {
    const sid = await createBotSession(app.main, { bots: ['e2e-alpha'] })
    const greeting = (await listMessages(sid))[0]
    expect(greeting.metadata?.sender?.name).toBe('e2e-alpha')

    await app.main.eval(
      `window.api.message.rollback({ sessionId: ${JSON.stringify(sid)}, messageId: ${JSON.stringify(
        greeting.id
      )} })`
    )
    expect(await listMessages(sid)).toEqual([])

    // 孤儿侧车若还留在叶子上，下一条消息就会被它错挂成 e2e-alpha
    await promptBotSession(app.main, sid, 'after rollback')
    const after = await listMessages(sid)
    expect(after).toHaveLength(1)
    expect(after[0].metadata?.sender).toBeUndefined()
  })

  it('session.delete 聊天会话不抛，会话随之消失', async () => {
    const sid = await createBotSession(app.main, { bots: ['e2e-alpha'] })
    await app.main.eval(`window.api.session.delete(${JSON.stringify(sid)})`)
    expect(await app.main.eval(`window.api.session.getById(${JSON.stringify(sid)})`)).toBeFalsy()
  })

  it('从未发过消息的会话按停止键不会留下空 jsonl', async () => {
    // drain 曾借写锁实现，锁体里的 ensureSessionTree 会把文件建出来 —— 违反
    // 「打开一个从未发过消息的会话不该在磁盘上留下空文件」。现在没有在飞写入即直接返回
    const sid = await createBotSession(app.main, { bots: ['e2e-silent'] })
    const file = join(app.home, 'userdata', 'data', 'sessions', `${sid}.jsonl`)
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

  it('加一个成员：名单落库，且只有新成员补开场白', async () => {
    const sid = await createBotSession(app.main, { bots: ['e2e-alpha'] })
    expect((await listMessages(sid)).map((m) => m.metadata?.sender?.name)).toEqual(['e2e-alpha'])

    const res = await updateBots(sid, ['e2e-alpha', 'e2e-beta'])
    expect(res).toMatchObject({ success: true, added: ['e2e-beta'] })
    // alpha 的开场白没有重播
    expect((await listMessages(sid)).map((m) => m.metadata?.sender?.name)).toEqual([
      'e2e-alpha',
      'e2e-beta'
    ])
    expect((await getSettings(sid))?.bots).toEqual(['e2e-alpha', 'e2e-beta'])
  })

  it('删一个成员：名单变短，历史消息与署名分毫不动', async () => {
    const sid = await createBotSession(app.main, { bots: ['e2e-alpha', 'e2e-beta'] })
    const before = await listMessages(sid)

    expect(await updateBots(sid, ['e2e-alpha'])).toMatchObject({ success: true, added: [] })
    expect((await getSettings(sid))?.bots).toEqual(['e2e-alpha'])
    // 移除成员不动历史：老消息连署名带 id 都不变
    expect(await listMessages(sid)).toEqual(before)
  })

  it('成员 md 全被删之后仍能把名单改回可用的（逃生口）', async () => {
    const filePath = writeBotMd(app, 'e2e-gone', {
      description: 'will be deleted',
      displayName: 'Gone',
      greeting: 'gone 打个招呼'
    })
    const sid = await createBotSession(app.main, { bots: ['e2e-gone'] })
    unlinkSync(filePath)

    // 会话仍是聊天会话（判定只看名单非空），所以 updateBots 够得着它
    expect(await updateBots(sid, ['e2e-alpha'])).toMatchObject({ success: true })
    expect((await getSettings(sid))?.bots).toEqual(['e2e-alpha'])
    // 老消息的署名不因成员被移除而改写
    expect((await listMessages(sid))[0].metadata?.sender?.displayName).toBe('Gone')
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
