/**
 * 会话与 Agent 运行时的绑定关系 —— 「一个会话同一时刻只有一个运行时」。
 *
 * 为什么要端到端测：会话树只有一个 leaf 指针，谁 append 都挂在当前叶子上。两个运行时
 * 同时活着 = 两个 run 的消息交叉写进同一条分支，`tool_use` 与 `tool_result` 的配对当场
 * 作废，之后每一发请求都被 provider 打回（实测报文 `tool call id bash:35 is not found`），
 * 会话永久卡死。真实事故的触发路径就是「回退/重新生成时旧 run 还在跑」——
 * 旧实现在这里是 fire-and-forget 中止 + 立刻解绑，下一条消息就造出了第二个运行时。
 *
 * 断言落在**会话树的形状**上（`message.list` 是 entry 树的投影）：回退之后的新分支上
 * 只能有新 run 的消息，旧 run 的收尾（哪怕是一条 aborted 空回复）都不许挂上来。
 *
 * 抓手是假 provider 的 `holdMs`：内容片发完后挂住不发 finish_reason，run 就停在
 * 「LLM 请求在途」这一相位，正好模拟事故里那个停了 19 分钟的 run。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { until } from '../../harness/cdp'
import { launchApp, type E2EApp } from '../../harness/launch'
import { startFakeProvider, type FakeProvider } from '../../harness/fakeProvider'
import { createProject, seedFakeProvider, waitRendererReady } from '../../harness/seed'

const MODEL = 'e2e-model'

interface ListedMessage {
  id: string
  role: string
  content: string
}

let app: E2EApp
let provider: FakeProvider

const createSession = async (title: string, projectId: string): Promise<string> =>
  app.main.eval<string>(
    `window.api.session.create(${JSON.stringify({ title, projectId })}).then((s) => s.id)`
  )

const listMessages = (sid: string): Promise<ListedMessage[]> =>
  app.main.eval<ListedMessage[]>(`window.api.message.list(${JSON.stringify(sid)})`)

/**
 * 发送但不等它跑完（用例要在 run 还在途时动手）。
 * 刻意不返回 Promise —— `eval` 带 awaitPromise，返回它就变成同步等一整轮了。
 */
const promptDetached = (sid: string, text: string): Promise<boolean> =>
  app.main.eval(
    `(() => {
      window.api.agent.prompt({ sessionId: ${JSON.stringify(sid)}, text: ${JSON.stringify(text)} })
        .catch(() => undefined)
      return true
    })()`
  )

const promptAwaited = (sid: string, text: string): Promise<void> =>
  app.main.eval(
    `(async () => {
      await window.api.agent.prompt({ sessionId: ${JSON.stringify(sid)}, text: ${JSON.stringify(text)} })
        .catch(() => undefined)
    })()`
  )

const rollback = (sid: string, messageId: string): Promise<{ success: boolean }> =>
  app.main.eval(`window.api.message.rollback(${JSON.stringify({ sessionId: sid, messageId })})`)

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

beforeAll(async () => {
  app = await launchApp()
  provider = await startFakeProvider()
  await seedFakeProvider(app.main, { baseUrl: provider.baseUrl, modelId: MODEL })
  await waitRendererReady(app.main)

  projDir = join(app.home, 'proj-binding')
  mkdirSync(projDir, { recursive: true })
  writeFileSync(join(projDir, 'a.txt'), 'A\n')
  const project = await createProject(app.main, { name: 'BindingProj', path: projDir })
  projectId = project.id
})

let projectId = ''
let projDir = ''

afterAll(async () => {
  await provider.close()
  await app.stop()
})

describe('会话 ↔ 运行时绑定', () => {
  it('RB-1: 回退时旧 run 还在途 —— 关停完成才解绑，旧 run 的收尾不落在新分支上', async () => {
    provider.reset()
    const sid = await createSession('T-rollback-live', projectId)

    // 第一轮挂住不收尾：run 停在「请求在途」，模拟事故里那个迟迟不结束的 run
    provider.script(
      { text: 'stale', holdMs: 30_000, usage: { prompt: 90, completion: 4 } },
      { text: 'ghost', usage: { prompt: 90, completion: 4 } },
      { text: 'fresh', usage: { prompt: 90, completion: 4 } }
    )

    await promptDetached(sid, 'first')
    await until(async () => provider.chatRequestCount() >= 1, 'first run in flight')
    const before = await listMessages(sid)
    expect(before.map((m) => m.role)).toEqual(['user'])

    // 回退到这条用户消息之前 —— 此刻旧 run 还挂在 provider 那边
    expect(await rollback(sid, before[0].id)).toEqual({ success: true })

    // 回退返回时旧运行时保证已经停了：分支被清空，且不会再被写进任何东西
    expect(await listMessages(sid)).toEqual([])
    await sleep(600)
    expect(await listMessages(sid)).toEqual([])

    // 新一轮：分支上只能有这一轮的消息（旧 run 的 aborted 收尾若挂上来，这里会多出一条）
    provider.release()
    await promptAwaited(sid, 'second')
    const after = await listMessages(sid)
    expect(after.map((m) => m.role)).toEqual(['user', 'assistant'])
    expect(after[0].content).toBe('second')
  })

  it('RB-2: 回退目标不存在 —— 不动运行时，在跑的 run 照常跑完后续轮次', async () => {
    provider.reset()
    const sid = await createSession('T-rollback-noop', projectId)
    // 两轮：第一轮读文件（工作区内，不触发询问）并挂住，第二轮才是最终答复。
    // 判据落在「第二轮有没有发生」—— 旧实现在这里会无条件 invalidate，把跑着的 run 一起停掉
    provider.script(
      {
        toolCalls: [
          { id: 'call_noop', name: 'read', args: JSON.stringify({ path: join(projDir, 'a.txt') }) }
        ],
        holdMs: 30_000,
        usage: { prompt: 90, completion: 4 }
      },
      { text: 'done', usage: { prompt: 90, completion: 4 } }
    )

    await promptDetached(sid, 'keep going')
    await until(async () => provider.chatRequestCount() >= 1, 'run in flight')

    // 目标 id 不在树上：什么都不做（连 Agent 都不该动）
    expect(await rollback(sid, 'no-such-message')).toEqual({ success: true })

    provider.release()
    await until(async () => {
      const msgs = await listMessages(sid)
      return msgs.some((m) => m.role === 'assistant' && m.content === 'done')
    }, 'run continued to its second turn')
    expect(provider.chatRequestCount()).toBe(2)
  })

  it('RB-3: 清空消息也先关停 —— 清空后的新一轮从干净的树开始', async () => {
    provider.reset()
    const sid = await createSession('T-clear-live', projectId)
    provider.script(
      { text: 'stale', holdMs: 30_000, usage: { prompt: 90, completion: 4 } },
      { text: 'fresh', usage: { prompt: 90, completion: 4 } }
    )

    await promptDetached(sid, 'first')
    await until(async () => provider.chatRequestCount() >= 1, 'run in flight')

    await app.main.eval(`window.api.message.clear(${JSON.stringify(sid)})`)
    expect(await listMessages(sid)).toEqual([])

    provider.release()
    await promptAwaited(sid, 'second')
    const after = await listMessages(sid)
    expect(after.map((m) => m.role)).toEqual(['user', 'assistant'])
  })
})
