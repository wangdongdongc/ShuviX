/**
 * Workflow 引擎 —— 埋点匹配（autorun/when/strict fail-safe）、run 生命周期（journal 记录、
 * 限额、墙钟超时、重入策略）、脚本 API（run/map/log/sleep/now/fail 与冻结克隆）。
 *
 * 全 fake deps（夹具在 ./harness.ts，与 engineLanes / engineInvoke 共用）：脚本引擎用
 * AsyncFunction 真执行脚本串（与 node:vm 同为「标准 JS + 顶层 return/await」语义，但零
 * 宿主依赖）；manager 可编排（gate 控制 run 挂起/放行）；观测面 = onRecord 收集数组 +
 * logger 收集。meta 记录在 fire 的同步段落盘 ——「fire 后立即断言 meta 有无」因此是
 * 确定性的，负向用例不需要等待。
 *
 * 分道 / invoke / extraApi 装配的用例在 engineLanes.test.ts 与 engineInvoke.test.ts。
 */
import { describe, expect, it, vi } from 'vitest'
import {
  TRIGGER_POINTS,
  getTriggerPoint,
  type TriggerId,
  type TriggerPayloadMap
} from '../triggerPoints'
import type { ParsedWorkflowFile, WorkflowConcurrency } from '../workflowFile'
import type { WorkflowRegistryEntry } from '../engine'
import type { RunTaskParams } from '../../subagent/manager'
import { MODEL, entryOf, fileOf, gatedRunTask, makeEngine, payload } from './harness'

describe('TRIGGER_POINTS 目录钉板', () => {
  it('恰两条目：id === 键、scope session、bindingParamKeys 空；未知 id 查无', () => {
    expect(Object.keys(TRIGGER_POINTS).sort()).toEqual([
      'session.prompt-accepted',
      'session.turn-completed'
    ])
    for (const [key, def] of Object.entries(TRIGGER_POINTS)) {
      expect(def.id).toBe(key)
      expect(def.scope).toBe('session')
      expect(def.bindingParamKeys).toEqual([])
    }
    expect(getTriggerPoint('nope')).toBeUndefined()
  })
})

describe('fire — 埋点匹配', () => {
  it('绑定命中 → 起 run：meta 含 invocation/source/sessionId/lane，event 信封 = payload + trigger + chain:[]', async () => {
    const { engine, metas, waitEnd } = makeEngine({ entries: [entryOf(fileOf())] })
    const p = payload()
    engine.fire('session.prompt-accepted', p)
    await waitEnd()
    expect(metas()).toEqual([
      {
        type: 'meta',
        // 调用路径进 meta（`fire` 是广播、`invoke` 是定向调用）—— journal 要能回答
        // 「这个 run 是被什么唤起的」，而 run 的身份是 runId 不是文件名
        invocation: { kind: 'trigger', trigger: 'session.prompt-accepted' },
        source: 'builtin',
        sessionId: 's1',
        // 分道键：会话域埋点缺省按会话分道（工作流名 + \0 + 会话 id）
        lane: 'wf\u0000s1',
        event: { ...p, trigger: 'session.prompt-accepted', chain: [] }
      }
    ])
  })

  it('纯 md 驱动：注册表里的条目一律参与匹配（没有启用开关这一维）', () => {
    // 曾有过 autorunEnabled 门；撤销后「在注册表里」== 「会被触发」，
    // 不想让它跑的唯一办法是把文件从目录里拿走（同 agent md）
    const { engine, records } = makeEngine({ entries: [entryOf(fileOf())] })
    engine.fire('session.prompt-accepted', payload())
    expect(records.length).toBeGreaterThan(0)
  })

  it('绑定在别的埋点 → 不起', () => {
    const { engine, records } = makeEngine({
      entries: [
        entryOf(
          fileOf({
            bindings: [{ trigger: 'session.turn-completed', when: undefined, params: {} }]
          })
        )
      ]
    })
    engine.fire('session.prompt-accepted', payload())
    expect(records).toEqual([])
  })

  it('when false → 不起；when true → 起', async () => {
    const bindWith = (when: string): WorkflowRegistryEntry =>
      entryOf(fileOf({ bindings: [{ trigger: 'session.prompt-accepted', when, params: {} }] }))
    const miss = makeEngine({ entries: [bindWith('false')] })
    miss.engine.fire('session.prompt-accepted', payload())
    expect(miss.records).toEqual([])

    const hit = makeEngine({ entries: [bindWith('true')] })
    hit.engine.fire('session.prompt-accepted', payload())
    expect(hit.metas()).toHaveLength(1)
    await hit.waitEnd()
  })

  it('strict fail-safe：when 访问 payload 缺失属性 → 不起 + warn 含工作流名', () => {
    const { engine, records, logs } = makeEngine({
      entries: [
        entryOf(
          fileOf({
            bindings: [{ trigger: 'session.prompt-accepted', when: 'event.missingKey', params: {} }]
          })
        )
      ]
    })
    engine.fire('session.prompt-accepted', payload())
    expect(records).toEqual([])
    expect(logs.some((l) => l.includes('"wf"') && l.includes('when evaluation failed'))).toBe(true)
  })

  it('when 可读 vars（file.vars）与 env（deps.env）', async () => {
    const { engine, metas, waitEnd } = makeEngine({
      entries: [
        entryOf(
          fileOf({
            vars: { a: 1 },
            bindings: [
              {
                trigger: 'session.prompt-accepted',
                when: "vars.a == 1 && env.host == 'desktop'",
                params: {}
              }
            ]
          })
        )
      ]
    })
    engine.fire('session.prompt-accepted', payload())
    expect(metas()).toHaveLength(1)
    await waitEnd()
  })

  it('同一工作流同埋点两条绑定都命中 → 恰一个 run', async () => {
    const { engine, metas, waitEnd } = makeEngine({
      entries: [
        entryOf(
          fileOf({
            bindings: [
              { trigger: 'session.prompt-accepted', when: undefined, params: {} },
              { trigger: 'session.prompt-accepted', when: 'true', params: {} }
            ]
          })
        )
      ]
    })
    engine.fire('session.prompt-accepted', payload())
    expect(metas()).toHaveLength(1)
    await waitEnd()
  })

  it('两个工作流都命中 → 各起一个', async () => {
    const { engine, records, waitEnd } = makeEngine({
      entries: [entryOf(fileOf({ name: 'wf-a' })), entryOf(fileOf({ name: 'wf-b' }))]
    })
    engine.fire('session.prompt-accepted', payload())
    await waitEnd(2)
    expect(
      records
        .filter((r) => r.rec.type === 'meta')
        .map((r) => r.name)
        .sort()
    ).toEqual(['wf-a', 'wf-b'])
  })

  it('listWorkflows 抛错 → fire 不抛、warn、零 run', () => {
    const { engine, records, logs } = makeEngine({
      listWorkflows: () => {
        throw new Error('scan blew up')
      }
    })
    expect(() => engine.fire('session.prompt-accepted', payload())).not.toThrow()
    expect(records).toEqual([])
    expect(logs.some((l) => l.includes('workflow registry listing failed'))).toBe(true)
  })

  it('未知埋点 id（强转）→ 静默返回，注册表都不扫', () => {
    const listWorkflows = vi.fn(() => [entryOf(fileOf())])
    const { engine, records } = makeEngine({ listWorkflows })
    engine.fire('nope' as TriggerId, {} as never)
    expect(records).toEqual([])
    expect(listWorkflows).not.toHaveBeenCalled()
  })
})

describe('run 生命周期与脚本 API', () => {
  it('脚本返回值 → end ok:true 且 output 为 JSON 克隆', async () => {
    const { engine, ends, waitEnd } = makeEngine({
      entries: [entryOf(fileOf({ script: "return { x: 1, s: 'a' }" }))]
    })
    engine.fire('session.prompt-accepted', payload())
    await waitEnd()
    expect(ends()[0].ok).toBe(true)
    expect(ends()[0].output).toEqual({ x: 1, s: 'a' })
    expect(typeof ends()[0].ms).toBe('number')
  })

  it("脚本 throw / fail('x') → end ok:false error='x'；fail() 缺省 workflow failed", async () => {
    for (const [script, error] of [
      ["throw new Error('x')", 'x'],
      ["fail('x')", 'x'],
      ['fail()', 'workflow failed']
    ] as const) {
      const { engine, ends, waitEnd } = makeEngine({ entries: [entryOf(fileOf({ script }))] })
      engine.fire('session.prompt-accepted', payload())
      await waitEnd()
      expect(ends()[0].ok).toBe(false)
      expect(ends()[0].error).toBe(error)
    }
  })

  it('log(x) → log 记录 String(x)；now() 为 ISO 串；sleep(10) 可 await', async () => {
    const { engine, records, ends, waitEnd } = makeEngine({
      entries: [
        entryOf(fileOf({ script: 'log(123)\nconst t0 = now()\nawait sleep(10)\nreturn { t0 }' }))
      ]
    })
    engine.fire('session.prompt-accepted', payload())
    await waitEnd()
    expect(records.some((r) => r.rec.type === 'log' && r.rec.message === '123')).toBe(true)
    const { t0 } = ends()[0].output as { t0: string }
    expect(new Date(t0).toISOString()).toBe(t0)
    expect(ends()[0].ok).toBe(true)
  })

  it('event/vars/schemas 深冻结且为克隆（脚本改不动，也不回写 deps 数据）', async () => {
    const file = fileOf({
      vars: { a: 1, nested: { b: 2 } },
      schemas: { out: { type: 'object' } },
      script: [
        'try { vars.a = 999 } catch {}',
        'try { event.promptText = "hacked" } catch {}',
        'try { schemas.out.type = "array" } catch {}',
        'return {',
        '  frozen: [Object.isFrozen(event), Object.isFrozen(vars), Object.isFrozen(vars.nested), Object.isFrozen(schemas)],',
        '  varsA: vars.a, promptText: event.promptText, schemaType: schemas.out.type',
        '}'
      ].join('\n')
    })
    const { engine, ends, waitEnd } = makeEngine({ entries: [entryOf(file)] })
    engine.fire('session.prompt-accepted', payload())
    await waitEnd()
    expect(ends()[0].output).toEqual({
      frozen: [true, true, true, true],
      varsA: 1,
      promptText: 'hi',
      schemaType: 'object'
    })
    // deps 侧的数据一个字节没动
    expect(file.vars).toEqual({ a: 1, nested: { b: 2 } })
    expect(file.schemas).toEqual({ out: { type: 'object' } })
  })

  it('input：信封无 input 时为 {}', async () => {
    const { engine, ends, waitEnd } = makeEngine({
      entries: [entryOf(fileOf({ script: 'return { input, keys: Object.keys(input).length }' }))]
    })
    engine.fire('session.prompt-accepted', payload())
    await waitEnd()
    expect(ends()[0].output).toEqual({ input: {}, keys: 0 })
  })

  it('会话域埋点 → runTask 的 parentSessionId === payload.sessionId', async () => {
    const { engine, runTask, waitEnd } = makeEngine({
      entries: [entryOf(fileOf({ script: "return await run('worker', 'p')" }))]
    })
    engine.fire('session.prompt-accepted', payload({ sessionId: 'sess-42' }))
    await waitEnd()
    expect(runTask).toHaveBeenCalledTimes(1)
    expect((runTask.mock.calls[0][0] as RunTaskParams).parentSessionId).toBe('sess-42')
  })
})

describe('run() — 派发原语', () => {
  it('opts.tools 交集收窄：档案没有的加不进来、两侧统一小写（mcp:MyServer 被 mcp:myserver 保留）', async () => {
    const { engine, runTask, ends, waitEnd } = makeEngine({
      entries: [
        entryOf(
          fileOf({
            script:
              "await run('worker', 'p', { tools: ['READ', 'write', 'mcp:myserver'] })\nreturn 'ok'"
          })
        )
      ]
    })
    engine.fire('session.prompt-accepted', payload())
    await waitEnd()
    expect(ends()[0].ok).toBe(true)
    // 档案 ['read','grep','mcp:MyServer']：READ 命中 read、write 加不进来、mcp:myserver 保住档案侧大小写
    expect((runTask.mock.calls[0][0] as RunTaskParams).agentType.tools).toEqual([
      'read',
      'mcp:MyServer'
    ])
  })

  it('opts.tools 非数组 → run 失败', async () => {
    const { engine, ends, waitEnd, runTask } = makeEngine({
      entries: [entryOf(fileOf({ script: "return await run('worker', 'p', { tools: 'read' })" }))]
    })
    engine.fire('session.prompt-accepted', payload())
    await waitEnd()
    expect(ends()[0].ok).toBe(false)
    expect(ends()[0].error).toContain('opts.tools must be a string array')
    expect(runTask).not.toHaveBeenCalled()
  })

  it('未知 agent ref → 错误含 ref 名与指引；ref/prompt 空或非字符串 → non-empty string', async () => {
    const script = [
      'const errs = []',
      "for (const [r, p] of [['ghost', 'p'], ['', 'p'], [null, 'p'], ['worker', '']]) {",
      '  try { await run(r, p) } catch (e) { errs.push(e.message) }',
      '}',
      'return errs'
    ].join('\n')
    const { engine, ends, waitEnd } = makeEngine({ entries: [entryOf(fileOf({ script }))] })
    engine.fire('session.prompt-accepted', payload())
    await waitEnd()
    const errs = ends()[0].output as string[]
    expect(errs[0]).toContain('unknown agent "ghost"')
    expect(errs[0]).toContain('must name a configured agent definition')
    expect(errs[1]).toContain('agent ref must be a non-empty string')
    expect(errs[2]).toContain('agent ref must be a non-empty string')
    expect(errs[3]).toContain('prompt must be a non-empty string')
  })

  it('opts.schema 非法 → run() 抛 run(): 前缀错误', async () => {
    const { engine, ends, waitEnd, runTask } = makeEngine({
      entries: [
        entryOf(
          fileOf({ script: "return await run('worker', 'p', { schema: { type: 'array' } })" })
        )
      ]
    })
    engine.fire('session.prompt-accepted', payload())
    await waitEnd()
    expect(ends()[0].ok).toBe(false)
    expect(ends()[0].error).toMatch(/^run\(\): /)
    expect(runTask).not.toHaveBeenCalled()
  })

  it('契约透传：runTask 收到 resultContract = {schema, sourceLabel: 工作流名, nudges: opts.nudges}', async () => {
    const { engine, runTask, waitEnd } = makeEngine({
      runTask: async () => ({ result: '{}', structured: {} }),
      entries: [
        entryOf(
          fileOf({
            name: 'contract-wf',
            script: "return await run('worker', 'p', { schema: { type: 'object' }, nudges: 2 })"
          })
        )
      ]
    })
    engine.fire('session.prompt-accepted', payload())
    await waitEnd()
    expect((runTask.mock.calls[0][0] as RunTaskParams).resultContract).toEqual({
      schema: { type: 'object' },
      sourceLabel: 'contract-wf',
      nudges: 2
    })
  })

  it('structured undefined → run() 抛带 code/finalText 属性的错误（裁决增补 3：可编程降级）', async () => {
    const longTail = 'x'.repeat(400)
    const { engine, ends, waitEnd } = makeEngine({
      runTask: async () => ({ result: longTail, structured: undefined }),
      entries: [
        entryOf(
          fileOf({
            script: [
              'try {',
              "  await run('worker', 'p', { schema: { type: 'object' } })",
              "  return 'no-throw'",
              '} catch (e) {',
              '  return { code: e.code, finalTextLen: e.finalText.length, finalText: e.finalText, msg: e.message }',
              '}'
            ].join('\n')
          })
        )
      ]
    })
    engine.fire('session.prompt-accepted', payload())
    await waitEnd()
    const out = ends()[0].output as {
      code: string
      finalTextLen: number
      finalText: string
      msg: string
    }
    expect(out.code).toBe('next_not_called')
    // finalText 是 runTask result 全文，不截断
    expect(out.finalTextLen).toBe(400)
    expect(out.finalText).toBe(longTail)
    // message 含 300 字转写尾巴
    expect(out.msg).toContain('finished without calling `next`')
    expect(out.msg).toContain('x'.repeat(300))
    expect(out.msg).not.toContain('x'.repeat(301))
  })

  it('structured 有值 → run() 返回 JSON 克隆（脚本改返回值不伤 manager 侧对象）', async () => {
    const shared = { keep: 1 }
    const { engine, ends, waitEnd } = makeEngine({
      runTask: async () => ({ result: 'r', structured: shared }),
      entries: [
        entryOf(
          fileOf({
            script:
              "const r = await run('worker', 'p', { schema: { type: 'object' } })\nr.added = 1\nreturn r"
          })
        )
      ]
    })
    engine.fire('session.prompt-accepted', payload())
    await waitEnd()
    expect(ends()[0].output).toEqual({ keep: 1, added: 1 })
    expect(shared).toEqual({ keep: 1 })
  })

  it('无 schema → 返回 res.result 文本、resultContract 为 undefined', async () => {
    const { engine, runTask, ends, waitEnd } = makeEngine({
      runTask: async () => ({ result: 'PLAIN TEXT' }),
      entries: [entryOf(fileOf({ script: "return await run('worker', 'p')" }))]
    })
    engine.fire('session.prompt-accepted', payload())
    await waitEnd()
    expect(ends()[0].output).toBe('PLAIN TEXT')
    expect((runTask.mock.calls[0][0] as RunTaskParams).resultContract).toBeUndefined()
  })

  it('模型只由归属会话给基准（工作流与脚本都不参与选模型）；无可用模型 → no model available', async () => {
    const specs: Array<{ sessionId?: string }> = []
    const { engine, waitEnd } = makeEngine({
      resolveRunModel: async (ctx) => {
        specs.push(ctx)
        return MODEL
      },
      entries: [
        entryOf(
          fileOf({
            // 脚本里写 model 选项也不再有任何影响 —— 定模型是被派发 agent 的属性
            script:
              "await run('worker', 'a', { model: 'ignored' })\nawait run('worker', 'b')\nreturn 'ok'"
          })
        )
      ]
    })
    engine.fire('session.prompt-accepted', payload())
    await waitEnd()
    expect(specs).toEqual([{ sessionId: 's1' }, { sessionId: 's1' }])

    const noModel = makeEngine({
      resolveRunModel: async () => null,
      entries: [entryOf(fileOf({ script: "return await run('worker', 'p')" }))]
    })
    noModel.engine.fire('session.prompt-accepted', payload())
    await noModel.waitEnd()
    expect(noModel.ends()[0].ok).toBe(false)
    expect(noModel.ends()[0].error).toContain('no model available')
  })

  it('description：opts.description 优先（trim）；缺省 = prompt 首行截 40 字', async () => {
    const { engine, runTask, waitEnd } = makeEngine({
      entries: [
        entryOf(
          fileOf({
            script: [
              "await run('worker', 'y'.repeat(60) + '\\nsecond line')",
              "await run('worker', 'p', { description: '  custom  ' })",
              "return 'ok'"
            ].join('\n')
          })
        )
      ]
    })
    engine.fire('session.prompt-accepted', payload())
    await waitEnd()
    expect((runTask.mock.calls[0][0] as RunTaskParams).description).toBe('y'.repeat(40))
    expect((runTask.mock.calls[1][0] as RunTaskParams).description).toBe('custom')
  })

  it('step_start/step_end 记录：agent 名、ms；schema 时 captured 布尔，无 schema 时 captured 为 undefined', async () => {
    const { engine, records, waitEnd } = makeEngine({
      runTask: async (p) => ({
        result: 'r',
        structured: p.prompt === 'captured' ? { ok: true } : undefined
      }),
      entries: [
        entryOf(
          fileOf({
            script: [
              "await run('worker', 'captured', { schema: { type: 'object' } })",
              "try { await run('worker', 'missed', { schema: { type: 'object' } }) } catch {}",
              "await run('worker', 'plain')",
              "return 'ok'"
            ].join('\n')
          })
        )
      ]
    })
    engine.fire('session.prompt-accepted', payload())
    await waitEnd()
    const starts = records.filter((r) => r.rec.type === 'step_start').map((r) => r.rec)
    const stepEnds = records.filter((r) => r.rec.type === 'step_end').map((r) => r.rec)
    expect(starts).toHaveLength(3)
    expect(starts[0]).toEqual({ type: 'step_start', agent: 'worker', description: 'captured' })
    expect(stepEnds).toHaveLength(3)
    for (const e of stepEnds) {
      expect(e.agent).toBe('worker')
      expect(typeof e.ms).toBe('number')
    }
    expect(stepEnds[0].captured).toBe(true)
    expect(stepEnds[1].captured).toBe(false)
    expect(stepEnds[2].captured).toBeUndefined()
  })

  it('maxAgents=2 起第 3 个 → workflow agent limit reached (maxAgents=2)', async () => {
    const { engine, ends, waitEnd, runTask } = makeEngine({
      entries: [
        entryOf(
          fileOf({
            limits: { maxAgents: 2 },
            script: [
              "await run('worker', 'a')",
              "await run('worker', 'b')",
              "try { await run('worker', 'c'); return 'no' } catch (e) { return e.message }"
            ].join('\n')
          })
        )
      ]
    })
    engine.fire('session.prompt-accepted', payload())
    await waitEnd()
    expect(ends()[0].output).toBe('workflow agent limit reached (maxAgents=2)')
    expect(runTask).toHaveBeenCalledTimes(2)
  })

  it('maxConcurrentAgents=2 + Promise.all 三连 run → 并发峰值恰 2', async () => {
    let active = 0
    let peak = 0
    const { engine, ends, waitEnd } = makeEngine({
      runTask: async () => {
        active++
        peak = Math.max(peak, active)
        await new Promise((r) => setTimeout(r, 20))
        active--
        return { result: 'ok' }
      },
      entries: [
        entryOf(
          fileOf({
            limits: { maxConcurrentAgents: 2 },
            script:
              "await Promise.all([run('worker', 'a'), run('worker', 'b'), run('worker', 'c')])\nreturn 'done'"
          })
        )
      ]
    })
    engine.fire('session.prompt-accepted', payload())
    await waitEnd()
    expect(ends()[0].ok).toBe(true)
    expect(peak).toBe(2)
  })

  it('map：单项抛错落为 null 不整体 reject + log 记录；items 非数组 / fn 非函数 → throw', async () => {
    const { engine, records, ends, waitEnd } = makeEngine({
      entries: [
        entryOf(
          fileOf({
            script: [
              "const out = await map([1, 2, 3], (x, i) => { if (x === 2) throw new Error('boom' + i); return x * 10 })",
              "let e1 = ''",
              "try { await map('x', () => 1) } catch (e) { e1 = e.message }",
              "let e2 = ''",
              "try { await map([], 'nope') } catch (e) { e2 = e.message }",
              'return { out, e1, e2 }'
            ].join('\n')
          })
        )
      ]
    })
    engine.fire('session.prompt-accepted', payload())
    await waitEnd()
    expect(ends()[0].output).toEqual({
      out: [10, null, 30],
      e1: 'map(items, fn): items must be an array',
      e2: 'map(items, fn): fn must be a function'
    })
    expect(
      records.some((r) => r.rec.type === 'log' && r.rec.message === 'map[1] failed: boom1')
    ).toBe(true)
  })
})

describe('重入策略与限时', () => {
  const gateFile = (concurrency: WorkflowConcurrency): ParsedWorkflowFile =>
    fileOf({ concurrency, script: "return await run('worker', event.promptText)" })

  it('skip（缺省）：run 挂起时二次 fire → 恰一条 meta + lane busy 日志', async () => {
    const { runTask, gates } = gatedRunTask()
    const eng = makeEngine({ runTask, entries: [entryOf(gateFile('skip'))] })
    eng.engine.fire('session.prompt-accepted', payload({ promptText: 'A' }))
    await vi.waitFor(() => expect(gates).toHaveLength(1))

    eng.engine.fire('session.prompt-accepted', payload({ promptText: 'B' }))
    expect(eng.metas()).toHaveLength(1)
    expect(eng.logs.some((l) => l.includes('lane busy — skipped'))).toBe(true)

    gates[0].release()
    await eng.waitEnd()
    expect(eng.metas()).toHaveLength(1)
  })

  it('queue：队列长度 1、覆盖队尾（裁决增补 2）—— 挂起期间三次 fire 中只有最后一个跑、两 run 不重叠', async () => {
    const { runTask, gates } = gatedRunTask()
    const eng = makeEngine({ runTask, entries: [entryOf(gateFile('queue'))] })
    eng.engine.fire('session.prompt-accepted', payload({ promptText: 'A' }))
    await vi.waitFor(() => expect(gates).toHaveLength(1))

    // 首个 run 挂起期间再 fire 两次：槽被覆盖，只留最后一个信封
    eng.engine.fire('session.prompt-accepted', payload({ promptText: 'B' }))
    eng.engine.fire('session.prompt-accepted', payload({ promptText: 'C' }))
    expect(eng.metas()).toHaveLength(1)
    expect(eng.logs.filter((l) => l.includes('lane busy — queued (slot of 1)'))).toHaveLength(2)

    gates[0].release()
    await vi.waitFor(() => expect(gates).toHaveLength(2))
    expect(gates[1].prompt).toBe('C')
    gates[1].release()
    await eng.waitEnd(2)

    // 总共恰 2 个 run：第一个 + 最后一个的信封；中间的 B 被覆盖丢弃
    const promptOf = (rec: Record<string, unknown>): unknown =>
      (rec.event as Record<string, unknown>).promptText
    expect(eng.metas().map(promptOf)).toEqual(['A', 'C'])
    // 不重叠：A 的 end 先于 C 的 meta
    const types = eng.records.map(
      (r) => `${r.rec.type}:${r.rec.type === 'meta' ? promptOf(r.rec) : ''}`
    )
    expect(types.indexOf('end:')).toBeLessThan(types.indexOf('meta:C'))
  })

  it('parallel：允许重叠（两条 meta 都先于任一 end）', async () => {
    const { runTask, gates } = gatedRunTask()
    const eng = makeEngine({ runTask, entries: [entryOf(gateFile('parallel'))] })
    eng.engine.fire('session.prompt-accepted', payload({ promptText: 'A' }))
    eng.engine.fire('session.prompt-accepted', payload({ promptText: 'B' }))
    await vi.waitFor(() => expect(gates).toHaveLength(2))
    expect(eng.metas()).toHaveLength(2)
    expect(eng.ends()).toHaveLength(0)

    gates[0].release()
    gates[1].release()
    await eng.waitEnd(2)
  })

  it('墙钟超时：永挂脚本 → end ok:false 含 timed out after；在飞 run() 的 parentAbortSignal 已 aborted', async () => {
    let captured: RunTaskParams | undefined
    const eng = makeEngine({
      runTask: (p: RunTaskParams) => {
        captured = p
        return new Promise(() => {})
      },
      entries: [
        entryOf(
          fileOf({
            limits: { maxDurationSec: 0.05 },
            script: "return await run('worker', 'never-ends')"
          })
        )
      ]
    })
    eng.engine.fire('session.prompt-accepted', payload())
    await eng.waitEnd()
    expect(eng.ends()[0].ok).toBe(false)
    expect(eng.ends()[0].error).toContain('timed out after')
    expect(captured?.parentAbortSignal?.aborted).toBe(true)
  })

  it('abort 后：挂起的 sleep reject、再调 run() 同抛 workflow run aborted', async () => {
    const eng = makeEngine({
      entries: [
        entryOf(
          fileOf({
            limits: { maxDurationSec: 0.05 },
            script: [
              "try { await sleep(60000) } catch (e) { log('sleep:' + e.message) }",
              "try { await run('worker', 'p') } catch (e) { log('run:' + e.message) }",
              "return 'after'"
            ].join('\n')
          })
        )
      ]
    })
    eng.engine.fire('session.prompt-accepted', payload())
    await eng.waitEnd()
    await vi.waitFor(() => {
      const logs = eng.records.filter((r) => r.rec.type === 'log').map((r) => r.rec.message)
      expect(logs).toContain('sleep:workflow run aborted')
      expect(logs).toContain('run:workflow run aborted')
    })
  })

  it('onRecord 抛错不影响 run', async () => {
    const eng = makeEngine({
      onRecord: (_n, _r, rec) => {
        if (rec.type === 'meta') throw new Error('journal disk full')
      },
      entries: [entryOf(fileOf({ script: 'return 42' }))]
    })
    eng.engine.fire('session.prompt-accepted', payload())
    await eng.waitEnd()
    expect(eng.ends()[0]).toMatchObject({ ok: true, output: 42 })
  })

  it('runningCount：run 中 >0、收尾后归 0', async () => {
    const { runTask, gates } = gatedRunTask()
    const eng = makeEngine({ runTask, entries: [entryOf(gateFile('skip'))] })
    expect(eng.engine.runningCount()).toBe(0)
    eng.engine.fire('session.prompt-accepted', payload())
    expect(eng.engine.runningCount()).toBe(1)
    await vi.waitFor(() => expect(gates).toHaveLength(1))
    gates[0].release()
    await eng.waitEnd()
    await vi.waitFor(() => expect(eng.engine.runningCount()).toBe(0))
  })
})

describe('run() 的 timeoutSec —— 本次派发的墙钟', () => {
  /** 'slow' 挂到 parentAbortSignal 落下才 reject（真 manager 的中止语义）；其余立刻返回 */
  const slowThenFast = (
    capture: (p: RunTaskParams) => void
  ): ((p: RunTaskParams) => Promise<{ result: string }>) => {
    return (p) => {
      capture(p)
      if (p.prompt !== 'slow') return Promise.resolve({ result: 'FAST' })
      return new Promise((_resolve, reject) =>
        p.parentAbortSignal?.addEventListener(
          'abort',
          () => reject(new Error('step aborted by signal')),
          { once: true }
        )
      )
    }
  }

  it('到点只落这一层：该步骤 signal aborted，run 本身不受影响（后续 run() 照常派发、end ok:true）', async () => {
    const seen: RunTaskParams[] = []
    const eng = makeEngine({
      runTask: slowThenFast((p) => seen.push(p)),
      entries: [
        entryOf(
          fileOf({
            script: [
              "try { await run('worker', 'slow', { timeoutSec: 0.05 }) } catch (e) { log('step:' + e.message) }",
              "return await run('worker', 'fast')"
            ].join('\n')
          })
        )
      ]
    })
    eng.engine.fire('session.prompt-accepted', payload())
    await eng.waitEnd()

    // 这一层落下了……
    expect(seen[0].parentAbortSignal?.aborted).toBe(true)
    expect(
      eng.records.some(
        (r) => r.rec.type === 'log' && r.rec.message === 'step:step aborted by signal'
      )
    ).toBe(true)
    // ……run 本身没有：第二次派发照常发生，脚本正常收尾
    expect(seen).toHaveLength(2)
    expect(seen[1].parentAbortSignal?.aborted).toBe(false)
    expect(eng.ends()[0]).toMatchObject({ ok: true, output: 'FAST' })
  })

  it('与 run 级 deadline 取先到者：maxDurationSec 更短 → 整 run 超时收尾，步骤随之落下', async () => {
    const seen: RunTaskParams[] = []
    const eng = makeEngine({
      runTask: slowThenFast((p) => seen.push(p)),
      entries: [
        entryOf(
          fileOf({
            limits: { maxDurationSec: 0.03 },
            // timeoutSec 远在 deadline 之后 —— 落下的是 run 级那一层
            script: "return await run('worker', 'slow', { timeoutSec: 30 })"
          })
        )
      ]
    })
    eng.engine.fire('session.prompt-accepted', payload())
    await eng.waitEnd()
    expect(eng.ends()[0].ok).toBe(false)
    expect(eng.ends()[0].error).toContain('timed out after')
    expect(seen[0].parentAbortSignal?.aborted).toBe(true)
  })

  it('无 timeoutSec 时 run 级中止仍级联到在飞步骤（链在 run 的 controller 上）', async () => {
    const seen: RunTaskParams[] = []
    const eng = makeEngine({
      runTask: slowThenFast((p) => seen.push(p)),
      entries: [entryOf(fileOf({ script: "return await run('worker', 'slow')" }))]
    })
    eng.engine.fire('session.prompt-accepted', payload())
    await vi.waitFor(() => expect(seen).toHaveLength(1))
    const runId = eng.engine.listRuns()[0].runId

    expect(eng.engine.abortRun(runId)).toBe(true)
    await eng.waitEnd()
    expect(seen[0].parentAbortSignal?.aborted).toBe(true)
  })

  it('步骤正常结束后定时器与 run-abort 监听都被清理：过了 timeoutSec 该步骤的 signal 仍未 aborted', async () => {
    const seen: RunTaskParams[] = []
    const eng = makeEngine({
      runTask: slowThenFast((p) => seen.push(p)),
      entries: [
        entryOf(fileOf({ script: "return await run('worker', 'fast', { timeoutSec: 0.05 })" }))
      ]
    })
    eng.engine.fire('session.prompt-accepted', payload())
    await eng.waitEnd()
    // 等过 timeoutSec：未清理的定时器会在此期间 abort 这个（已经结束的）步骤
    await new Promise((r) => setTimeout(r, 120))
    expect(seen[0].parentAbortSignal?.aborted).toBe(false)
  })

  it.each([
    ['0', '0'],
    ['负数', '-1'],
    ['字符串', "'5'"],
    ['null', 'null']
  ])(
    '【钉现状】timeoutSec 非法值（%s）→ 不设限时也不抛（与 opts.tools/opts.schema 的严格校验不同口径）',
    async (_label, literal) => {
      const eng = makeEngine({
        entries: [
          entryOf(fileOf({ script: `return await run('worker', 'p', { timeoutSec: ${literal} })` }))
        ]
      })
      eng.engine.fire('session.prompt-accepted', payload())
      await eng.waitEnd()
      expect(eng.ends()[0].ok).toBe(true)
      expect(eng.runTask).toHaveBeenCalledTimes(1)
    }
  )
})

describe('收尾的两处安全网（回归）', () => {
  it('run 中止之后新发起的 sleep 立即 reject —— 脱手脚本不得在收尾后继续跑', async () => {
    // node:vm 无法硬中断异步续体：run 判超时收尾后脚本还在跑。少了 sleep 的 aborted 守卫，
    // `while (true) { await sleep(1000) }` 会永远跑下去
    const eng = makeEngine({
      entries: [
        entryOf(
          fileOf({
            limits: { maxDurationSec: 0.05 },
            script: [
              "try { await sleep(60000) } catch (e) { log('first:' + e.message) }",
              "try { await sleep(10); log('second:resolved') } catch (e) { log('second:' + e.message) }"
            ].join('\n')
          })
        )
      ]
    })
    eng.engine.fire('session.prompt-accepted', payload())
    await eng.waitEnd()
    await vi.waitFor(() => {
      const logs = eng.records.filter((r) => r.rec.type === 'log').map((r) => r.rec.message)
      expect(logs).toContain('first:workflow run aborted')
      expect(logs).toContain('second:workflow run aborted')
    })
  })

  it('占坑之后的异常（不可 JSON 化的 payload）仍走收尾：end 落盘、分道释放、下一次 fire 照起', async () => {
    const eng = makeEngine({ entries: [entryOf(fileOf())] })
    const circular = payload() as TriggerPayloadMap['session.prompt-accepted'] & {
      self?: unknown
    }
    circular.self = circular

    eng.engine.fire('session.prompt-accepted', circular)
    await eng.waitEnd()
    expect(eng.ends()[0].ok).toBe(false)
    await vi.waitFor(() => expect(eng.engine.runningCount()).toBe(0))

    // 同一分道（缺省 = 同一 sessionId）没有被永久占住
    eng.engine.fire('session.prompt-accepted', payload())
    await eng.waitEnd(2)
    expect(eng.ends()[1]).toMatchObject({ ok: true, output: 1 })
  })
})

describe('prompt() —— md 提示词块的脚本 API', () => {
  const promptFile = (
    script: string,
    prompts: Record<string, string>,
    vars: Record<string, unknown> = {}
  ): ParsedWorkflowFile => fileOf({ script, prompts, vars })

  it('作用域 = {...input, input, vars, event}：顶层平铺、点分路径、vars/event 都可达', async () => {
    const eng = makeEngine({
      entries: [
        entryOf(
          promptFile(
            "return prompt('task')",
            {
              task: [
                'tag={{tag}}',
                'nested={{deep.k}}',
                'viaInput={{input.tag}}',
                'var={{vars.dir}}',
                'trigger={{event.trigger}}'
              ].join('\n')
            },
            { dir: 'reports' }
          )
        )
      ]
    })
    const res = await eng.engine.invoke({
      workflow: 'wf',
      input: { tag: 'T', deep: { k: 'K' } }
    })
    expect(res.output).toBe(
      ['tag=T', 'nested=K', 'viaInput=T', 'var=reports', 'trigger=call'].join('\n')
    )
  })

  it('extras 并进作用域且优先级最高（窗口切片留在脚本里，模板不发明切片语法）', async () => {
    const eng = makeEngine({
      entries: [
        entryOf(
          promptFile(
            "return prompt('task', { window: input.window.slice(-2), tag: 'FROM-EXTRAS' })",
            {
              task: 'tag={{tag}}\n<window>\n{{window}}\n</window>'
            }
          )
        )
      ]
    })
    const res = await eng.engine.invoke({
      workflow: 'wf',
      input: { tag: 'FROM-INPUT', window: ['a', 'b', 'c'] }
    })
    expect(res.output).toBe('tag=FROM-EXTRAS\n<window>\nb\nc\n</window>')
  })

  it('取不存在的块 → throw，文案指出该加一个 md prompt=<name> 块', async () => {
    const eng = makeEngine({ entries: [entryOf(promptFile("return prompt('ghost')", {}))] })
    const res = await eng.engine.invoke({ workflow: 'wf' })
    expect(res.ok).toBe(false)
    expect(res.error).toContain('prompt("ghost")')
    expect(res.error).toContain('md prompt=ghost')
  })

  it('可选上下文不留空洞：缺失的占位符行整行消失', async () => {
    const eng = makeEngine({
      entries: [entryOf(promptFile("return prompt('task')", { task: 'head\n{{missing}}\ntail' }))]
    })
    expect((await eng.engine.invoke({ workflow: 'wf' })).output).toBe('head\ntail')
  })
})
