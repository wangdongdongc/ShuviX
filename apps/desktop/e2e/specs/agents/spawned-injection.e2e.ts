/**
 * 派生 agent 的指令文件注入 —— 「按谁的工作目录解析」这条归属规则。
 *
 * 派生创建时 `cwd` 传的是空串（派生 agent 没有自己的工作目录，工具自带执行环境），
 * 宿主适配器要按**根会话**的项目工作目录兜底。兜不住的表现很隐蔽：派生 agent 的
 * 系统提示词里那段围栏直接消失（或者更糟，落到进程 cwd 上读到别的仓的文件），
 * 而根会话那条一切正常 —— 只看根会话是发现不了的。
 *
 * 接缝是假提供商记下的 payload（`chatRequests().raw`）：派生 agent 不经 `agent.getInfo`，
 * 它的系统提示词只有真的发出去才看得见。两个 agent 各列**不同的**文件名
 * （根=AGENTS.md、派生=SUB.md），断言据此认人而不认请求顺序。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { until } from '../../harness/cdp'
import { launchApp, type E2EApp } from '../../harness/launch'
import { startFakeProvider, type FakeProvider } from '../../harness/fakeProvider'
import {
  createProject,
  seedFakeProvider,
  waitRendererReady,
  writeAgentMd
} from '../../harness/seed'

const MODEL = 'e2e-model'

let app: E2EApp
let provider: FakeProvider
let projectId = ''

beforeAll(async () => {
  app = await launchApp()
  provider = await startFakeProvider()
  await seedFakeProvider(app.main, { baseUrl: provider.baseUrl, modelId: MODEL })
  await waitRendererReady(app.main)

  const projDir = join(app.home, 'proj-spawn-inject')
  mkdirSync(projDir, { recursive: true })
  // 根会话（default 档案）认 AGENTS.md；派生档案只认 SUB.md —— 两份内容互不重叠
  writeFileSync(join(projDir, 'AGENTS.md'), 'ROOT RULES CONTENT.')
  writeFileSync(join(projDir, 'SUB.md'), 'SUB RULES CONTENT.')
  projectId = (await createProject(app.main, { name: 'SpawnInjProj', path: projDir })).id

  writeAgentMd(app, 'ins-sub', {
    description: 'e2e spawned agent with its own instruction file list',
    tools: 'read',
    instructionFiles: 'SUB.md',
    body: 'SUB BODY.'
  })
})

afterAll(async () => {
  await provider.close()
  await app.stop()
})

/** `raw` 是 JSON.stringify(body)：围栏里的双引号在里面是 `\"`，断言前同样转义一次 */
const inPayload = (text: string): string => JSON.stringify(text).slice(1, -1)

describe('派生 agent 的指令文件', () => {
  it('IF-E-7 派生的 cwd 为空串，按根会话工作目录兜底：自己那条围栏是 SUB.md，根那条仍是 AGENTS.md', async () => {
    provider.reset()
    provider.script(
      // turn1（根）：派发 ins-sub
      {
        toolCalls: [
          {
            id: 'call_spawn',
            name: 'agent',
            args: JSON.stringify({ description: 'sub task', name: 'ins-sub', prompt: 'x' })
          }
        ],
        usage: { prompt: 90, completion: 8 }
      },
      // turn2（派生自身的一轮）
      { text: 'sub finished', usage: { prompt: 60, completion: 4 } },
      // turn3（根收到派发结果后的收尾）
      { text: 'root finished', usage: { prompt: 120, completion: 4 } }
    )

    const sid = await app.main.eval<string>(
      `window.api.session.create(${JSON.stringify({ title: 'spawn-inject', projectId })}).then((s) => s.id)`
    )
    await app.main.eval(
      `(() => {
        window.api.agent
          .prompt({ sessionId: ${JSON.stringify(sid)}, text: 'dispatch please' })
          .catch(() => undefined)
        return true
      })()`
    )

    // 派生 agent 不经 agent.getInfo —— 等它真的发出那一次请求
    await until(
      () => provider.chatRequests().some((r) => r.raw.includes('SUB BODY.')),
      'spawned agent LLM request'
    )
    const chats = provider.chatRequests()
    expect(chats.length).toBeGreaterThanOrEqual(2)

    // 派生那条：身份认自己的档案正文，围栏必须是它清单里的 SUB.md
    const spawned = chats.filter((r) => r.raw.includes('SUB BODY.'))
    expect(spawned, '派生 agent 的请求应恰好一条').toHaveLength(1)
    expect(spawned[0].raw).toContain(inPayload('<project_instructions file="SUB.md">'))
    expect(spawned[0].raw).toContain('SUB RULES CONTENT.')
    // 注入按**档案清单**取，不是把根会话解析好的那份原样继承
    expect(spawned[0].raw).not.toContain(inPayload('file="AGENTS.md"'))
    expect(spawned[0].raw).not.toContain('ROOT RULES CONTENT.')

    // 根那条照旧 —— 派生的兜底没有反过来污染根会话
    const root = chats.filter((r) => !r.raw.includes('SUB BODY.'))
    expect(root.length).toBeGreaterThan(0)
    expect(root[0].raw).toContain(inPayload('<project_instructions file="AGENTS.md">'))
    expect(root[0].raw).toContain('ROOT RULES CONTENT.')
  })
})
