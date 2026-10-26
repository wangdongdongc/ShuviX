/**
 * 自动脱敏（docs/auto-redaction-design.md）的整条链路，真应用 + 假模型：
 *
 *   RD-1 缺省（内置 redact-sensitive）：用户消息里的 key 发给模型时是占位符；模型照抄占位符调 write，磁盘上写的是
 *        真值；对话记录（message.list）里只有占位符；界面显示模型收到的样子（占位符），指到占位符才浮出真值
 *   RD-2 信任这个服务商（用户策略 force-allow modelRequest）：模型收到真值；它在回复里写出的真值存成占位符、界面上
 *        仍显示真值
 *   RD-3 第一层拒发（用户策略 deny modelRequest）：请求不发，这一轮以出错结束
 *
 * 前置：会话绑项目，write 的目标在项目目录里（ask-on-external-path 不问）。占位符的 8 位摘要用这个实例自己的密钥，
 * 用例里算不出来 —— 假模型用 `build` 从请求里取。
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { until } from '../../harness/cdp'
import { launchApp, type E2EApp } from '../../harness/launch'
import { startFakeProvider, type FakeProvider, type FakeRequest } from '../../harness/fakeProvider'
import {
  createProject,
  eventRecorder,
  seedFakeProvider,
  waitRendererReady,
  type EventRecorder
} from '../../harness/seed'
import { chatPane, sidebarPane, type ChatPane, type SidebarPane } from '../../harness/pages'

const MODEL = 'e2e-model'
const PROVIDER_NAME = 'E2E Fake'
const KEY = 'sk-proj-' + 'A1b2C3d4E5f6G7h8I9j0K1l2'
const PLACEHOLDER = /\{\{REDACTED_API_KEY_[a-z2-7]{8}\}\}/

let app: E2EApp
let provider: FakeProvider
let events: EventRecorder
let chat: ChatPane
let sidebar: SidebarPane
let projDir = ''
let policiesDir = ''
const sids: Record<string, string> = {}

const createSession = async (title: string, projectId: string): Promise<string> =>
  app.main.eval<string>(
    `window.api.session.create(${JSON.stringify({ title, projectId })}).then((s) => s.id)`
  )

const listedText = async (sid: string): Promise<string> =>
  JSON.stringify(await app.main.eval(`window.api.message.list(${JSON.stringify(sid)})`))

/** 界面上的脱敏标记：`类别:显示的文字` */
const marks = (): Promise<string[]> =>
  app.main.eval<string[]>(
    `[...document.querySelectorAll('[data-redaction]')].map((e) => e.dataset.redaction + ':' + e.textContent)`
  )

const placeholderIn = (req: FakeRequest): string => {
  const hit = PLACEHOLDER.exec(req.lastUserText)
  if (!hit) throw new Error(`no placeholder in: ${req.lastUserText}`)
  return hit[0]
}

const policyNames = (): Promise<string[]> =>
  app.main.eval<string[]>(`window.api.policy.list().then((ps) => ps.map((p) => p.name))`)

/** 用户策略目录按定时器重扫：写下 / 删掉之后等它真的生效 */
const policyInEffect = async (name: string, present: boolean): Promise<void> => {
  await until(
    async () => (await policyNames()).includes(name) === present,
    `policy ${name} ${present ? 'loaded' : 'gone'}`
  )
}

const writePolicy = async (name: string, rules: string): Promise<void> => {
  mkdirSync(policiesDir, { recursive: true })
  writeFileSync(
    join(policiesDir, `${name}.md`),
    `---\nshuvix: policy v1\nname: ${name}\nshuvix-policy-rules:\n${rules}\n---\n`
  )
  await policyInEffect(name, true)
}

const removePolicy = async (name: string): Promise<void> => {
  rmSync(join(policiesDir, `${name}.md`), { force: true })
  await policyInEffect(name, false)
}

beforeAll(async () => {
  app = await launchApp()
  provider = await startFakeProvider()
  await seedFakeProvider(app.main, {
    baseUrl: provider.baseUrl,
    modelId: MODEL,
    name: PROVIDER_NAME
  })
  await waitRendererReady(app.main)

  projDir = join(app.home, 'proj-redaction')
  mkdirSync(projDir, { recursive: true })
  policiesDir = join(app.home, '.shuvix', 'policies')
  const project = await createProject(app.main, { name: 'RedactionProj', path: projDir })
  sids.mask = await createSession('R-mask', project.id)
  sids.trust = await createSession('R-trust', project.id)
  sids.deny = await createSession('R-deny', project.id)

  chat = chatPane(app.main)
  sidebar = sidebarPane(app.main)
  await sidebar.clickNewChat()
  await until(async () => (await sidebar.titles()).includes('R-mask'), 'sidebar list refreshed')
  events = eventRecorder(app.main)
  await events.install()
})

afterAll(async () => {
  await provider.close()
  await app.stop()
})

describe('自动脱敏', () => {
  it('RD-1 缺省：模型见占位符，工具写真值，记录存占位符，界面显示真值', async () => {
    provider.reset()
    await events.clear()
    const envPath = join(projDir, '.env')
    provider.script(
      {
        build: (req) => ({
          toolCalls: [
            {
              id: 'call_w',
              name: 'write',
              args: JSON.stringify({
                path: envPath,
                content: `OPENAI_API_KEY=${placeholderIn(req)}\n`
              })
            }
          ]
        })
      },
      {
        build: (req) => {
          const placeholder = PLACEHOLDER.exec(req.lastUserText)?.[0] ?? ''
          return { text: `Saved ${placeholder} to .env.` }
        }
      }
    )

    expect(await sidebar.openSession('R-mask')).toBe(true)
    await chat.ready()
    await chat.typeAndSend(`save my key ${KEY} into .env`)
    await events.waitFor('agent_end', { sessionId: sids.mask })
    await chat.waitIdle()

    // 发给模型的：只有占位符
    const requests = provider.requests()
    expect(requests.length).toBe(2)
    for (const req of requests) expect(req.raw).not.toContain(KEY)
    expect(requests[0]!.lastUserText).toMatch(PLACEHOLDER)

    // 工具拿到的是真值
    expect(readFileSync(envPath, 'utf-8')).toBe(`OPENAI_API_KEY=${KEY}\n`)

    // 对话记录：占位符
    const stored = await listedText(sids.mask)
    expect(stored).not.toContain(KEY)
    expect(stored).toMatch(PLACEHOLDER)

    // 界面：显示模型收到的样子 —— 用户气泡与助手正文里是占位符，不是真值
    const placeholder = PLACEHOLDER.exec(requests[0]!.lastUserText)![0]
    await until(
      async () => (await marks()).filter((m) => m === `API_KEY:${placeholder}`).length >= 2,
      'placeholders shown'
    )
    const items = await chat.settledItems()
    expect(items.find((i) => i.role === 'user')?.text).toContain(placeholder)
    expect(items.find((i) => i.role === 'user')?.text).not.toContain(KEY)
    expect(items.find((i) => i.role === 'assistant')?.text).toContain(
      `Saved ${placeholder} to .env.`
    )
    // 指到占位符才浮出真值（工具和文件里用的那个）
    const revealed = await app.main.eval<string | null>(`(async () => {
      const el = document.querySelector('[data-redaction-placeholder]')
      el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
      await new Promise((r) => setTimeout(r, 50))
      return document.querySelector('[data-redaction-popover] [data-redaction-value]')?.textContent ?? null
    })()`)
    expect(revealed).toBe(KEY)
    rmSync(envPath, { force: true })
  })

  it('RD-2 信任这个服务商：模型见真值，回复里的真值存成占位符', async () => {
    await writePolicy(
      'trust-fake',
      `  - effect: force-allow\n    subject.kind: [agent]\n    action: [send]\n    object.type: [modelRequest]\n    match: "object.provider == '${PROVIDER_NAME}'"`
    )
    provider.reset()
    await events.clear()
    provider.script({ build: (req) => ({ text: `echo: ${req.lastUserText}` }) })

    expect(await sidebar.openSession('R-trust')).toBe(true)
    await chat.ready()
    await chat.typeAndSend(`my key is ${KEY}`)
    await events.waitFor('agent_end', { sessionId: sids.trust })
    await chat.waitIdle()

    expect(provider.requests()[0]!.lastUserText).toBe(`my key is ${KEY}`)
    const stored = await listedText(sids.trust)
    expect(stored).not.toContain(KEY)
    expect(stored).toMatch(/echo: my key is \{\{REDACTED_API_KEY_[a-z2-7]{8}\}\}/)
    await until(
      async () =>
        ((await chat.settledItems()).find((i) => i.role === 'assistant')?.text ?? '').includes(KEY),
      'assistant reply shows the real value'
    )
    await removePolicy('trust-fake')
  })

  it('RD-3 第一层拒发：请求不发，这一轮以出错结束', async () => {
    await writePolicy(
      'deny-fake',
      `  - effect: deny\n    subject.kind: [agent]\n    action: [send]\n    object.type: [modelRequest]\n    match: "object.provider == '${PROVIDER_NAME}'"`
    )
    provider.reset()
    await events.clear()
    provider.script({ text: 'should not be asked' })

    expect(await sidebar.openSession('R-deny')).toBe(true)
    await chat.ready()
    await chat.typeAndSend('hello')
    await events.waitFor('agent_end', { sessionId: sids.deny })
    await chat.waitIdle()

    expect(provider.requests()).toHaveLength(0)
    await until(async () => (await chat.errorRows()) > 0, 'error row shown')
    expect(await listedText(sids.deny)).toContain('does not allow sending requests')
    await removePolicy('deny-fake')
  })
})
