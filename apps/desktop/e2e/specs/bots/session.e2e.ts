/**
 * 聊天会话（`settings.bot` 有值 = **无根会话**，绑定一个 bot）的端到端语义：
 *
 *   - 没有根 Agent：`agent.getInfo` 连 `{ ensure: true }` 都是 null，而 `agent.init`
 *     照常成功（打开会话不该报错）；
 *   - **没有开场白**：`session.create` resolve 时会话里零条消息；
 *   - 发消息只落一条 user 消息、先广播 user_message，随后绑定的 bot 的管线起跑；
 *   - 档案切换、引导/追加/下一轮对它一律拒绝或安静早退；
 *   - 署名自带 displayName：bot md 被删或改名，历史消息的署名不变；
 *   - 清空 / 回退 / 删除三处的 `abortSession` 会师点不抛；
 *   - `session.setBot`：只对聊天会话（含群聊时代遗留、只有 `bots` 名单的未绑定会话）生效，
 *     名字去空白且非空即写 `bot`，不校验它是否存在；遗留的 `bots` 只读不动。
 *
 * 聊天会话的存储是 `chat_messages` 表（一行一条消息，`authorKind` 分 user/bot/system），
 * 不是会话树 JSONL —— 所以「回退越过署名侧车」那类断言换成了表的语义（删掉这条及其之后），
 * 而「不留空 jsonl」变成了更强的一句：聊天会话**从头到尾**不建那个文件。
 *
 * 全程 no-LLM：需要一条 bot 消息做语料的用例（署名 / 回退 / 重新绑定）让 bot 指向
 * `s-say-probe` —— 一份只 `say` 一句的探针管线（没有开场白之后，这是零 LLM 拿到 bot 消息的
 * 唯一办法）。断言走 IPC + 事件录制器，不碰 DOM。
 */
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { launchApp, type E2EApp } from '../../harness/launch'
import {
  createBotSession,
  createLegacyBotSession,
  eventRecorder,
  promptBotSession,
  waitRendererReady,
  writeBotMd,
  type EventRecorder,
  type RecordedEvent
} from '../../harness/seed'

let app: E2EApp
let events: EventRecorder

/** 只 say 一句的探针管线（零 LLM）；说什么由各 bot md 的 shuvix-bot-pipeline.input 给 */
const PROBE = 's-say-probe'
const PROBE_MD = [
  '---',
  'shuvix: workflow v1',
  `name: ${PROBE}`,
  'description: session e2e probe — say one line, zero LLM.',
  'shuvix-workflow-concurrency: parallel',
  '---',
  '',
  '会话语义探针：只 say 一句。没有开场白，bot 消息只能这样零 LLM 地造出来。',
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

/** 经 IPC 建一条**普通**会话（params 原样透传，测 `bot` 空白 / 缺席的形态判定） */
const createPlainSession = (params: Record<string, unknown>): Promise<string> =>
  app.main.eval(`window.api.session.create(${JSON.stringify(params)}).then((s) => s.id)`)

const updateAgentProfile = (
  sid: string,
  name: string
): Promise<{ success: boolean; error?: string }> =>
  app.main.eval(
    `window.api.session.updateAgentProfile({ id: ${JSON.stringify(sid)}, name: ${JSON.stringify(name)} })`
  )

const setBot = (sid: string, bot: string): Promise<{ success: boolean; error?: string }> =>
  app.main.eval(
    `window.api.session.setBot({ id: ${JSON.stringify(sid)}, bot: ${JSON.stringify(bot)} })`
  )

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
  writeBotMd(app, 'e2e-silent', { description: 'silent bot', displayName: 'Silent' })
  sayBot('e2e-sayer', 'Sayer', 'sayer 报到')
}, 120_000)

afterAll(async () => {
  await app?.stop()
})

describe('聊天会话 = 无根会话', () => {
  it('创建之后 agent.getInfo 与 getInfo({ensure:true}) 均为 null', async () => {
    const sid = await createBotSession(app.main, { bot: 'e2e-alpha' })
    expect(await getInfo(sid)).toBeNull()
    // ensure 走到 create 注入拿到 null 档案后返回 undefined，不是抛
    expect(await getInfo(sid, true)).toBeNull()
  })

  it('agent.init 仍然成功并给出默认 provider/model/workingDirectory', async () => {
    const sid = await createBotSession(app.main, { bot: 'e2e-alpha' })
    const res = await app.main.eval<{
      success: boolean
      created: boolean
      workingDirectory: string
    }>(`window.api.agent.init({ sessionId: ${JSON.stringify(sid)} })`)
    expect(res.success).toBe(true)
    expect(res.created).toBe(false)
    expect(res.workingDirectory).toBeTruthy()
  })

  it('新建的聊天会话零条消息 —— 没有开场白；settings 只写 bot，没有群聊时代的 bots 名单', async () => {
    // 开场白（`shuvix-bot-greeting`）随 bot 变成「绑定」一并退场：一个 bot 没有自己的台词，
    // 只有人设与记忆；会话从用户的第一句开始。绑定是一个名字（`bot`），不是名单
    const sid = await createBotSession(app.main, { bot: 'e2e-alpha' })
    expect(await listMessages(sid)).toEqual([])

    const settings = (await getSettings(sid))!
    expect(settings.bot).toBe('e2e-alpha')
    expect('bots' in settings).toBe(false)
  })

  it('发一条消息：user 行先落库，随后管线起跑（首个事件恒为 user_message）', async () => {
    const sid = await createBotSession(app.main, { bot: 'e2e-alpha' })
    await events.clear()

    const msgs = await promptBotSession(app.main, sid, 'e2e bot hello')
    // prompt resolve 时用户消息已经落库（bot 的回复可能还在路上，那是 pipeline.e2e 的事）
    expect(msgs.some((m) => m.role === 'user' && m.content === 'e2e bot hello')).toBe(true)
    // 顺序契约：先 append 拿到 id 再广播 —— user_message 恒为这一轮的第一个事件
    expect((await typesFor(sid))[0]).toBe('user_message')
  })

  it('发消息之后仍然没有根 Agent（没偷偷建）', async () => {
    const sid = await createBotSession(app.main, { bot: 'e2e-alpha' })
    await promptBotSession(app.main, sid, 'still rootless')
    expect(await getInfo(sid)).toBeNull()
  })

  it('updateAgentProfile 被拒且会话设置分毫不动', async () => {
    const sid = await createBotSession(app.main, { bot: 'e2e-alpha' })
    const res = await updateAgentProfile(sid, 'coding')
    expect(res.success).toBe(false)
    expect(res.error).toMatch(/no root agent/i)
    expect((await getSettings(sid))?.agentProfile).toBeUndefined()
  })

  it('bot 空白或缺席时创建出来的是普通会话（不写键、不劫持根 Agent）', async () => {
    // 空串 / 空白视同没给：形态判定只认一个非空的名字，别让 `'   '` 造出一个无根却
    // 没人应答的会话
    for (const params of [{ bot: '   ' }, {}]) {
      const sid = await createPlainSession(params)
      const settings = await getSettings(sid)
      expect(settings && 'bot' in settings).toBe(false)

      expect(await getInfo(sid, true)).not.toBeNull()
      expect((await updateAgentProfile(sid, 'coding')).success).toBe(true)
    }
  })
})

describe('署名自带 displayName —— 历史不因配置变动而改写', () => {
  /** 该会话第一条 bot 消息的署名 */
  const firstSender = async (sid: string): Promise<Msg['metadata']> =>
    (await listMessages(sid)).find((m) => m.role === 'assistant')?.metadata

  it('删掉 bot md 之后，老消息仍显示当初的署名', async () => {
    const filePath = sayBot('e2e-doomed', 'Doomed', 'doomed 报到')
    const sid = await createBotSession(app.main, { bot: 'e2e-doomed' })
    // 探针管线零 LLM；聊天会话的 prompt 直到管线收尾才 resolve，回复此刻已在库里
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
    const sid = await createBotSession(app.main, { bot: 'e2e-renamed' })
    await promptBotSession(app.main, sid, '报到')
    expect((await firstSender(sid))?.sender?.displayName).toBe('OldName')

    sayBot('e2e-renamed', 'NewName', 'renamed 报到')
    expect((await firstSender(sid))?.sender?.displayName).toBe('OldName')
  })
})

describe('引导/追加/中止/清空/回退/删除对聊天会话的安全性', () => {
  it('steer / followUp / nextTurn 安静早退：不抛，也不产生 error 事件', async () => {
    const sid = await createBotSession(app.main, { bot: 'e2e-alpha' })
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
    const sid = await createBotSession(app.main, { bot: 'e2e-alpha' })
    await expect(
      app.main.eval(`window.api.agent.abort(${JSON.stringify(sid)})`)
    ).resolves.toMatchObject({ success: true })
  })

  it('message.clear 之后可继续发消息', async () => {
    const sid = await createBotSession(app.main, { bot: 'e2e-alpha' })
    await app.main.eval(`window.api.message.clear(${JSON.stringify(sid)})`)
    expect(await listMessages(sid)).toEqual([])

    const msgs = await promptBotSession(app.main, sid, 'after clear')
    expect(msgs.map((m) => m.content)).toContain('after clear')
  })

  it('message.rollback 回退到 bot 消息：这条及其之后一并撤回，之后照常能发', async () => {
    // 聊天会话里「回退」就是撤回这条与后续 —— 表上是一句 `seq >= ?` 的删除，没有会话树那种
    // 「保留旧分支」（这里既没有 regenerate 的分叉需求，也没有压缩）
    const sid = await createBotSession(app.main, { bot: 'e2e-sayer' })
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
    const sid = await createBotSession(app.main, { bot: 'e2e-alpha' })
    await app.main.eval(`window.api.session.delete(${JSON.stringify(sid)})`)
    expect(await app.main.eval(`window.api.session.getById(${JSON.stringify(sid)})`)).toBeFalsy()
  })

  it('聊天会话自始至终不建会话树文件（发过消息、按过停止都不建）', async () => {
    // v1 这条问的是「drain 会不会顺手把空 jsonl 建出来」（它曾借写锁实现，锁体里的
    // ensureSessionTree 会造文件）。判据现在强了一档也简单了一档：聊天会话的存储是
    // chat_messages 表，那条路径根本不该碰 sessions/ 目录 —— 建出文件即回归
    const sid = await createBotSession(app.main, { bot: 'e2e-silent' })
    const file = join(app.home, 'userdata', 'data', 'sessions', `${sid}.jsonl`)
    expect(existsSync(file)).toBe(false)

    await promptBotSession(app.main, sid, '发一条看看')
    expect(existsSync(file)).toBe(false)

    await app.main.eval(`window.api.agent.abort(${JSON.stringify(sid)})`)
    expect(existsSync(file)).toBe(false)
  })
})

describe('setBot —— 绑定的 IPC 语义（B7）', () => {
  it('B7a 重新绑定：settings.bot 换人，历史消息（连署名带 id）分毫不动，仍然无根', async () => {
    const sid = await createBotSession(app.main, { bot: 'e2e-sayer' })
    // 先造一条带署名的历史
    await promptBotSession(app.main, sid, '报到')
    const before = await listMessages(sid)
    expect(before.some((m) => m.metadata?.sender?.name === 'e2e-sayer')).toBe(true)

    expect(await setBot(sid, 'e2e-alpha')).toEqual({ success: true })
    expect((await getSettings(sid))?.bot).toBe('e2e-alpha')
    // 换人不动历史：老消息的署名是落库当时的事实，不随绑定改写
    expect(await listMessages(sid)).toEqual(before)
    expect(await getInfo(sid)).toBeNull()
  })

  it('B7b 拒绝：空白名字（形态不得被顺手改掉）与非聊天会话（有根会话不能中途换种）', async () => {
    const chat = await createBotSession(app.main, { bot: 'e2e-alpha' })
    expect(await setBot(chat, '  ')).toEqual({
      success: false,
      error: 'A chat session needs a bot'
    })
    expect((await getSettings(chat))?.bot).toBe('e2e-alpha')

    const plain = await createPlainSession({ title: 'B7-plain' })
    expect(await setBot(plain, 'e2e-alpha')).toEqual({
      success: false,
      error: 'Not a chat session'
    })
    const settings = await getSettings(plain)
    expect(settings && 'bot' in settings).toBe(false)
    // 普通会话照旧是有根的：没被拒绝顺手改成无根
    expect(await getInfo(plain, true)).not.toBeNull()
  })

  it('B7c 群聊时代遗留的会话（只有 bots 名单）：无根、不可切档案；setBot 写 bot，遗留名单不动', async () => {
    // 遗留会话没有做迁移：带着 `bots` 就仍是聊天会话，只是没绑定 —— setBot 是它唯一的出路
    const sid = await createLegacyBotSession(app, { bots: ['e2e-alpha'], title: 'B7-legacy' })
    expect(await getInfo(sid)).toBeNull()
    expect((await updateAgentProfile(sid, 'coding')).success).toBe(false)

    expect(await setBot(sid, 'e2e-alpha')).toEqual({ success: true })
    const settings = (await getSettings(sid))!
    expect(settings.bot).toBe('e2e-alpha')
    // 遗留键只读：绑定写 `bot`，`bots` 原样留着
    expect(settings.bots).toEqual(['e2e-alpha'])
  })

  it('B7d 不校验名字是否存在：绑一个没有 md 的名字也成功（缺失在会话里可见地失败，见 binding.e2e）', async () => {
    // 与 create 同口径：bot md 是纯 md 驱动的，用户随时可能删掉一个；名字存不存在不是
    // 绑定这一步该判的事
    const sid = await createBotSession(app.main, { bot: 'e2e-alpha' })
    expect(await setBot(sid, 'no-such-bot')).toEqual({ success: true })
    expect((await getSettings(sid))?.bot).toBe('no-such-bot')
  })
})
