/**
 * 一条会话的脱敏（durable/sessionRedaction.ts，docs/auto-redaction-design.md §2）：真宿主 + faux 模型。
 *
 *   SR-1 用户输入（没有 composer）不自动脱敏（§16）：模型看到的、记录里存的都是原样，对照表为空
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
 *   MT-1 工具结果里同一个值第二处光秃：两处同一个占位符，对照表只新增一项
 *   MT-2 同一批 maskTexts：值在一段里被规则认出、在另一段里光秃，光秃的也换（两种次序）
 *   MT-3 没有新认出的值只扫一遍、不提交；短于 MIN_KNOWN 的已知值光秃处不换，规则认出的那处照换
 * 写入按策略判（§16，MaskOptions）：
 *   MO-1 第一层不适用：原样交回，不记表、不提交，表里已有的 + 值也不换，不问第二层
 *   MO-2 第二层：send 存原文不记表；redact 存占位符记一项；block 与 redact 同一个占位符
 *   MO-3 混合：同一段里按类别换，照发的不进表
 *   MO-4 选项优先级：model 现问策略（带上对话，不看记下的判定）；只给 conversationId 用记下的，不问；都不给走默认
 *   MO-5 判不出（没配策略 / 策略抛错 / 没记下 / 重启后）：每一类按内置默认，只有 USERNAME、HOSTNAME、IP、BUCKET 照原样
 *   MO-6 disclose 抛错：每一类都存占位符（USERNAME 也是）
 *   MO-7 第一层 deny 下写入：每一类都存占位符（USERNAME 也是）
 *   MO-8 脱敏器内部出错（签名抛错）：不抛，原样交回，记 error
 */
import { createHmac } from 'node:crypto'
import { Type } from '@earendil-works/pi-ai'
import { defineTool, type ToolRegistration } from '@earendil-works/pi-durable'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import {
  isKeptAsWritten,
  SENSITIVE_CATEGORIES,
  type SensitiveCategory
} from '../../redaction/categories'
import { MIN_KNOWN } from '../../redaction/known'
import { asWrittenKey } from '../../redaction/placeholder'
import { initShellParser } from '../../security/shell'
import { loadShellParserWasmFromNodeModules } from '../../security/shell/nodeWasm'
import { backgroundContext as BG } from '../context'
import { RedactionTableDoc } from '../docs'
import type { DurableSession } from '../durableSession'
import type { EgressDecision } from '../redactionEgress'
import type { RedactionPolicy } from '../redactionModels'
import { SessionRedaction, type RedactionHost } from '../sessionRedaction'
import { answer, callTool } from './support/faux'
import { makeHost, registerHostCleanup } from './support/host'
import { byCategory, DENY1, DENY2, EXEMPT, REDACT, SEND } from './support/redaction'
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
  it('SR-1 用户输入（没有 composer）：模型与记录里都是原样，对照表为空', async () => {
    const t = await makeHost({ ephemeral: ['sr1'], redaction: host })
    const session = await t.open('sr1')
    t.kit.queue(answer('ok'))
    expect(await session.submitUser(`连上去，DB_PASSWORD=${PASSWORD}`)).toEqual({})
    const seen = requestTexts(t.kit, 0).join('\n')
    expect(seen).toContain(`DB_PASSWORD=${PASSWORD}`)
    expect(seen).not.toMatch(PLACEHOLDER)
    const stored = await storedText(session)
    expect(stored).toContain(`DB_PASSWORD=${PASSWORD}`)
    expect(stored).not.toMatch(PLACEHOLDER)
    expect((await session.redaction!.table()).size).toBe(0)
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

  describe('maskTexts：这一遍刚认出的值再换一遍', () => {
    const VALUE = 'Tr0ub4dor3xqZZ'
    const TOKEN = /\{\{[A-Z_]+_[a-z2-7]{8}\}\}/g

    it('MT-1 工具结果里同一个值第二处光秃：两处是同一个占位符，没有明文；对照表只新增一项', async () => {
      const t = await makeHost({ ephemeral: ['mt1'], redaction: host })
      const session = await t.open('mt1')
      const redaction = session.redaction!
      const size = (await redaction.table()).size
      const text = `DB_PASSWORD=${VALUE} ... ${VALUE}`
      const result = await redaction.maskToolResult({
        output: [{ type: 'text', text }],
        details: { raw: text }
      })
      const block = result.output![0] as { text: string }
      expect(block.text).not.toContain(VALUE)
      const hits = block.text.match(TOKEN)!
      expect(hits).toHaveLength(2)
      expect(hits[0]).toBe(hits[1])
      expect(block.text).toBe(`DB_PASSWORD=${hits[0]} ... ${hits[0]}`)
      expect(JSON.stringify(result.details)).not.toContain(VALUE)
      expect((await redaction.table()).size).toBe(size + 1)
    })

    it('MT-2 同一批 maskTexts：值在 a 里被规则认出、在 b 里光秃出现，b 也换；反过来的次序也一样', async () => {
      const t = await makeHost({ ephemeral: ['mt2'], redaction: host })
      const session = await t.open('mt2')
      const redaction = session.redaction!
      const [a, b] = await redaction.maskTexts([`DB_PASSWORD=${VALUE}`, `bare ${VALUE} here`])
      const placeholder = a!.match(TOKEN)![0]
      expect(b).toBe(`bare ${placeholder} here`)

      const other = 'Zx9-another-Value42'
      const [c, d] = await redaction.maskTexts([`bare ${other} here`, `DB_PASSWORD=${other}`])
      const second = d!.match(TOKEN)![0]
      expect(second).not.toBe(placeholder)
      expect(c).toBe(`bare ${second} here`)
    })

    it('MT-3 没有新认出的值只扫一遍、不提交；已知值短于 MIN_KNOWN 的光秃处不换，规则认出的那处照换', async () => {
      const t = await makeHost({ ephemeral: ['mt3'], redaction: host })
      const session = await t.open('mt3')
      const redaction = new SessionRedaction({
        sessionId: session.sessionId,
        harness: session.harness,
        host,
        logger: { info: () => {}, warn: () => {}, error: () => {} }
      })
      await redaction.table()
      const commit = vi.spyOn(session.harness, 'commit')
      const maskOne = vi.spyOn(redaction as unknown as { maskOne: () => string }, 'maskOne')

      const plain = ['nothing to see here', 'and nothing here either']
      expect(await redaction.maskTexts(plain)).toEqual(plain)
      expect(maskOne).toHaveBeenCalledTimes(plain.length)
      expect(commit).not.toHaveBeenCalled()

      // 只有已知值（没有新认出的）：照换，仍只一遍，不提交
      const known = await redaction.maskText(`DB_PASSWORD=${VALUE}`)
      const placeholder = known.match(TOKEN)![0]
      commit.mockClear()
      maskOne.mockClear()
      expect(await redaction.maskText(`bare ${VALUE}`)).toBe(`bare ${placeholder}`)
      expect(maskOne).toHaveBeenCalledTimes(1)
      expect(commit).not.toHaveBeenCalled()

      // 新认出一个值：两遍，只记一次表
      commit.mockClear()
      maskOne.mockClear()
      const text = await redaction.maskText('DB_PASSWORD=Zx9-another-Value42')
      expect(text).toMatch(TOKEN)
      expect(maskOne).toHaveBeenCalledTimes(2)
      expect(commit).toHaveBeenCalledTimes(1)

      // 7 个字符的值：规则认出的那处换，光秃的那处不按已知值换（短于 MIN_KNOWN）
      const short = 'abc123x'
      expect(short.length).toBeLessThan(MIN_KNOWN)
      const masked = await redaction.maskText(`postgres://u:${short}@h/db and ${short}`)
      expect(masked).toMatch(
        /^postgres:\/\/u:\{\{REDACTED_PASSWORD_[a-z2-7]{8}\}\}@h\/db and abc123x$/
      )
    })
  })

  describe('写入按策略判（§16，MaskOptions）', () => {
    const MODEL = { provider: 'faux', modelId: 'faux-1' }
    const EMAIL = 'someone@company-sample.net'
    const MIXED = `key ${KEY} mail ${EMAIL}`

    /** 每一类一段规则认得出的文本，value = 认出来的那个值 */
    const SAMPLES: Record<SensitiveCategory, { text: string; value: string }> = {
      PRIVATE_KEY: {
        text: 'key:\n-----BEGIN PRIVATE KEY-----\nMIIBVQIBADANBgkqhkiG9w0BAQEFAASCAT8wggE7AgEAAkEA\n-----END PRIVATE KEY-----\n',
        value:
          '-----BEGIN PRIVATE KEY-----\nMIIBVQIBADANBgkqhkiG9w0BAQEFAASCAT8wggE7AgEAAkEA\n-----END PRIVATE KEY-----'
      },
      API_KEY: { text: `key ${KEY}`, value: KEY },
      TOKEN: {
        text: 'jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzYW1wbGUifQ.c2FtcGxlc2lnbmF0dXJl',
        value: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzYW1wbGUifQ.c2FtcGxlc2lnbmF0dXJl'
      },
      PASSWORD: {
        text: 'postgres://u:Sample-Pa55word!@db.example.com/app',
        value: 'Sample-Pa55word!'
      },
      SECRET: {
        text: '"client_secret":"sample-secret-0123456789"',
        value: 'sample-secret-0123456789'
      },
      EMAIL: { text: `mail ${EMAIL} now`, value: EMAIL },
      ID_CARD: { text: 'id 11010519491231002X ok', value: '11010519491231002X' },
      PHONE: { text: 'call 13812345678 now', value: '13812345678' },
      BANK_CARD: { text: 'card 4111111111111111 ok', value: '4111111111111111' },
      SSN: { text: 'ssn 536-90-4399 ok', value: '536-90-4399' },
      PASSPORT: { text: 'passport: E12345678', value: 'E12345678' },
      IBAN: { text: 'iban GB82WEST12345698765432 ok', value: 'GB82WEST12345698765432' },
      BIRTHDAY: { text: 'birthday: 1990-04-12', value: '1990-04-12' },
      MAC: { text: 'mac 3c:22:fb:1a:2b:3c ok', value: '3c:22:fb:1a:2b:3c' },
      SERIAL: { text: 'serial number: C02XK1ZZJGH5', value: 'C02XK1ZZJGH5' },
      USERNAME: { text: 'cd /Users/alice/proj', value: 'alice' },
      HOSTNAME: { text: 'ssh deploy@build-server-01', value: 'build-server-01' },
      IP: { text: 'connect to 52.14.8.201 now', value: '52.14.8.201' },
      BUCKET: { text: 'aws s3 cp s3://acme-backups/a .', value: 'acme-backups' }
    }

    const KEPT_BY_DEFAULT: readonly string[] = ['USERNAME', 'HOSTNAME', 'IP', 'BUCKET']

    interface Rig {
      redaction: SessionRedaction
      warnings: string[]
      errors: string[]
      make: (policy?: RedactionPolicy, over?: Partial<RedactionHost>) => SessionRedaction
      commit: ReturnType<typeof vi.spyOn>
    }

    /** 真 Harness 上的 SessionRedaction（deps 里的策略测试自己给） */
    async function rig(id: string, policy?: RedactionPolicy): Promise<Rig> {
      const t = await makeHost({ ephemeral: [id], redaction: host })
      const session = await t.open(id)
      const warnings: string[] = []
      const errors: string[] = []
      const make: Rig['make'] = (next, over = {}) =>
        new SessionRedaction({
          sessionId: id,
          harness: session.harness,
          host: { ...host, ...over },
          ...(next === undefined ? {} : { policy: next }),
          logger: {
            info: () => {},
            warn: (message) => warnings.push(message),
            error: (message) => errors.push(message)
          }
        })
      return {
        redaction: make(policy),
        warnings,
        errors,
        make,
        commit: vi.spyOn(session.harness, 'commit')
      }
    }

    /** 这一类存成了自己类别的占位符，没有明文，表里有这一项 */
    async function expectRedacted(
      redaction: SessionRedaction,
      category: SensitiveCategory,
      out: string
    ): Promise<void> {
      expect(out, category).not.toContain(SAMPLES[category].value)
      const found = out.match(new RegExp(`\\{\\{REDACTED_${category}_[a-z2-7]{8}\\}\\}`))
      expect(found, category).not.toBeNull()
      expect((await redaction.table()).get(found![0])?.value, category).toBe(
        SAMPLES[category].value
      )
    }

    it('MO-1 第一层不适用：原样交回，不记表、不提交，表里已有的 + 值也不换，不问第二层', async () => {
      const { redaction, commit } = await rig('mo1', () => EXEMPT)
      const SECRET_VALUE = 'Added-By-Plus-42'
      await redaction.maskComposerTexts(
        [`pw ${SECRET_VALUE}`],
        [{ value: SECRET_VALUE, category: 'PASSWORD' }]
      )
      const table = await redaction.table()
      expect(table.size).toBe(1)
      commit.mockClear()
      const texts = [MIXED, `again ${SECRET_VALUE}`, 'cd /Users/alice/proj']
      expect(await redaction.maskTexts(texts, { model: MODEL })).toEqual(texts)
      expect(table.size).toBe(1)
      expect(commit).not.toHaveBeenCalled()
      expect((await redaction.table()).known.get(KEY)).toBeUndefined()
    })

    it('MO-1b 第一层不适用的会话：对照表一项都没有', async () => {
      const { redaction, commit } = await rig('mo1b', () => EXEMPT)
      expect(await redaction.maskText(MIXED, { model: MODEL })).toBe(MIXED)
      expect((await redaction.table()).size).toBe(0)
      expect(commit).not.toHaveBeenCalled()
    })

    it('MO-2 第二层：send 存原文不记表；redact 存占位符记一项；block 与 redact 同一个占位符', async () => {
      const text = `key ${KEY}`
      const sent = await rig('mo2a', () => SEND)
      expect(await sent.redaction.maskText(text, { model: MODEL })).toBe(text)
      expect((await sent.redaction.table()).size).toBe(0)

      const redacted = await rig('mo2b', () => REDACT)
      const a = await redacted.redaction.maskText(text, { model: MODEL })
      expect(a).not.toContain(KEY)
      expect(a).toMatch(PLACEHOLDER)
      expect((await redacted.redaction.table()).size).toBe(1)

      const denied = await rig('mo2c', () => DENY2)
      expect(await denied.redaction.maskText(text, { model: MODEL })).toBe(a)
      expect((await denied.redaction.table()).size).toBe(1)
    })

    it('MO-3 混合：同一段里只换 redact 的那类，照发的原样且不进表', async () => {
      const { redaction } = await rig('mo3', () => byCategory({ API_KEY: 'redact', EMAIL: 'send' }))
      const out = await redaction.maskText(MIXED, { model: MODEL })
      expect(out).toMatch(
        /^key \{\{REDACTED_API_KEY_[a-z2-7]{8}\}\} mail someone@company-sample\.net$/
      )
      const table = await redaction.table()
      expect([...table.entries()].map(([, item]) => [item.category, item.value])).toEqual([
        ['API_KEY', KEY]
      ])
      expect(table.known.get(EMAIL)).toBeUndefined()
    })

    describe('MO-4 选项优先级', () => {
      const text = `key ${KEY}`

      it('model + conversationId：策略收到两者，不看记下的判定', async () => {
        const policy = vi.fn<RedactionPolicy>(() => REDACT)
        const { redaction } = await rig('mo4a', policy)
        redaction.noteDecision(7, SEND)
        const out = await redaction.maskText(text, { model: MODEL, conversationId: 7 })
        expect(out).toMatch(PLACEHOLDER)
        expect(policy).toHaveBeenCalledTimes(1)
        expect(policy).toHaveBeenCalledWith({
          sessionId: 'mo4a',
          conversationId: 7,
          provider: 'faux',
          model: 'faux-1'
        })
      })

      it('只给 model：策略入参没有 conversationId 这个键', async () => {
        const policy = vi.fn<RedactionPolicy>(() => REDACT)
        const { redaction } = await rig('mo4b', policy)
        await redaction.maskText(text, { model: MODEL })
        expect(policy.mock.calls[0]![0]).toEqual({
          sessionId: 'mo4b',
          provider: 'faux',
          model: 'faux-1'
        })
        expect(policy.mock.calls[0]![0]).not.toHaveProperty('conversationId')
      })

      it('只给 conversationId：用记下的判定，不问策略', async () => {
        const policy = vi.fn<RedactionPolicy>(() => REDACT)
        const { redaction } = await rig('mo4c', policy)
        redaction.noteDecision(7, SEND)
        expect(await redaction.maskText(text, { conversationId: 7 })).toBe(text)
        expect(policy).not.toHaveBeenCalled()
      })

      it('都不给：走内置默认，不问策略、不看记下的判定', async () => {
        const policy = vi.fn<RedactionPolicy>(() => SEND)
        const { redaction } = await rig('mo4d', policy)
        redaction.noteDecision(7, SEND)
        const out = await redaction.maskText(`${text} cd /Users/alice/proj`)
        expect(out).toMatch(/^key \{\{REDACTED_API_KEY_[a-z2-7]{8}\}\} cd \/Users\/alice\/proj$/)
        expect(policy).not.toHaveBeenCalled()
      })

      it('forgetDecision 之后：记下的判定不再算数', async () => {
        const { redaction } = await rig('mo4e')
        redaction.noteDecision(7, SEND)
        redaction.forgetDecision(7)
        expect(await redaction.maskText(text, { conversationId: 7 })).toMatch(PLACEHOLDER)
      })
    })

    describe('MO-5 判不出：每一类按内置默认', () => {
      const expectDefaults = async (
        redaction: SessionRedaction,
        opts: Parameters<SessionRedaction['maskTexts']>[1]
      ): Promise<void> => {
        for (const category of SENSITIVE_CATEGORIES) {
          const sample = SAMPLES[category]
          const out = await redaction.maskText(sample.text, opts)
          if (KEPT_BY_DEFAULT.includes(category)) {
            expect(isKeptAsWritten(category), category).toBe(true)
            expect(out, category).toBe(sample.text)
            expect((await redaction.table()).known.get(sample.value), category).toBeUndefined()
          } else {
            expect(isKeptAsWritten(category), category).toBe(false)
            await expectRedacted(redaction, category, out)
          }
        }
      }

      it('① 没配策略（给了 model 也没得问）', async () => {
        const { redaction } = await rig('mo5a')
        await expectDefaults(redaction, { model: MODEL })
      })

      it('② 策略抛错：不退回记下的判定，记 warn', async () => {
        const { redaction, warnings } = await rig('mo5b', () => {
          throw new Error('policy exploded')
        })
        redaction.noteDecision(7, SEND)
        await expectDefaults(redaction, { model: MODEL, conversationId: 7 })
        expect(warnings.length).toBeGreaterThan(0)
        expect(warnings[0]).toContain('faux/faux-1')
        expect(warnings[0]).toContain('policy exploded')
      })

      it('③ 这个对话没记下判定', async () => {
        const { redaction } = await rig('mo5c', () => {
          throw new Error('must not be asked')
        })
        redaction.noteDecision(7, SEND)
        await expectDefaults(redaction, { conversationId: 8 })
      })

      it('④ 新的 SessionRedaction（重启后判定不在内存）', async () => {
        const { redaction, make } = await rig('mo5d', () => {
          throw new Error('must not be asked')
        })
        redaction.noteDecision(7, SEND)
        await expectDefaults(
          make(() => REDACT),
          { conversationId: 7 }
        )
      })
    })

    it('MO-6 disclose 抛错：每一类都存占位符，USERNAME 也是', async () => {
      const { redaction } = await rig('mo6', () => ({
        applies: true,
        disclose: () => {
          throw new Error('policy exploded')
        }
      }))
      for (const category of SENSITIVE_CATEGORIES) {
        const out = await redaction.maskText(SAMPLES[category].text, { model: MODEL })
        await expectRedacted(redaction, category, out)
      }
    })

    it('MO-7 第一层 deny 下写入：每一类都存占位符，USERNAME 也是，不问第二层', async () => {
      const disclose = vi.fn(DENY1.disclose)
      const { redaction } = await rig('mo7', () => ({ ...DENY1, disclose }))
      for (const category of SENSITIVE_CATEGORIES) {
        const out = await redaction.maskText(SAMPLES[category].text, { model: MODEL })
        await expectRedacted(redaction, category, out)
      }
      expect(disclose).not.toHaveBeenCalled()
    })

    it('MO-8 脱敏器内部出错（签名抛错）：不抛，原样交回，记 error', async () => {
      const { make, errors } = await rig('mo8')
      const broken = make(() => REDACT, {
        signer: {
          sign: () => {
            throw new Error('keychain refused')
          }
        }
      })
      const texts = [MIXED, 'nothing here']
      await expect(broken.maskTexts(texts, { model: MODEL })).resolves.toEqual(texts)
      expect(errors).toHaveLength(1)
      expect(errors[0]).toContain('masking failed')
      expect(errors[0]).toContain('keychain refused')
    })
  })
})
