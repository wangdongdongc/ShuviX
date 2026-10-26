/**
 * 一条会话的脱敏（durable/sessionRedaction.ts，docs/auto-redaction-design.md §2）：真宿主 + faux 模型。
 *
 *   SR-1 用户输入：模型看到的、对话记录里存的都是占位符；对照表记下真值
 *   SR-2 工具结果（afterTool）：模型看到的输出与存下的 details 都是占位符
 *   SR-3 通知：存下的是占位符
 *   SR-4 还原：参数里的占位符（含写坏的形式）换回真值、报出还原了哪些类别；解不开的报为不可用
 *   SR-5 跨会话：内容流进别的会话时，引用到的表项复制过去
 *   SR-6 同一个值沿用表里已有的占位符；没配脱敏的会话什么都不换
 */
import { createHmac } from 'node:crypto'
import { Type } from '@earendil-works/pi-ai'
import { defineTool, type ToolRegistration } from '@earendil-works/pi-durable'
import { describe, expect, it } from 'vitest'
import { backgroundContext as BG } from '../context'
import { RedactionTableDoc } from '../docs'
import type { DurableSession } from '../durableSession'
import { SessionRedaction, type RedactionHost } from '../sessionRedaction'
import { answer, callTool } from './support/faux'
import { makeHost, registerHostCleanup } from './support/host'
import { allEntries, requestTexts } from './support/transcript'
import { waitFor } from './support/wait'

registerHostCleanup()

const host: RedactionHost = {
  signer: { sign: (data) => createHmac('sha256', 'test-key').update(data).digest() },
  vault: {
    seal: (v) => `SEALED:${Buffer.from(v).toString('base64')}`,
    open: (s) => {
      if (!s.startsWith('SEALED:')) throw new Error('cannot open')
      return Buffer.from(s.slice(7), 'base64').toString()
    }
  }
}

const PASSWORD = 'Tr0ub4dor&3xq'
const KEY = 'sk-proj-' + 'A1b2C3d4E5f6G7h8I9j0K1l2'

const PLACEHOLDER = /\{\{[A-Z_]+_[a-z2-7]{8}\}\}/

/** 存下的条目里所有文本（模型消息与 data），拼成一串 */
async function storedText(session: DurableSession): Promise<string> {
  return JSON.stringify(await allEntries(await session.currentConversation()))
}

const envTool = (): ToolRegistration =>
  defineTool({
    name: 'read_env',
    description: 'reads .env',
    parameters: Type.Object({}),
    execute: async () => ({
      output: [{ type: 'text', text: `OPENAI_API_KEY=${KEY}\nPORT=3000` }],
      details: { raw: `OPENAI_API_KEY=${KEY}` }
    })
  })

describe('会话脱敏', () => {
  it('SR-1 用户输入：模型与记录里都是占位符，对照表有真值', async () => {
    const t = await makeHost({ ephemeral: ['sr1'], redaction: host })
    const session = await t.open('sr1')
    t.kit.queue(answer('ok'))
    expect(await session.submitUser(`连上去，DB_PASSWORD=${PASSWORD}`)).toEqual({})
    const seen = requestTexts(t.kit, 0).join('\n')
    expect(seen).not.toContain(PASSWORD)
    expect(seen).toMatch(PLACEHOLDER)
    const stored = await storedText(session)
    expect(stored).not.toContain(PASSWORD)
    const table = await session.redaction!.table()
    expect([...table.entries()].map(([, item]) => item.value)).toEqual([PASSWORD])
  })

  it('SR-2 工具结果：模型看到的输出与存下的 details 都是占位符', async () => {
    const t = await makeHost({ ephemeral: ['sr2'], redaction: host, tools: [envTool()] })
    const session = await t.open('sr2')
    t.kit.queue(callTool('read_env'), answer('done'))
    expect(await session.submitUser('read the env file')).toEqual({})
    await waitFor(() => t.kit.requests.length >= 2)
    const seen = requestTexts(t.kit, 1).join('\n')
    expect(seen).not.toContain(KEY)
    expect(seen).toMatch(/OPENAI_API_KEY=\{\{API_KEY_[a-z2-7]{8}\}\}/)
    const stored = await storedText(session)
    expect(stored).not.toContain(KEY)
    expect(stored).toContain('PORT=3000')
  })

  it('SR-3 通知：存下的是占位符', async () => {
    const t = await makeHost({ ephemeral: ['sr3'], redaction: host, noticeCoalesceMs: 0 })
    const session = await t.open('sr3')
    t.kit.queue(answer('first'))
    await session.submitUser('hello')
    const result = await session.writeNotice({
      text: `background job printed ${KEY}`,
      kind: 'background'
    })
    expect(result.status).toBe('submitted')
    await waitFor(async () => (await storedText(session)).includes('background job printed'))
    expect(await storedText(session)).not.toContain(KEY)
  })

  it('SR-4 还原：占位符（含写坏的形式）换回真值、报类别；解不开的报为不可用', async () => {
    const t = await makeHost({ ephemeral: ['sr4'], redaction: host })
    const session = await t.open('sr4')
    const redaction = session.redaction!
    const masked = await redaction.maskText(`key ${KEY} and pass DB_PASSWORD=${PASSWORD}`)
    const keyPlaceholder = masked.match(/\{\{API_KEY_[a-z2-7]{8}\}\}/)![0]
    const body = keyPlaceholder.slice(2, -2)
    const outcome = await redaction.restoreJson({
      command: `curl -H "Authorization: Bearer ${keyPlaceholder}" x`,
      nested: [{ v: `{{ ${body} }}` }, body.toLowerCase().replace(/^api_key/, 'api_key')],
      n: 3
    })
    expect(outcome.value).toEqual({
      command: `curl -H "Authorization: Bearer ${KEY}" x`,
      nested: [{ v: KEY }, KEY],
      n: 3
    })
    expect(outcome.restored).toEqual(['API_KEY'])
    expect(outcome.unavailable).toEqual([])

    // 外人写进去一项解不开的；新读出的对照表里它在、但没有真值 → 引用它的参数报为不可用
    await session.harness.commit(async (tx) => {
      const doc = await tx.doc(RedactionTableDoc)
      doc.items['{{SECRET_aaaaaaaa}}'] = {
        category: 'SECRET',
        rule: 'secret-field',
        value: 'garbage'
      }
    }, BG)
    const reread = new SessionRedaction({
      sessionId: 'sr4',
      harness: session.harness,
      host,
      logger: { info: () => {}, warn: () => {}, error: () => {} }
    })
    const blocked = await reread.restoreJson({ text: 'echo {{SECRET_aaaaaaaa}} > .env' })
    expect(blocked.unavailable).toEqual(['{{SECRET_aaaaaaaa}}'])
    expect(blocked.value).toEqual({ text: 'echo {{SECRET_aaaaaaaa}} > .env' })
  })

  it('SR-5 跨会话：引用到的表项复制到对方的表里', async () => {
    const t = await makeHost({ ephemeral: ['from', 'to'], redaction: host })
    const from = await t.open('from')
    const to = await t.open('to')
    const text = await from.redaction!.maskText(`use ${KEY}`)
    expect(await to.redaction!.restoreJson(text)).toMatchObject({ value: text, restored: [] })
    await to.redaction!.importFrom(from.redaction!, [text])
    expect((await to.redaction!.restoreJson(text)).value).toBe(`use ${KEY}`)
  })

  it('SR-6 同一个值沿用已有占位符；没配脱敏的会话不换', async () => {
    const t = await makeHost({ ephemeral: ['sr6'], redaction: host })
    const session = await t.open('sr6')
    const a = await session.redaction!.maskText(`OPENAI_API_KEY=${KEY}`)
    const b = await session.redaction!.maskText(`then ${KEY} again`)
    const pa = a.match(PLACEHOLDER)![0]
    expect(b).toContain(pa)

    const plain = await makeHost({ ephemeral: ['plain'] })
    const other = await plain.open('plain')
    expect(other.redaction).toBeUndefined()
    plain.kit.queue(answer('ok'))
    await other.submitUser(`DB_PASSWORD=${PASSWORD}`)
    expect(requestTexts(plain.kit, 0).join('\n')).toContain(PASSWORD)
  })
})
