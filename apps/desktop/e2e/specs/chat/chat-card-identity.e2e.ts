/**
 * 卡片身份 —— 流式占位换成真实终答时，这一项**不能重挂载**。
 *
 * 旧模型里一轮的全部步骤都挂在合成占位项 `streaming-live` 上，agent_end 后整项换成
 * 终答消息的 id，Virtuoso 的 computeItemKey 一变就 unmount/remount，工具卡片与思考块
 * 的展开态（组件本地 useState）随之丢失 —— 运行中展开的卡片会在本轮结束的瞬间自己折回去。
 *
 * 现在列表项的 key 取**组首消息 id**（流式占位只是并到组尾），组首在这次转换里不变，
 * 于是展开态跨 agent_end 存活。本用例钉的就是这件事。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { until } from '../../harness/cdp'
import { launchApp, type E2EApp } from '../../harness/launch'
import { startFakeProvider, type FakeProvider } from '../../harness/fakeProvider'
import {
  createProject,
  eventRecorder,
  seedFakeProvider,
  waitRendererReady,
  type EventRecorder
} from '../../harness/seed'
import { chatPane, sidebarPane, type ChatPane, type SidebarPane } from '../../harness/pages'

const MODEL = 'e2e-model'

let app: E2EApp
let provider: FakeProvider
let events: EventRecorder
let chat: ChatPane
let sidebar: SidebarPane
let projDir = ''
let sid = ''

/** 首张工具卡片的展开程度（文本长度 + 是否露出结果正文） */
const toolCard = (): Promise<{ len: number; hasBody: boolean }> =>
  app.main.eval(`(() => {
    const el = document.querySelector('[data-tool-name]')
    const text = el ? (el.textContent ?? '') : ''
    return { len: text.length, hasBody: text.includes('ALPHA CONTENT') }
  })()`)

/** 渲染端是否处于流式（输入卡片的停止按钮由 selectIsStreaming 直接决定） */
const streaming = (): Promise<boolean> =>
  app.main.eval<boolean>(`document.querySelector('.lucide-square') !== null`)

beforeAll(async () => {
  app = await launchApp()
  provider = await startFakeProvider()
  await seedFakeProvider(app.main, { baseUrl: provider.baseUrl, modelId: MODEL })
  await waitRendererReady(app.main)

  projDir = join(app.home, 'proj-identity')
  mkdirSync(projDir, { recursive: true })
  writeFileSync(join(projDir, 'alpha.txt'), 'ALPHA CONTENT line1\nALPHA CONTENT line2\n')
  const project = await createProject(app.main, { name: 'IdentityProj', path: projDir })
  sid = await app.main.eval<string>(
    `window.api.session
      .create(${JSON.stringify({ title: 'K-expand', projectId: project.id })})
      .then((s) => s.id)`
  )

  chat = chatPane(app.main)
  sidebar = sidebarPane(app.main)
  await sidebar.clickNewChat()
  await until(async () => (await sidebar.titles()).includes('K-expand'), 'sidebar refreshed')
  events = eventRecorder(app.main)
  await events.install()
}, 180_000)

afterAll(async () => {
  await provider.close()
  await app.stop()
})

describe('流式落定', () => {
  it('运行中展开的工具卡片，在本轮 agent_end 之后仍然是展开的', async () => {
    provider.reset()
    await events.clear()
    provider.script(
      {
        toolCalls: [
          {
            id: 'call_keep',
            name: 'read',
            args: JSON.stringify({ path: join(projDir, 'alpha.txt') })
          }
        ],
        usage: { prompt: 90, completion: 6 }
      },
      // 正文流出来后挂住：制造「工具已完成 + 仍在流式」的窗口
      {
        text: ['最终', '回答'],
        chunkDelayMs: 50,
        holdMs: 25_000,
        usage: { prompt: 120, completion: 8 }
      }
    )

    expect(await sidebar.openSession('K-expand')).toBe(true)
    await chat.ready()
    await chat.typeAndSend('读一下 alpha')

    await events.waitFor('tool_end', { sessionId: sid })
    await until(
      async () => (await chat.toolRows()).some((r) => r.status === 'done'),
      'tool settled'
    )
    await until(streaming, 'renderer still streaming')

    const collapsed = await toolCard()
    await chat.expandToolRow(0)
    const expanded = await toolCard()
    expect(expanded.hasBody).toBe(true)
    expect(expanded.len).toBeGreaterThan(collapsed.len)

    provider.release()
    await events.waitFor('agent_end', { sessionId: sid })
    await chat.waitIdle()

    // 本轮结束不重挂载 —— 展开态原样还在
    const after = await toolCard()
    expect(after.hasBody).toBe(true)
    expect(after.len).toBe(expanded.len)
  }, 120_000)
})
