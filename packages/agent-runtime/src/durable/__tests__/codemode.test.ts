/**
 * Codemode Phase 1 · 运行时集成、配置生命周期与 `callers: ['model']` 工具隔离：
 *
 *   - CM-RT-01..04：启用 / 默认启用 / 关闭 / 默认 models: false
 *   - CM-RT-05：并发子调用（成功 + 失败），脚本 try/catch 捕获后汇总，`details.calls` 同时记两条
 *   - CM-RT-06..07：开关切换（true → false、false → true）对已落锁会话与新会话 / 重建 agent 的影响
 *   - CM-RT-08：reconfigure（切模型、增删 MCP）后 `lock.toolNames` 中 `codemode` 恰好一份，不进 `shuvix.agent.<cid>`
 *   - CM-RT-09：`inlineBudget: 100` 透传到 `createCodemodeExtension` 并正常运行
 *   - CM-CL-01..03：`ask` / `suggest` / `next` / `tool_search` 的 `callers: ['model']` 声明、包装后保留、
 *     沙箱与提示词隔离、以及模型直调不受影响
 */
import { InlineCodemodeSandbox, loadQuickJSWasm } from '@earendil-works/pi-codemode'
import { defineTool, type EntryRecord, type ToolRegistration } from '@earendil-works/pi-durable'
import { obj, str } from '@earendil-works/pi-schema'
import { describe, expect, it } from 'vitest'
import { createAskTool } from '../../askTool'
import { createSuggestTool } from '../../suggestTool'
import { NextTool } from '../../subagent/nextTool'
import { wrapDurableOutput } from '../../toolOutput/wrapDurableOutput'
import { backgroundContext as BG } from '../context'
import { SessionStateDoc } from '../docs'
import type { DurableSession } from '../durableSession'
import { parseLockRecord, type LockRecord } from '../lock'
import { defaultAgentConfig } from './support/agentConfig'
import { answer, callTool, fauxKit, requestTools } from './support/faux'
import { makeHost, registerHostCleanup } from './support/host'
import { mcpDecl } from './support/mcpFake'
import { allEntries } from './support/transcript'
import { withTimeout } from './support/wait'

registerHostCleanup()

const TIMEOUT = 20000
const SID = 'cm'
const wasm = loadQuickJSWasm()
const makeSandbox = (): InlineCodemodeSandbox => new InlineCodemodeSandbox({ wasm })

interface CodemodeCallRecord {
  readonly id?: string
  readonly name: string
  readonly args?: string
  readonly status: string
  readonly durationMs?: number
  readonly error?: string
}

interface CodemodeDetails {
  readonly calls?: CodemodeCallRecord[]
}

function makeEchoTool(name = 'echo'): ToolRegistration {
  return defineTool({
    name,
    description: `Echo text via ${name}`,
    parameters: obj({ text: str({ description: 'Text to echo' }) }),
    execute: async (args) => ({
      output: [{ type: 'text', text: `echo:${(args as { text: string }).text}` }]
    })
  })
}

function makeFailTool(name = 'boom'): ToolRegistration {
  return defineTool({
    name,
    description: 'Always fails with an error',
    parameters: obj({ reason: str({ description: 'Failure reason' }) }),
    execute: async (args) => ({
      isError: true,
      output: [{ type: 'text', text: `failed:${(args as { reason: string }).reason}` }]
    })
  })
}

async function toolResultEntries(session: DurableSession): Promise<EntryRecord[]> {
  return (await allEntries(await session.currentConversation())).filter(
    (entry) => entry.kind === 'pi.tool-result'
  )
}

function toolResultText(entry: EntryRecord): string {
  const msg = entry.model?.[0]
  if (msg?.role !== 'toolResult') return ''
  return msg.content
    .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
    .map((part) => part.text)
    .join('\n')
}

function toolResultDetails(entry: EntryRecord): CodemodeDetails | undefined {
  const msg = entry.model?.[0]
  if (msg?.role !== 'toolResult') return undefined
  return (msg as { details?: CodemodeDetails }).details
}

async function storedLockOf(session: DurableSession): Promise<LockRecord | undefined> {
  const doc = await session.harness.snapshot(SessionStateDoc, BG)
  return parseLockRecord(doc?.lock)
}

describe('Codemode Phase 1 · A. Runtime 集成与配置生命周期', () => {
  it(
    'CM-RT-01 启用 codemode：模型拿到 codemode 工具与系统提示词区块，执行 JS 子调用并完整记录 details.calls',
    async () => {
      const t = await makeHost({
        ephemeral: [SID],
        tools: [makeEchoTool()],
        codemode: {
          sandbox: makeSandbox(),
          isEnabled: () => true
        }
      })
      const session = await t.open(SID)
      t.kit.queue(
        callTool(
          'codemode',
          { code: `const r = await tools.echo({ text: 'hi' }); return r;` },
          'cm-1'
        ),
        answer('done')
      )

      expect(await withTimeout(session.submitUser('run echo'), TIMEOUT, 'submit')).toEqual({})

      const req0 = t.kit.requests[0]!
      expect(req0.tools.map((tool) => tool.name)).toContain('codemode')
      expect(req0.systemPrompt).toMatch(/codemode/i)
      expect(req0.systemPrompt).toContain('echo')

      const results = await toolResultEntries(session)
      expect(results).toHaveLength(1)
      expect(toolResultText(results[0]!)).toContain('echo:hi')
      const details = toolResultDetails(results[0]!)
      expect(details?.calls).toBeDefined()
      expect(details!.calls).toHaveLength(1)
      expect(details!.calls![0]).toMatchObject({
        name: 'echo',
        status: 'ok'
      })
      expect(typeof details!.calls![0]!.durationMs).toBe('number')
    },
    TIMEOUT
  )

  it(
    'CM-RT-02 省略 isEnabled 时默认启用，模型拿到 codemode 工具',
    async () => {
      const t = await makeHost({
        ephemeral: [SID],
        tools: [makeEchoTool()],
        codemode: { sandbox: makeSandbox() }
      })
      const session = await t.open(SID)
      t.kit.queue(answer('ok'))

      expect(await withTimeout(session.submitUser('hello'), TIMEOUT, 'submit')).toEqual({})
      expect(requestTools(t.kit, 0).map((tool) => tool.name)).toContain('codemode')
    },
    TIMEOUT
  )

  it(
    'CM-RT-03 codemode 为 undefined 或 isEnabled 返回 false 时，模型拿不到 codemode 且系统提示词不含 codemode 区块',
    async () => {
      // (1) codemode: undefined
      const tOff = await makeHost({
        ephemeral: ['off-1'],
        tools: [makeEchoTool()]
      })
      const sOff = await tOff.open('off-1')
      tOff.kit.queue(answer('ok'))
      expect(await withTimeout(sOff.submitUser('hi'), TIMEOUT, 'submit off')).toEqual({})
      expect(tOff.kit.requests[0]!.tools.map((tool) => tool.name)).not.toContain('codemode')
      expect(tOff.kit.requests[0]!.systemPrompt).not.toMatch(/codemode/i)

      // (2) isEnabled: () => false
      const tDisabled = await makeHost({
        ephemeral: ['off-2'],
        tools: [makeEchoTool()],
        codemode: {
          sandbox: makeSandbox(),
          isEnabled: () => false
        }
      })
      const sDisabled = await tDisabled.open('off-2')
      tDisabled.kit.queue(answer('ok'))
      expect(await withTimeout(sDisabled.submitUser('hi'), TIMEOUT, 'submit disabled')).toEqual({})
      expect(tDisabled.kit.requests[0]!.tools.map((tool) => tool.name)).not.toContain('codemode')
      expect(tDisabled.kit.requests[0]!.systemPrompt).not.toMatch(/codemode/i)
    },
    TIMEOUT
  )

  it(
    'CM-RT-04 省略 models 时默认等效 models: false（脚本中 typeof models === "undefined"）',
    async () => {
      const t = await makeHost({
        ephemeral: [SID],
        tools: [makeEchoTool()],
        codemode: { sandbox: makeSandbox() }
      })
      const session = await t.open(SID)
      t.kit.queue(
        callTool('codemode', { code: `return { kind: typeof models };` }, 'cm-models'),
        answer('done')
      )

      expect(await withTimeout(session.submitUser('check models'), TIMEOUT, 'submit')).toEqual({})
      const results = await toolResultEntries(session)
      expect(results).toHaveLength(1)
      expect(toolResultText(results[0]!)).toContain('undefined')
    },
    TIMEOUT
  )

  it(
    'CM-RT-05 Promise.all 并发调用两个工具（一成一败），脚本 try/catch 捕获后汇总，details.calls 记录两条及各自状态',
    async () => {
      const t = await makeHost({
        ephemeral: [SID],
        tools: [makeEchoTool(), makeFailTool()],
        codemode: { sandbox: makeSandbox() }
      })
      const session = await t.open(SID)
      const code = `
        const [okRes, errRes] = await Promise.all([
          tools.echo({ text: 'good' }),
          tools.boom({ reason: 'bad' }).catch((err) => ({ caught: String(err) }))
        ]);
        return { okRes, errRes };
      `
      t.kit.queue(callTool('codemode', { code }, 'cm-par'), answer('done'))

      expect(await withTimeout(session.submitUser('run both'), TIMEOUT, 'submit')).toEqual({})
      const results = await toolResultEntries(session)
      expect(results).toHaveLength(1)
      const text = toolResultText(results[0]!)
      expect(text).toContain('echo:good')
      expect(text).toContain('caught')

      const calls = toolResultDetails(results[0]!)?.calls ?? []
      expect(calls).toHaveLength(2)
      const echoCall = calls.find((c) => c.name === 'echo')
      const boomCall = calls.find((c) => c.name === 'boom')
      expect(echoCall).toMatchObject({ name: 'echo', status: 'ok' })
      expect(boomCall).toMatchObject({ name: 'boom', status: 'error' })
    },
    TIMEOUT
  )

  it(
    'CM-RT-06 开关 true → false：已落锁会话 reopen 后仍可执行 codemode，但新建会话不会获得 codemode',
    async () => {
      let enabled = true
      const first = await makeHost({
        tools: [makeEchoTool()],
        codemode: {
          sandbox: makeSandbox(),
          isEnabled: () => enabled
        }
      })
      const sOld = await first.open('old')
      first.kit.queue(answer('first'))
      expect(await withTimeout(sOld.submitUser('init'), TIMEOUT, 'init')).toEqual({})
      expect(requestTools(first.kit, 0).map((tool) => tool.name)).toContain('codemode')

      // 关掉开关并关闭旧会话（同进程 reopen 保留锁）
      enabled = false
      await withTimeout(first.host.close('old'), TIMEOUT, 'close old')

      // 旧会话重开：仍持有锁里的 codemode 并可正常执行
      const reopened = await first.open('old')
      first.kit.queue(
        callTool(
          'codemode',
          { code: `return await tools.echo({ text: 'still-works' });` },
          'cm-reopen'
        ),
        answer('reopened-ok')
      )
      expect(await withTimeout(reopened.submitUser('run again'), TIMEOUT, 'reopen run')).toEqual({})
      expect(requestTools(first.kit, 1).map((tool) => tool.name)).toContain('codemode')
      const results = await toolResultEntries(reopened)
      expect(results).toHaveLength(1)
      expect(toolResultText(results[0]!)).toContain('echo:still-works')

      // 新建会话：不获得 codemode
      const sNew = await first.open('fresh')
      first.kit.queue(answer('fresh-ok'))
      expect(await withTimeout(sNew.submitUser('hello fresh'), TIMEOUT, 'fresh run')).toEqual({})
      const freshReq = first.kit.requests.at(-1)!
      expect(freshReq.tools.map((tool) => tool.name)).not.toContain('codemode')
    },
    TIMEOUT
  )

  it(
    'CM-RT-07 开关 false → true：已锁定旧会话 reopen 与 reconfigure 后仍不获得 codemode；销毁重建 agent 或新建会话后获得',
    async () => {
      let enabled = false
      const config = defaultAgentConfig()
      const first = await makeHost({
        makeKit: () => fauxKit({ models: [{ id: 'faux-1' }, { id: 'faux-2' }] }),
        agentConfig: config,
        tools: [makeEchoTool()],
        codemode: {
          sandbox: makeSandbox(),
          isEnabled: () => enabled
        }
      })
      const sOld = await first.open('old')
      first.kit.queue(answer('first'))
      expect(await withTimeout(sOld.submitUser('init'), TIMEOUT, 'init')).toEqual({})
      expect(requestTools(first.kit, 0).map((tool) => tool.name)).not.toContain('codemode')

      // 打开开关并关闭再重开旧会话（同进程 reopen 保留旧锁）
      enabled = true
      await withTimeout(first.host.close('old'), TIMEOUT, 'close old')
      const reopened = await first.open('old')
      first.kit.queue(answer('after-reopen'))
      expect(await withTimeout(reopened.submitUser('turn 2'), TIMEOUT, 'turn 2')).toEqual({})
      expect(requestTools(first.kit, 1).map((tool) => tool.name)).not.toContain('codemode')

      // reconfigure（切换模型）：旧锁不会凭空多出 codemode
      config.model = { provider: 'faux', modelId: 'faux-2' }
      const reconf = await withTimeout(reopened.reconfigureAgent(), TIMEOUT, 'reconfigure')
      expect(reconf.applied).toBe(true)
      first.kit.queue(answer('after-reconf'))
      expect(await withTimeout(reopened.submitUser('turn 3'), TIMEOUT, 'turn 3')).toEqual({})
      expect(requestTools(first.kit, 2).map((tool) => tool.name)).not.toContain('codemode')

      // 销毁并重建 agent 后获得 codemode
      await withTimeout(reopened.destroyAgent(), TIMEOUT, 'destroy')
      first.kit.queue(answer('after-recreate'))
      expect(await withTimeout(reopened.submitUser('turn 4'), TIMEOUT, 'turn 4')).toEqual({})
      expect(requestTools(first.kit, 3).map((tool) => tool.name)).toContain('codemode')

      // 新建会话同样获得 codemode
      const sNew = await first.open('fresh')
      first.kit.queue(answer('fresh-ok'))
      expect(await withTimeout(sNew.submitUser('hello'), TIMEOUT, 'fresh')).toEqual({})
      expect(first.kit.requests.at(-1)!.tools.map((tool) => tool.name)).toContain('codemode')
    },
    TIMEOUT
  )

  it(
    'CM-RT-08 reconfigure（切模型、新增 MCP、移除 MCP）：lock.toolNames 中 codemode 恰留一份、不进 shuvix.agent.<cid> 且仍可执行',
    async () => {
      const config = defaultAgentConfig()
      config.toolOverlay = ['mcp:alpha']
      const t = await makeHost({
        ephemeral: [SID],
        kit: fauxKit({ models: [{ id: 'faux-1' }, { id: 'faux-2' }] }),
        agentConfig: config,
        toolHost: {
          agentTools: [makeEchoTool()],
          mcp: {
            alpha: [mcpDecl('one', 'alpha one')],
            beta: [mcpDecl('two', 'beta two')]
          }
        },
        codemode: { sandbox: makeSandbox() }
      })

      const session = await t.open(SID)
      t.kit.queue(answer('r1'))
      expect(await withTimeout(session.submitUser('init'), TIMEOUT, 'init')).toEqual({})

      const assertCodemodeUnique = async (): Promise<void> => {
        const lock = await storedLockOf(session)
        expect(lock).toBeDefined()
        expect(lock!.toolNames.filter((name) => name === 'codemode')).toHaveLength(1)
        const agentExt = t
          .registryOf(SID)
          ?.snapshot()
          .extension(`shuvix.agent.${lock!.conversationId}`)
        expect(agentExt?.tools?.map((tool) => tool.name) ?? []).not.toContain('codemode')
      }
      await assertCodemodeUnique()

      // 1) 切换模型 + 新增 MCP beta
      config.model = { provider: 'faux', modelId: 'faux-2' }
      config.toolOverlay = ['mcp:alpha', 'mcp:beta']
      expect((await withTimeout(session.reconfigureAgent(), TIMEOUT, 'reconf 1')).applied).toBe(
        true
      )
      await assertCodemodeUnique()

      // 2) 移除 MCP alpha
      config.toolOverlay = ['mcp:beta']
      expect((await withTimeout(session.reconfigureAgent(), TIMEOUT, 'reconf 2')).applied).toBe(
        true
      )
      await assertCodemodeUnique()

      // 3) reconfigure 后仍可正常执行 codemode（并能调到新增的 mcp__beta__two）
      t.kit.queue(
        callTool(
          'codemode',
          { code: `return await tools.echo({ text: 'after-reconf' });` },
          'cm-after'
        ),
        answer('done')
      )
      expect(await withTimeout(session.submitUser('run after reconf'), TIMEOUT, 'run')).toEqual({})
      const lastTools = t.kit.requests[1]!.tools.map((tool) => tool.name)
      expect(lastTools.filter((name) => name === 'codemode')).toHaveLength(1)
      expect(lastTools).toContain('mcp__beta__two')
      expect(lastTools).not.toContain('mcp__alpha__one')

      const results = await toolResultEntries(session)
      expect(results).toHaveLength(1)
      expect(toolResultText(results[0]!)).toContain('echo:after-reconf')
    },
    TIMEOUT
  )

  it(
    'CM-RT-09 传入 inlineBudget: 100 能正常透传并运行无报错',
    async () => {
      const t = await makeHost({
        ephemeral: [SID],
        tools: [makeEchoTool()],
        codemode: {
          sandbox: makeSandbox(),
          inlineBudget: 100
        }
      })
      const session = await t.open(SID)
      t.kit.queue(
        callTool('codemode', { code: `return await tools.echo({ text: 'budget' });` }, 'cm-b'),
        answer('ok')
      )

      expect(await withTimeout(session.submitUser('budget test'), TIMEOUT, 'submit')).toEqual({})
      const results = await toolResultEntries(session)
      expect(results).toHaveLength(1)
      expect(toolResultText(results[0]!)).toContain('echo:budget')
    },
    TIMEOUT
  )
})

describe('Codemode Phase 1 · B. callers: ["model"] 工具隔离', () => {
  function makeModelOnlyTools(): {
    ask: ToolRegistration
    suggest: ToolRegistration
    next: ToolRegistration
    toolSearch: ToolRegistration
    ping: ToolRegistration
  } {
    const ask = createAskTool({
      requestUserInput: async () => ({ kind: 'choice', selections: ['Yes'] })
    })
    const suggest = createSuggestTool()
    const next = new NextTool({
      type: 'object',
      properties: { answer: { type: 'string' } },
      required: ['answer']
    })
    const toolSearch = defineTool({
      name: 'tool_search',
      description: 'Search and enable extensions',
      parameters: obj({ query: str({ description: 'Search query' }) }),
      callers: ['model'],
      execute: async (args) => ({
        output: [{ type: 'text', text: `searched:${(args as { query: string }).query}` }]
      })
    })
    const ping = defineTool({
      name: 'ping',
      description: 'Return pong',
      parameters: obj({ msg: str({ description: 'Message' }) }),
      execute: async (args) => ({
        output: [{ type: 'text', text: `pong:${(args as { msg: string }).msg}` }]
      })
    })
    return { ask, suggest, next, toolSearch, ping }
  }

  it('CM-CL-01（runtime 侧）ask / suggest / next 均声明 callers: ["model"]，经 wrapDurableOutput 包装后仍完整保留', () => {
    const ask = createAskTool({
      requestUserInput: async () => ({ kind: 'choice', selections: ['A'] })
    })
    const suggest = createSuggestTool()
    const next = new NextTool({
      type: 'object',
      properties: { ok: { type: 'boolean' } },
      required: ['ok']
    })

    for (const tool of [ask, suggest, next] as const) {
      expect(tool.callers).toEqual(['model'])
      const wrapped = wrapDurableOutput(tool, { spill: false })
      expect(wrapped.callers).toEqual(['model'])
    }
  })

  it(
    'CM-CL-02 启用 codemode 时，系统提示词与沙箱 tools 仅暴露 ping，不暴露 ask/suggest/next/tool_search，脚本调用它们会失败',
    async () => {
      const { ask, suggest, next, toolSearch, ping } = makeModelOnlyTools()
      const t = await makeHost({
        ephemeral: [SID],
        tools: [ask, suggest, next, toolSearch, ping],
        codemode: { sandbox: makeSandbox() }
      })
      const session = await t.open(SID)

      const probeCode = `
        const keys = Object.keys(tools).sort();
        const attempts = {};
        for (const name of ['ask', 'suggest', 'next', 'tool_search']) {
          try {
            await tools[name]({});
            attempts[name] = 'unexpected-ok';
          } catch (err) {
            attempts[name] = 'failed:' + String(err);
          }
        }
        const pingOut = await tools.ping({ msg: 'ok' });
        return { keys, attempts, pingOut };
      `
      t.kit.queue(callTool('codemode', { code: probeCode }, 'cm-iso'), answer('done'))

      expect(await withTimeout(session.submitUser('probe tools'), TIMEOUT, 'submit')).toEqual({})

      // 系统提示词里的 codemode 段落不应把 model-only 工具声明进 tools 命名空间
      const sysPrompt = t.kit.requests[0]!.systemPrompt
      expect(sysPrompt).toContain('ping')
      expect(sysPrompt).not.toMatch(/tools\.ask\b|\bask\s*\(/)
      expect(sysPrompt).not.toMatch(/tools\.suggest\b|\bsuggest\s*\(/)
      expect(sysPrompt).not.toMatch(/tools\.next\b|\bnext\s*\(/)
      expect(sysPrompt).not.toMatch(/tools\.tool_search\b|\btool_search\s*\(/)

      const results = await toolResultEntries(session)
      expect(results).toHaveLength(1)
      const text = toolResultText(results[0]!)
      expect(text).toContain('"keys":["ping"]')
      expect(text).toContain('pong:ok')
      for (const name of ['ask', 'suggest', 'next', 'tool_search']) {
        expect(text).toMatch(new RegExp(`"${name}":"failed:`))
        expect(text).not.toContain(`"${name}":"unexpected-ok"`)
      }
    },
    TIMEOUT
  )

  it(
    'CM-CL-03 模型直接发起对 ask / suggest / next / tool_search 的普通 toolCall 仍正常工作不受影响',
    async () => {
      const { ask, suggest, next, toolSearch, ping } = makeModelOnlyTools()
      const t = await makeHost({
        ephemeral: [SID],
        tools: [ask, suggest, next, toolSearch, ping],
        codemode: { sandbox: makeSandbox() }
      })
      const session = await t.open(SID)

      t.kit.queue(
        callTool(
          'ask',
          {
            question: 'Proceed?',
            options: [
              { label: 'Yes', description: 'Continue' },
              { label: 'No', description: 'Stop' }
            ]
          },
          'c-ask'
        ),
        callTool(
          'suggest',
          { suggestions: [{ title: 'Run tests', message: 'Please run tests' }] },
          'c-suggest'
        ),
        callTool('tool_search', { query: 'browser' }, 'c-search'),
        callTool('next', { answer: 'final-answer' }, 'c-next'),
        answer('all done')
      )

      expect(await withTimeout(session.submitUser('call model-only'), TIMEOUT, 'submit')).toEqual(
        {}
      )

      const results = await toolResultEntries(session)
      expect(results).toHaveLength(4)
      for (const entry of results) {
        const msg = entry.model?.[0]
        expect(msg?.role).toBe('toolResult')
        if (msg?.role === 'toolResult') {
          expect(msg.isError, `${msg.toolName}: ${toolResultText(entry)}`).toBe(false)
        }
      }
      expect(toolResultText(results[0]!)).toContain('Yes')
      expect(toolResultText(results[1]!)).toBeTruthy()
      expect(toolResultText(results[2]!)).toContain('searched:browser')
      expect(toolResultText(results[3]!)).toContain('Result recorded')
    },
    TIMEOUT
  )
})
