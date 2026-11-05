/**
 * 对话里的会话链接（`shuvix://session/<id>`，日记助手的回复里最多）—— 单测断不了的那半：真 react-markdown、
 * 真点击、真切会话、真 Virtuoso 落到那条消息上。判定表在 chat-ui 的 rehypeSessionLinks.test.ts 与
 * sessionLinkChip.dom.test.tsx。
 *
 *   E-1  模型写的链接：带图标的按钮，真实鼠标点一下切到目标会话（侧栏选中、对话区换了），窗口地址没变
 *   E-2  回到原会话：裸地址和行内代码显示目标当前的标题
 *   E-3  带消息 id 的：打开目标并落在那条消息上，不是默认的底部
 *   E-4  会话不在的：不是按钮，点了不动；不认的地址：没有 chip，属性里没有那个地址
 *
 * 模型侧由 fakeProvider 脚本化。一次 launchApp。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { until } from '../../harness/cdp'
import { launchApp, type E2EApp } from '../../harness/launch'
import { startFakeProvider, type FakeProvider } from '../../harness/fakeProvider'
import { seedFakeProvider, waitRendererReady } from '../../harness/seed'
import {
  chatPane,
  sessionLinksPane,
  sidebarPane,
  type SessionLinksPane,
  type SidebarPane
} from '../../harness/pages'

const MODEL = 'e2e-model'
const SOURCE = 'Link source'
const TARGET = 'Link target'
const USAGE = { prompt: 90, completion: 20 }
/** 目标会话的轮数与每轮的段数：要远高于一屏，「落在那条消息上」才区别于默认的底部 */
const TURNS = 3
const SHOT = process.env.SESSION_LINK_SHOT

const longAnswer = (turn: number): string =>
  Array.from(
    { length: 40 },
    (_, i) => `turn ${turn} paragraph ${i + 1}: the quick brown fox jumps over the lazy dog.`
  ).join('\n\n')

let app: E2EApp
let provider: FakeProvider
let targetSid: string
let sourceSid: string
let firstEntry: string
let replyId: string

const sidebar = (): SidebarPane => sidebarPane(app.main)
const links = (): SessionLinksPane => sessionLinksPane(app.main)
const createSession = (title: string): Promise<string> =>
  app.main.eval<string>(`window.api.session.create(${JSON.stringify({ title })}).then((s) => s.id)`)
const listIds = (sid: string): Promise<string[]> =>
  app.main.eval<string[]>(
    `window.api.message.list(${JSON.stringify(sid)}).then((list) => list.map((m) => m.id))`
  )
const promptIpc = (sid: string, text: string): Promise<unknown> =>
  app.main.eval(
    `window.api.agent.prompt(${JSON.stringify({ sessionId: sid, text })}).then(() => true)`
  )

/** 回到来源会话，等那条回复的 chip 上屏 */
async function backToSource(): Promise<void> {
  expect(await sidebar().openSession(SOURCE)).toBe(true)
  await until(async () => (await links().inMessage(replyId)).length > 0, 'source reply chips')
}

beforeAll(async () => {
  app = await launchApp()
  provider = await startFakeProvider()
  await seedFakeProvider(app.main, { baseUrl: provider.baseUrl, modelId: MODEL })
  await waitRendererReady(app.main)

  targetSid = await createSession(TARGET)
  for (let t = 1; t <= TURNS; t++) {
    provider.script({ text: longAnswer(t), usage: USAGE })
    await promptIpc(targetSid, `target question ${t}`)
  }
  const targetIds = await until(async () => {
    const ids = await listIds(targetSid)
    return ids.length === TURNS * 2 ? ids : null
  }, 'target turns persisted')
  firstEntry = targetIds[0]

  sourceSid = await createSession(SOURCE)
  provider.script({
    text: [
      `MARK-LINKS authored [Authored label](shuvix://session/${targetSid}).`,
      `bare shuvix://session/${targetSid} here.`,
      `code \`shuvix://session/${targetSid}#${firstEntry}\` here.`,
      `gone [Gone label](shuvix://session/nonexistent) here.`,
      `refused [Refused label](shuvix://settings) here.`
    ].join('\n\n'),
    usage: USAGE
  })
  await promptIpc(sourceSid, 'list the links')
  const sourceIds = await until(async () => {
    const ids = await listIds(sourceSid)
    return ids.length === 2 ? ids : null
  }, 'source turn persisted')
  replyId = sourceIds[1]

  await sidebar().clickNewChat()
  await backToSource()
  await chatPane(app.main).waitIdle()
}, 180_000)

afterAll(async () => {
  await provider.close()
  await app.stop()
})

describe('会话链接', () => {
  it('E-1 带图标的按钮，真实鼠标点一下切到目标会话，窗口地址没变', async () => {
    const shots = await links().inMessage(replyId)
    expect(shots[0]).toMatchObject({
      session: targetSid,
      text: 'Authored label',
      button: true,
      icon: true
    })
    expect(shots[0].title).toContain(TARGET)

    if (SHOT) {
      const clip = await links().messageRect(replyId)
      const res = await app.main.send<{ data: string }>('Page.captureScreenshot', {
        format: 'png',
        clip: { ...clip, scale: 2 }
      })
      mkdirSync(dirname(SHOT), { recursive: true })
      writeFileSync(SHOT, Buffer.from(res.data, 'base64'))
    }

    const before = await app.main.eval<string>('location.href')
    await links().click(replyId, 0)
    await until(async () => (await sidebar().activeTitle()) === TARGET, 'target session active')
    await until(
      () =>
        app.main.eval<boolean>(
          `[...document.querySelectorAll('[data-msg-id]')].some((el) => el.textContent?.includes('turn ${TURNS} paragraph'))`
        ),
      'target messages in the list'
    )
    expect(await app.main.eval<string>('location.href')).toBe(before)
  }, 60_000)

  it('E-2 裸地址和行内代码显示目标当前的标题', async () => {
    await backToSource()
    const shots = await links().inMessage(replyId)
    expect(shots.map((s) => [s.session, s.text, s.button])).toEqual([
      [targetSid, 'Authored label', true],
      [targetSid, TARGET, true],
      [targetSid, TARGET, true],
      ['nonexistent', 'Gone label', false]
    ])
    expect(shots.every((s) => s.icon)).toBe(true)
  }, 60_000)

  it('E-3 带消息 id：打开目标并落在那条消息上，不是默认的底部', async () => {
    await backToSource()
    await links().click(replyId, 2)
    await until(async () => (await sidebar().activeTitle()) === TARGET, 'target session active')
    await until(() => links().messageOnScreen(firstEntry), 'linked message on screen')
    // 非空证：默认落点是底部，第一轮的问题远在一屏之外
    const ids = await listIds(targetSid)
    expect(await links().messageOnScreen(ids.at(-1) as string)).toBe(false)
  }, 60_000)

  it('E-4 会话不在的点了不动；不认的地址没有 chip', async () => {
    await backToSource()
    const shots = await links().inMessage(replyId)
    expect(shots.find((s) => s.session === 'nonexistent')?.button).toBe(false)
    await links().click(replyId, 3)
    await new Promise((r) => setTimeout(r, 300))
    expect(await sidebar().activeTitle()).toBe(SOURCE)

    const refused = await app.main.eval<{ text: boolean; attrs: string[] }>(`(() => {
      const msg = document.querySelector('[data-msg-id=' + ${JSON.stringify(JSON.stringify(replyId))} + ']')
      return {
        text: msg.textContent.includes('Refused label'),
        attrs: [...msg.querySelectorAll('*')].flatMap((el) => [...el.attributes].map((a) => a.value)).filter((v) => v.includes('shuvix:'))
      }
    })()`)
    expect(refused).toEqual({ text: true, attrs: [] })
    expect(shots.some((s) => s.text === 'Refused label')).toBe(false)
  }, 60_000)
})
