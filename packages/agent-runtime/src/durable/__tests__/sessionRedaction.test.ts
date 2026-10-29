/**
 * 一条会话的脱敏（durable/sessionRedaction.ts，docs/auto-redaction-design.md §2）：真宿主 + faux 模型。
 *
 *   SR-1 用户输入：模型看到的、对话记录里存的都是占位符；对照表记下真值
 *   SR-2 工具结果（afterTool）：模型看到的输出与存下的 details 都是占位符
 *   SR-3 通知：存下的是占位符
 *   SR-4 还原：参数里的占位符（含写坏的形式）换回真值、报出还原了哪些类别；解不开的报为不可用
 *   SR-5 跨会话：内容流进别的会话时，引用到的表项复制过去
 *   SR-6 同一个值沿用表里已有的占位符；没配脱敏的会话什么都不换
 *   SR-7 默认照发的几类（USERNAME 等）照原样存，也不挤掉与之相邻的别的类别；表里已有它们的旧占位符也一样
 *   SR-8 输入框发来的（§14）：只换用户交来的值（紧贴别的字符也换），其余照原样发、记成照原样发（之后写入时也不再
 *        换）；显示侧车里的也换；之后工具输出里整词出现的短值也换；steer 同样
 *   SR-9 没配脱敏的会话：带着要藏的值的发送被拒，空的照发
 *   SR-10 还原进命令：按引号环境转义，转义后的写法记进已知值（回显时换得回占位符）；别的字段原样换
 *   SR-11 工具结果里默认照发的几类（§15.2）：对话最近一次请求的目的地要它们保持占位符 → 写入时就换；照发、不适用
 *         脱敏、还不知道目的地 → 照原样存；策略抛错 → 换。真宿主里出口记下判定，afterTool 按对话取用
 */
import { createHmac } from 'node:crypto'
import { Type } from '@earendil-works/pi-ai'
import { defineTool, type ToolRegistration } from '@earendil-works/pi-durable'
import { beforeAll, describe, expect, it } from 'vitest'
import { asWrittenKey } from '../../redaction/placeholder'
import { initShellParser } from '../../security/shell'
import { loadShellParserWasmFromNodeModules } from '../../security/shell/nodeWasm'
import { backgroundContext as BG } from '../context'
import { RedactionTableDoc } from '../docs'
import type { DurableSession } from '../durableSession'
import type { EgressDecision } from '../redactionEgress'
import { SessionRedaction, type RedactionHost } from '../sessionRedaction'
import { answer, callTool } from './support/faux'
import { makeHost, registerHostCleanup } from './support/host'
import { allEntries, requestTexts } from './support/transcript'
import { waitFor } from './support/wait'

registerHostCleanup()

beforeAll(async () => {
  await initShellParser(loadShellParserWasmFromNodeModules())
})

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
    expect(seen).toMatch(/OPENAI_API_KEY=\{\{REDACTED_API_KEY_[a-z2-7]{8}\}\}/)
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
    const keyPlaceholder = masked.match(/\{\{REDACTED_API_KEY_[a-z2-7]{8}\}\}/)![0]
    const body = keyPlaceholder.slice(2, -2)
    const outcome = await redaction.restoreJson({
      command: `curl -H "Authorization: Bearer ${keyPlaceholder}" x`,
      nested: [{ v: `{{ ${body} }}` }, body.toLowerCase()],
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

  it('SR-7 默认照发的几类照原样存，不挤掉别的类别；表里的旧占位符也一样', async () => {
    const t = await makeHost({ ephemeral: ['sr7'], redaction: host })
    const session = await t.open('sr7')
    const redaction = session.redaction!
    const masked = await redaction.maskText(
      'open /Users/alexander/proj on root@buildbox, mail bob@acme-corp.cn'
    )
    expect(masked).toContain('/Users/alexander/proj on root@buildbox')
    expect(masked).toMatch(/mail \{\{REDACTED_EMAIL_[a-z2-7]{8}\}\}$/)
    const table = await redaction.table()
    expect([...table.entries()].map(([, item]) => item.category)).toEqual(['EMAIL'])
    // v0.2.30 / v0.2.31 存下的用户名占位符：按已知值也不再换
    table.put('{{USERNAME_aaaaaaaa}}', {
      category: 'USERNAME',
      rule: 'home-path',
      value: 'alexander'
    })
    expect(await redaction.maskText('cd /Users/alexander; whoami → alexander')).toBe(
      'cd /Users/alexander; whoami → alexander'
    )
  })

  it('SR-8 输入框发来的：只换用户交来的值，其余照原样发、记成照原样发', async () => {
    const t = await makeHost({ ephemeral: ['sr8'], redaction: host })
    const session = await t.open('sr8')
    const SHORT = 'xQ9!z'
    t.kit.queue(answer('ok'), answer('ok'))
    expect(
      await session.submitUser(`mysql -p${SHORT} and DB_PASSWORD=${PASSWORD}`, {
        composer: { secrets: [{ value: SHORT, category: 'PASSWORD' }] }
      })
    ).toEqual({})
    const seen = requestTexts(t.kit, 0).join('\n')
    expect(seen).not.toContain(SHORT)
    expect(seen).toMatch(/mysql -p\{\{REDACTED_PASSWORD_[a-z2-7]{8}\}\} and/)
    expect(seen).toContain(`DB_PASSWORD=${PASSWORD}`)
    const table = await session.redaction!.table()
    expect([...table.entries()].map(([, item]) => [item.category, item.rule, item.value])).toEqual([
      ['PASSWORD', 'user', SHORT]
    ])
    expect(table.asWritten.has(asWrittenKey(host.signer, PASSWORD))).toBe(true)
    expect(await session.redaction!.isAsWritten(PASSWORD)).toBe(true)
    expect(await session.redaction!.isAsWritten(SHORT)).toBe(false)

    // 之后的工具输出：五个字符的用户值整词出现也换，嵌在别的词里的不换；照原样发的那个不再换
    const later = await session.redaction!.maskText(
      `pass: ${SHORT} end, ab${SHORT}cd, DB_PASSWORD=${PASSWORD}`
    )
    expect(later).toMatch(
      /^pass: \{\{REDACTED_PASSWORD_[a-z2-7]{8}\}\} end, abxQ9!zcd, DB_PASSWORD=Tr0ub4dor&3xq$/
    )

    // 显示侧车：只换用户交来的值
    const { display } = await session.redaction!.maskComposerInput(
      'see chip',
      [{ value: SHORT, category: 'PASSWORD' }],
      { content: 'see {{shuvixInlineToken:p1}}', tokens: { p1: { payload: `x ${SHORT} y` } } }
    )
    expect(JSON.stringify(display)).not.toContain(SHORT)
    expect(JSON.stringify(display)).toContain('see {{shuvixInlineToken:p1}}')

    // steer / followUp 同样
    const STEER = 'Steer-Secret-42'
    await session.followUp(`also try ${STEER}`, {
      composer: { secrets: [{ value: STEER, category: 'SECRET' }] }
    })
    await waitFor(() => t.kit.requests.length >= 2)
    expect(requestTexts(t.kit, 1).join('\n')).not.toContain(STEER)
  })

  it('SR-9 没配脱敏：带着要藏的值的发送被拒，空的照发', async () => {
    const plain = await makeHost({ ephemeral: ['sr9'] })
    const session = await plain.open('sr9')
    const refused = await session.submitUser(`use ${PASSWORD}`, {
      composer: { secrets: [{ value: PASSWORD, category: 'PASSWORD' }] }
    })
    expect(refused.error).toMatch(/not available/)
    expect(plain.kit.requests).toHaveLength(0)
    plain.kit.queue(answer('ok'))
    expect(
      await session.submitUser(`DB_PASSWORD=${PASSWORD}`, { composer: { secrets: [] } })
    ).toEqual({})
    expect(requestTexts(plain.kit, 0).join('\n')).toContain(PASSWORD)
  })

  it('SR-10 还原进命令：按引号环境转义，转义后的写法记进已知值', async () => {
    const t = await makeHost({ ephemeral: ['sr10'], redaction: host })
    const session = await t.open('sr10')
    const redaction = session.redaction!
    const VALUE = `it's $HOME-pw`
    const [text] = await redaction.maskComposerTexts(
      [`pw ${VALUE}`],
      [{ value: VALUE, category: 'PASSWORD' }]
    )
    const p = text.match(/\{\{REDACTED_PASSWORD_[a-z2-7]{8}\}\}/)![0]
    const outcome = await redaction.restoreJson(
      { command: `echo "${p}" '${p}' ${p}`, note: `"${p}"` },
      { field: 'command', dialect: 'posix' }
    )
    expect(outcome.value).toEqual({
      command: `echo "it's \\$HOME-pw" 'it'\\''s $HOME-pw' 'it'\\''s $HOME-pw'`,
      note: `"${VALUE}"`
    })
    expect(outcome.restored).toEqual(['PASSWORD'])
    // 命令被回显：转义后的写法也换得回占位符
    expect(await redaction.maskText(`+ echo it\\$HOME-pw "it's \\$HOME-pw"`)).toContain(p)
  })

  it('SR-11 工具结果里默认照发的几类：按对话最近一次请求的目的地在写入时判', async () => {
    const t = await makeHost({ ephemeral: ['sr11'], redaction: host })
    const session = await t.open('sr11')
    const redaction = session.redaction!
    const text = 'cwd /Users/alexander/proj'
    const result = { output: [{ type: 'text' as const, text }], details: { cwd: text } }
    const masked = async (conversationId?: number): Promise<string> =>
      JSON.stringify(await redaction.maskToolResult(result, { conversationId }))
    const redactUser: EgressDecision = {
      applies: true,
      disclose: ({ category }) => (category === 'USERNAME' ? 'redact' : 'send')
    }
    // 还不知道目的地：照原样存
    expect(await masked(1)).not.toMatch(/REDACTED_USERNAME/)
    redaction.noteDecision(1, redactUser)
    const stored = await masked(1)
    expect(stored).not.toContain('alexander')
    expect(stored.match(/\{\{REDACTED_USERNAME_[a-z2-7]{8}\}\}/g)).toHaveLength(2)
    // 别的对话不受影响
    expect(await masked(2)).toContain('/Users/alexander/proj')
    redaction.noteDecision(2, { applies: true, disclose: () => 'send' })
    expect(await masked(2)).toContain('/Users/alexander/proj')
    redaction.noteDecision(2, { applies: false, disclose: () => 'redact' })
    expect(await masked(2)).toContain('/Users/alexander/proj')
    redaction.noteDecision(2, {
      applies: true,
      disclose: () => {
        throw new Error('policy exploded')
      }
    })
    expect(await masked(2)).not.toContain('alexander')

    // 真宿主：出口记下这次的判定，之后的工具结果按它换
    const t2 = await makeHost({
      ephemeral: ['sr11b'],
      redaction: host,
      redactionPolicy: () => redactUser,
      tools: [
        defineTool({
          name: 'pwd',
          description: 'prints the working directory',
          parameters: Type.Object({}),
          execute: async () => ({ output: [{ type: 'text', text: '/Users/alexander/proj' }] })
        })
      ]
    })
    const live = await t2.open('sr11b')
    t2.kit.queue(callTool('pwd'), answer('done'))
    expect(await live.submitUser('where are we')).toEqual({})
    await waitFor(() => t2.kit.requests.length >= 2)
    expect(requestTexts(t2.kit, 1).join('\n')).toMatch(
      /\{\{REDACTED_USERNAME_[a-z2-7]{8}\}\}\/proj/
    )
    expect(await storedText(live)).not.toContain('alexander')
  })
})
