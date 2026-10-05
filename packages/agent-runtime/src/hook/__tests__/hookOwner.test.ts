/**
 * Hook runner · 宿主派发的接线（P2-08-50；假 deps，夹具见 harness.ts）：
 *  - 拥有者：判定带 `ownerTaskId` → 每个命中 hook 的 runTask 都是 `{task}`；没带 → `{anchor}`；观察型恒为 `{anchor}`。
 *    `ownerTaskId` 不进 prompt、不进 CEL 事件。每次 run 带 `hook: {name, runId}`（requestId `hook:<runId>`）。
 *  - 模型被拒（PIN-06）：`{refusal}` → start → end ok:false（error 即那句话）+ `failed:` 警告，不派发；判定 → null。
 *    null 仍是 skip `no-model`、抛错仍是 skip（HR-24 不变）。
 *  - 被中断的会话（PIN-07）：skip `interrupted`，不解析模型、不派发；探针抛错按被中断处理。
 */
import { describe, expect, it } from 'vitest'
import { renderHookPrompt } from '../hookPrompt'
import {
  entryOf,
  fileOf,
  makeRunner,
  permissionPayload,
  promptPayload,
  settle,
  verdict,
  verdictResult
} from './harness'

const DECIDE = 'permission.request'
const reviewFile = (name = 'hk', when?: string): ReturnType<typeof fileOf> =>
  fileOf({ name, bindings: [{ trigger: DECIDE, ...(when === undefined ? {} : { when }) }] })

describe('P2-08-50 hook runner · owners', () => {
  it('decide with ownerTaskId 9 → every matching hook dispatches with owner {task: 9}; hook {name, runId}', async () => {
    const h = makeRunner({
      entries: [entryOf(reviewFile('a')), entryOf(reviewFile('b'))],
      runTask: async () => verdictResult(verdict('allow'))
    })
    await h.runner.decide(DECIDE, permissionPayload(), { ownerTaskId: 9 })
    expect(h.runTask).toHaveBeenCalledTimes(2)
    expect(h.runTask.mock.calls.map(([params]) => params.owner)).toEqual([{ task: 9 }, { task: 9 }])
    const runIds = h.starts().map((start) => start.run.runId)
    expect(h.runTask.mock.calls.map(([params]) => params.hook).sort((x, y) => x!.name.localeCompare(y!.name))).toEqual([
      { name: 'a', runId: expect.any(String) },
      { name: 'b', runId: expect.any(String) }
    ])
    expect(new Set(h.runTask.mock.calls.map(([params]) => params.hook!.runId))).toEqual(
      new Set(runIds)
    )
  })

  it('decide without ownerTaskId → {anchor}; fire → {anchor} always', async () => {
    const h = makeRunner({
      entries: [entryOf(reviewFile()), entryOf(fileOf({ name: 'obs' }))],
      runTask: async (params) =>
        params.resultContract ? verdictResult(verdict('allow')) : { result: 'ok' }
    })
    await h.runner.decide(DECIDE, permissionPayload())
    h.runner.fire('session.prompt-accepted', promptPayload())
    await h.waitEnd(2)
    expect(h.runTask.mock.calls.map(([params]) => params.owner)).toEqual([
      { anchor: true },
      { anchor: true }
    ])
  })

  it('ownerTaskId reaches neither the rendered prompt nor the CEL event', async () => {
    const h = makeRunner({
      entries: [
        entryOf(reviewFile('plain')),
        // 事件里没有 ownerTaskId：读它 = 求值错误 → 不命中（fail-safe）
        entryOf(reviewFile('peeks', 'event.ownerTaskId == 9'))
      ],
      runTask: async () => verdictResult(verdict('allow'))
    })
    const payload = permissionPayload()
    await h.runner.decide(DECIDE, payload, { ownerTaskId: 9 })
    expect(h.runTask).toHaveBeenCalledTimes(1)
    const params = h.call()
    expect(params.resultContract?.sourceLabel).toBe('plain')
    expect(params.prompt).toBe(renderHookPrompt('Body.', DECIDE, { ...payload }))
    expect(params.prompt).not.toContain('ownerTaskId')
    expect(h.warns().some((line) => line.includes('hook "peeks": when evaluation failed'))).toBe(
      true
    )
  })
})

describe('P2-08-50 hook runner · model refusal (PIN-06)', () => {
  it('observe: {refusal} → start, end ok:false with the text, a failed: warning; no dispatch', async () => {
    const h = makeRunner({
      entries: [entryOf(fileOf())],
      resolveRunModel: async () => ({ refusal: 'Provider "x" is disabled' })
    })
    h.runner.fire('session.prompt-accepted', promptPayload())
    await h.waitEnd()
    expect(h.events.map((e) => e.type)).toEqual(['start', 'end'])
    expect(h.ends()[0]).toMatchObject({ ok: false, error: 'Provider "x" is disabled' })
    expect(h.warns()).toEqual([
      expect.stringMatching(/^hook "hk" run=hkr-\S+ failed: Provider "x" is disabled$/)
    ])
    expect(h.runTask).not.toHaveBeenCalled()
    expect(h.runner.runningCount()).toBe(0)
  })

  it('decide: {refusal} → null, the same start/end/failed:; no dispatch', async () => {
    const h = makeRunner({
      entries: [entryOf(reviewFile())],
      resolveRunModel: async () => ({ refusal: 'Model "m" is not available' })
    })
    expect(await h.runner.decide(DECIDE, permissionPayload(), { ownerTaskId: 3 })).toBeNull()
    expect(h.events.map((e) => e.type)).toEqual(['start', 'end'])
    expect(h.ends()[0]).toMatchObject({ ok: false, error: 'Model "m" is not available' })
    expect(h.warns()).toEqual([expect.stringMatching(/failed: Model "m" is not available$/)])
    expect(h.runTask).not.toHaveBeenCalled()
  })
})

describe('P2-08-50 hook runner · interrupted sessions (PIN-07)', () => {
  it('fire and decide on an interrupted session → skip interrupted; the model is never resolved; nothing dispatched; other sessions unaffected', async () => {
    const h = makeRunner({
      entries: [entryOf(fileOf()), entryOf(reviewFile('rev'))],
      isInterrupted: ({ sessionId }) => sessionId === 's1'
    })
    h.runner.fire('session.prompt-accepted', promptPayload())
    expect(await h.runner.decide(DECIDE, permissionPayload())).toBeNull()
    await settle()
    expect(h.skips().map((skip) => [skip.hook, skip.reason])).toEqual([
      ['hk', 'interrupted'],
      ['rev', 'interrupted']
    ])
    expect(h.resolveRunModel).not.toHaveBeenCalled()
    expect(h.runTask).not.toHaveBeenCalled()
    expect(h.infos()).toContainEqual(
      'hook "hk" skipped for session s1: interrupted (the session is interrupted; hooks never resume it)'
    )
    h.runner.fire('session.prompt-accepted', promptPayload({ sessionId: 's2' }))
    await h.waitEnd()
    expect(h.runTask).toHaveBeenCalledTimes(1)
  })

  it('an interrupted-probe that throws counts as interrupted (never resume by accident), with a warning', async () => {
    const h = makeRunner({
      entries: [entryOf(fileOf())],
      isInterrupted: () => {
        throw new Error('host gone')
      }
    })
    h.runner.fire('session.prompt-accepted', promptPayload())
    await settle()
    expect(h.skips().map((skip) => skip.reason)).toEqual(['interrupted'])
    expect(h.runTask).not.toHaveBeenCalled()
    expect(h.warns()).toContainEqual('hook interrupted-check failed for session s1: host gone')
  })
})
