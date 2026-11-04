/**
 * agent 调组件操作的共用部分（`agentCall.ts`）：组件的 MCP 服务器（真调用）和 `widget` 工具的 `test`（回滚）走这一段，
 * 找操作、报错的说法和结果的文字才不会分叉。分发器（`callWidgetOp`）与快照是替身，它们自己的行为在 widgetApi.test.ts。
 *
 *   AC-1 resolveAgentOp：缺省看不到纯界面的操作（清单也不提），`screenOnly` 看得到
 *   AC-2 老组件 / 没有快照 → has no API
 *   AC-3 真调用：dryRun / allowUiOnly 都是 false，expectedMode 是这次授权按的读写；结果是缩进两格的 JSON
 *   AC-4 dryRun：两个都 true；成功和失败都附回滚的说明
 *   AC-5 失败的文字：invalid_args 附 schema、ctx.fail 是 [code] message、internal 说是组件的代码出错；都带日志
 *   AC-6 WidgetApiError → isError；别的错误原样抛
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WidgetCaller } from '../api/hostProtocol'
import type { OpManifest } from '../api/sandboxRuntime'

const h = vi.hoisted(() => {
  class WidgetApiError extends Error {
    constructor(
      readonly code: string,
      message: string
    ) {
      super(message)
    }
  }
  return {
    WidgetApiError,
    callWidgetOp: vi.fn(),
    readApiSnapshot: vi.fn(),
    widgetStorageOf: vi.fn(() => 'sqlite')
  }
})

vi.mock('../api/widgetApi', () => ({
  callWidgetOp: h.callWidgetOp,
  readApiSnapshot: h.readApiSnapshot,
  widgetStorageOf: h.widgetStorageOf,
  WidgetApiError: h.WidgetApiError
}))

import { resolveAgentOp, runWidgetOpForAgent } from '../agentCall'

const ID = 'reading-list'
const CALLER: WidgetCaller = { kind: 'agent', sessionId: 's1', actor: 'a', label: 'a' }

const op = (name: string, over: Partial<OpManifest> = {}): OpManifest => ({
  name,
  mode: 'read',
  description: `${name} desc`,
  agent: true,
  input: { type: 'object', properties: { title: { type: 'string' } } },
  ...over
})

const OPS = [op('listBooks'), op('addBook', { mode: 'write' }), op('saveColumns', { agent: false })]

const dispatched = (
  value: unknown,
  logs: string[] = []
): { result: { outcome: { ok: true; value: unknown }; logs: string[] } } => ({
  result: { outcome: { ok: true, value }, logs }
})

const failed = (
  code: string,
  message: string,
  logs: string[] = []
): {
  result: { outcome: { ok: false; error: { code: string; message: string } }; logs: string[] }
} => ({
  result: { outcome: { ok: false, error: { code, message } }, logs }
})

beforeEach(() => {
  h.callWidgetOp.mockReset().mockResolvedValue(dispatched(null))
  h.readApiSnapshot.mockReset().mockReturnValue({ hash: 'h', builtAt: 1, ops: OPS })
  h.widgetStorageOf.mockReset().mockReturnValue('sqlite')
})

describe('AC-1 resolveAgentOp', () => {
  it('AC-1 缺省：给 agent 的操作找得到', () => {
    expect(resolveAgentOp(ID, 'addBook')).toBe(OPS[1])
  })

  it('AC-1 缺省：纯界面的操作找不到，清单也不提它', () => {
    expect(() => resolveAgentOp(ID, 'saveColumns')).toThrow(
      `Widget "${ID}" has no operation "saveColumns". Its operations: listBooks, addBook.`
    )
  })

  it('AC-1 screenOnly：纯界面的也找得到；不认得的报错时也列出它', () => {
    expect(resolveAgentOp(ID, 'saveColumns', { screenOnly: true })).toBe(OPS[2])
    expect(() => resolveAgentOp(ID, 'nope', { screenOnly: true })).toThrow(
      'Its operations: listBooks, addBook, saveColumns.'
    )
  })
})

describe('AC-2 没有 API', () => {
  it('AC-2 老组件：不读快照', () => {
    h.widgetStorageOf.mockReturnValue('pglite')
    expect(() => resolveAgentOp(ID, 'x')).toThrow(`Widget "${ID}" has no API`)
    expect(h.readApiSnapshot).not.toHaveBeenCalled()
  })

  it('AC-2 SQLite 组件没有快照', () => {
    h.readApiSnapshot.mockReturnValue(null)
    expect(() => resolveAgentOp(ID, 'x')).toThrow(`Widget "${ID}" has no API`)
  })
})

describe('AC-3 真调用', () => {
  it('AC-3 dryRun / allowUiOnly 恒 false，expectedMode 是这次授权按的读写', async () => {
    h.callWidgetOp.mockResolvedValue(dispatched({ id: 1 }))
    const out = await runWidgetOpForAgent(ID, OPS[1], { title: 'x' }, CALLER)

    expect(h.callWidgetOp).toHaveBeenCalledTimes(1)
    expect(h.callWidgetOp).toHaveBeenCalledWith(ID, 'addBook', { title: 'x' }, CALLER, {
      dryRun: false,
      allowUiOnly: false,
      expectedMode: 'write'
    })
    expect(out).toEqual({ text: JSON.stringify({ id: 1 }, null, 2), isError: false })
  })

  it('AC-3 value 是 undefined → null；有日志附在 <logs> 里；没有回滚的说明', async () => {
    h.callWidgetOp.mockResolvedValue(dispatched(undefined, ['one', 'two']))
    const out = await runWidgetOpForAgent(ID, OPS[0], {}, CALLER)
    expect(out).toEqual({ text: 'null\n<logs>\none\ntwo\n</logs>', isError: false })
    expect(out.text).not.toContain('rolled back')
  })
})

describe('AC-4 dryRun', () => {
  const NOTE = '(dry run: everything it wrote was rolled back)'

  it('AC-4 dryRun + allowUiOnly 都 true；成功的结果附说明', async () => {
    h.callWidgetOp.mockResolvedValue(dispatched(1))
    const out = await runWidgetOpForAgent(ID, OPS[2], {}, CALLER, { dryRun: true })
    expect(h.callWidgetOp.mock.calls[0]![4]).toEqual({
      dryRun: true,
      allowUiOnly: true,
      expectedMode: 'read'
    })
    expect(out).toEqual({ text: `1\n${NOTE}`, isError: false })
  })

  it('AC-4 失败也附说明与日志，说明在日志前', async () => {
    h.callWidgetOp.mockResolvedValue(failed('not_found', 'No such book', ['l1']))
    const out = await runWidgetOpForAgent(ID, OPS[0], {}, CALLER, { dryRun: true })
    expect(out).toEqual({
      text: `[not_found] No such book\n${NOTE}\n<logs>\nl1\n</logs>`,
      isError: true
    })
  })
})

describe('AC-5 失败的文字', () => {
  it('AC-5 invalid_args：附上这个操作的 input schema', async () => {
    h.callWidgetOp.mockResolvedValue(failed('invalid_args', 'title: Required'))
    const out = await runWidgetOpForAgent(ID, OPS[1], {}, CALLER)
    expect(out).toEqual({
      text: `[invalid_args] title: Required\nInput schema: ${JSON.stringify(OPS[1].input)}`,
      isError: true
    })
  })

  it('AC-5 ctx.fail 的业务失败：[code] message，不附 schema', async () => {
    h.callWidgetOp.mockResolvedValue(failed('not_found', 'No such book'))
    expect(await runWidgetOpForAgent(ID, OPS[1], {}, CALLER)).toEqual({
      text: '[not_found] No such book',
      isError: true
    })
  })

  it('AC-5 handler 意外抛错（internal）：说清楚是组件的代码出了错', async () => {
    h.callWidgetOp.mockResolvedValue(failed('internal', 'TypeError: x'))
    expect(await runWidgetOpForAgent(ID, OPS[1], {}, CALLER)).toEqual({
      text: 'Widget operation failed: TypeError: x',
      isError: true
    })
  })
})

describe('AC-6 分发器抛错', () => {
  it('AC-6 WidgetApiError（含其间被重新构建的 changed）→ [code] message，isError', async () => {
    h.callWidgetOp.mockRejectedValue(new h.WidgetApiError('changed', 'is now a write operation'))
    expect(await runWidgetOpForAgent(ID, OPS[0], {}, CALLER)).toEqual({
      text: '[changed] is now a write operation',
      isError: true
    })
  })

  it('AC-6 别的错误原样抛（同一个对象）', async () => {
    const boom = new Error('boom')
    h.callWidgetOp.mockRejectedValue(boom)
    await expect(runWidgetOpForAgent(ID, OPS[0], {}, CALLER)).rejects.toBe(boom)
  })
})
