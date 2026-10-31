/**
 * bot 往自己那份 bot 文件里记东西不问 —— 会话权限表里那一行 bot 文件（source bot，缺省可写）一路到文件工具的
 * 询问：bot 会话的根 Agent 用 `edit` 改它自己的 md 不弹卡；同一目录里别的 bot 文件照旧问。
 *
 *   BM-1 第一轮：脚本按系统提示词里 `<bot_profile file=…>` 给的路径 `edit` 自己那份 md —— 盘上改了、工具块成功、
 *        没有一张询问卡（installAutoAllow 当安全网装着，`autoAllowed` 为空）；那条路径就是权限表 bot 行的目标
 *   BM-2 第二轮：`write` 同一目录里的 `other.md` —— 恰好问了一次（ask-on-external-path 的写），放行后落盘；
 *        自己那份 md 不受这一轮影响
 *
 * 一次 launchApp、一条 bot 会话、两轮脚本化回复（假提供商按最后一条用户消息认领）。会话带显式标题，自动标题不跑。
 */
import { readFileSync, realpathSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startFakeProvider, type FakeProvider, type FakeRequest } from '../../harness/fakeProvider'
import { launchApp, type E2EApp } from '../../harness/launch'
import {
  autoAllowed,
  createBotSession,
  installAutoAllow,
  requestSystemText,
  seedFakeProvider,
  waitRendererReady,
  writeBotMd
} from '../../harness/seed'

const MODEL = 'e2e-model'
const USAGE = { prompt: 90, completion: 5 }
const BOT = 'memo'
const PLACEHOLDER = '- (nothing recorded yet)'
const BODY = `I am Memo.\n\n## What I know about this person\n\n${PLACEHOLDER}`
const PREFERENCE = '- Prefers pnpm over npm.'
const Q1 = 'BM-1 I always use pnpm, please remember that.'
const Q2 = 'BM-2 jot a scratch note next to your file.'
const OTHER_CONTENT = 'scratch note\n'

interface ListedMessage {
  role: string
  blocks?: Array<{ toolCallId?: string; result?: string; isError?: boolean }>
}

let app: E2EApp
let provider: FakeProvider
let sid = ''
let botFile = ''

const byUserText =
  (text: string) =>
  (r: FakeRequest): boolean =>
    r.lastUserText === text

/** 发一轮并等它落定（durable 的 submitUser 等这一轮落定才答） */
const prompt = (text: string): Promise<unknown> =>
  app.main.eval(`window.api.agent.prompt(${JSON.stringify({ sessionId: sid, text })})`)

const blockOf = async (
  toolCallId: string
): Promise<{ result?: string; isError?: boolean } | undefined> =>
  (await app.main.eval<ListedMessage[]>(`window.api.message.list(${JSON.stringify(sid)})`))
    .flatMap((m) => m.blocks ?? [])
    .find((b) => b.toolCallId === toolCallId)

/** 请求的系统提示词里 bot 围栏的 file= —— 模型知道的那条路径 */
function fenceFileOf(req: FakeRequest): string {
  const m = requestSystemText(req).match(/<bot_profile name="memo" file="([^"]+)">/)
  if (!m) throw new Error('no <bot_profile file=…> fence in the system prompt')
  return m[1]
}

beforeAll(async () => {
  provider = await startFakeProvider()
  app = await launchApp()
  await seedFakeProvider(app.main, { baseUrl: provider.baseUrl, modelId: MODEL })
  await waitRendererReady(app.main)
  // 安全网：bot 改自己那份文件本不该问 —— 真冒出一张卡也不会挂到超时，而是在 autoAllowed 里现形
  await installAutoAllow(app.main)
  botFile = realpathSync(writeBotMd(app, BOT, { body: BODY }))
  sid = await createBotSession(app.main, { bot: BOT, title: 'bot-memory' })
}, 120_000)

afterAll(async () => {
  await provider?.close()
  await app?.stop()
})

describe('bot 记自己那份文件', () => {
  it('BM-1 edit 自己的 bot 文件：盘上改了、工具块成功、一张询问卡都没有', async () => {
    let fencePath = ''
    provider.script(
      {
        when: byUserText(Q1),
        build: (req) => {
          fencePath = fenceFileOf(req)
          return {
            toolCalls: [
              {
                id: 'call_bm1_edit',
                name: 'edit',
                args: JSON.stringify({ path: fencePath, oldText: PLACEHOLDER, newText: PREFERENCE })
              }
            ]
          }
        },
        usage: USAGE
      },
      { text: 'Noted: pnpm.', when: byUserText(Q1), usage: USAGE }
    )
    await prompt(Q1)

    // 模型拿到的路径就是权限表里那一行 bot 行的目标
    expect(realpathSync(fencePath)).toBe(botFile)
    const acl = await app.main.eval<Array<{ source: string; target: string; access: string }>>(
      `window.api.session.listAcl(${JSON.stringify(sid)})`
    )
    expect(acl.filter((r) => r.source === 'bot')).toEqual([
      expect.objectContaining({ target: botFile, access: 'write' })
    ])

    const block = await blockOf('call_bm1_edit')
    expect(block, 'edit block').toBeDefined()
    expect(block!.isError, `edit failed: ${block!.result}`).not.toBe(true)
    const text = readFileSync(botFile, 'utf8')
    expect(text).toContain(PREFERENCE)
    expect(text).not.toContain(PLACEHOLDER)
    expect(await autoAllowed(app.main)).toEqual([])
  })

  it('BM-2 write 同目录里别的 bot 文件：恰好问一次，放行后落盘；自己那份不动', async () => {
    const other = join(app.botsDir, 'other.md')
    const before = readFileSync(botFile, 'utf8')
    provider.script(
      {
        when: byUserText(Q2),
        toolCalls: [
          {
            id: 'call_bm2_write',
            name: 'write',
            args: JSON.stringify({ path: other, content: OTHER_CONTENT })
          }
        ],
        usage: USAGE
      },
      { text: 'Wrote it.', when: byUserText(Q2), usage: USAGE }
    )
    await prompt(Q2)

    const asked = await autoAllowed(app.main)
    expect(asked).toHaveLength(1)
    expect(asked[0]).toContain('other.md')
    const block = await blockOf('call_bm2_write')
    expect(block, 'write block').toBeDefined()
    expect(block!.isError, `write failed: ${block!.result}`).not.toBe(true)
    expect(existsSync(other)).toBe(true)
    expect(readFileSync(other, 'utf8')).toBe(OTHER_CONTENT)
    expect(readFileSync(botFile, 'utf8')).toBe(before)
  })
})
