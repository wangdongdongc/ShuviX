// @vitest-environment jsdom
/**
 * 一条会话有几台 MCP 可勾、勾着几台（mobile/useMcpSummary.ts，jsdom）—— 手机上详情首页与空对话页的
 * 「扩展能力」那一行共用。
 *
 * 契约：`total` = `tools.list(sessionId)` 里 `group` 以 `mcp:` 开头的行数；`selected` = 其中按
 * `isToolSelected(enabledTools, name, declared)` 算勾着的（档案声明的缺省勾着，`-mcp:x` 退掉它，退订压过勾选）。
 * 列表没到、取不到时是 0 / 0；选择变了不重新取列表；卸载之后、换了会话之后迟到的回应不算数。
 * （换会话时上一条的数会留到新的回应到来 —— 用它的两处都按会话 id 作 key，所以这里不测。）
 *
 *   MS-1      列表没到
 *   MS-2..3   哪些行算 MCP
 *   MS-4..9   勾着几台：没声明 / 声明的 / 退订 / 空的 declaredBy / 混着
 *   MS-10     选择变了：数跟上，不重新取
 *   MS-11..13 取不到、卸载之后才到、迟到的上一条会话的回应
 *   MS-14     按会话 id 取，一个 id 一次
 *
 * `@shuvix/chat-ui` 是替身：`useSessionTools` 读一个真 zustand store（按会话记选择），`getSessionChannelApi`
 * 给一个可控的 `tools.list`；`isToolSelected` 是真的。文件是 `.ts`，一律 createElement。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'

interface ToolRow {
  name: string
  group?: string
  declaredBy?: string
}
interface SelectionStore {
  getState: () => { enabled: Record<string, string[]> }
  setState: (patch: { enabled: Record<string, string[]> }) => void
}

const rec = vi.hoisted(() => ({
  selection: null as unknown as SelectionStore,
  list: null as unknown as (sessionId: string) => Promise<ToolRow[]>
}))

vi.mock('@shuvix/chat-ui', async () => {
  const { create } = await import('zustand')
  const useSelection = create<{ enabled: Record<string, string[]> }>(() => ({ enabled: {} }))
  rec.selection = useSelection as unknown as SelectionStore
  const NONE: string[] = []
  return {
    useSessionTools: (sessionId: string) => ({
      enabledTools: useSelection((s) => s.enabled[sessionId] ?? NONE)
    }),
    getSessionChannelApi: () => ({ tools: { list: (sessionId: string) => rec.list(sessionId) } })
  }
})

import { useMcpSummary } from '../useMcpSummary'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

interface Deferred {
  resolve: (rows: ToolRow[]) => void
  reject: (error: unknown) => void
}
const pending: Record<string, Deferred[]> = {}
const list = vi.fn<(sessionId: string) => Promise<ToolRow[]>>()

let container: HTMLDivElement
let root: Root
let mounted = false
let renders = 0

function Probe({ sessionId }: { sessionId: string }): React.JSX.Element {
  const { total, selected } = useMcpSummary(sessionId)
  renders++
  return createElement('div', { 'data-probe': `${total}/${selected}` })
}
const shown = (): string | null =>
  container.querySelector('[data-probe]')?.getAttribute('data-probe') ?? null

function render(sessionId = 's1'): void {
  act(() => root.render(createElement(Probe, { sessionId })))
  mounted = true
}
async function flush(): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await act(async () => {
      await Promise.resolve()
    })
  }
}
/** 让某条会话的 `tools.list` 回来 */
async function resolve(sessionId: string, rows: ToolRow[]): Promise<void> {
  pending[sessionId]!.shift()!.resolve(rows)
  await flush()
}
async function reject(sessionId: string): Promise<void> {
  pending[sessionId]!.shift()!.reject(new Error('disconnected'))
  await flush()
}
function select(sessionId: string, enabled: string[]): void {
  act(() => rec.selection.setState({ enabled: { [sessionId]: enabled } }))
}
/** 挂上、列表回来、给定的选择 */
async function summary(rows: ToolRow[], enabled: string[] = []): Promise<string | null> {
  rec.selection.setState({ enabled: { s1: enabled } })
  render()
  await resolve('s1', rows)
  return shown()
}

const mcp = (name: string, declaredBy?: string): ToolRow => ({
  name: `mcp:${name}`,
  group: `mcp:${name}`,
  ...(declaredBy === undefined ? {} : { declaredBy })
})

beforeEach(() => {
  for (const key of Object.keys(pending)) delete pending[key]
  list.mockReset().mockImplementation(
    (sessionId) =>
      new Promise<ToolRow[]>((res, rej) => {
        ;(pending[sessionId] ??= []).push({ resolve: res, reject: rej })
      })
  )
  rec.list = list
  rec.selection.setState({ enabled: {} })
  renders = 0
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  mounted = false
})

afterEach(() => {
  if (mounted) act(() => root.unmount())
  container.remove()
  vi.restoreAllMocks()
})

describe('useMcpSummary', () => {
  it('MS-1 before the list arrives there is nothing to count', () => {
    render()
    expect(shown()).toBe('0/0')
  })

  it('MS-2 only rows in an mcp: group are servers', async () => {
    expect(
      await summary([mcp('a'), { name: 'read', group: 'builtin' }, { name: 'orphan' }], ['mcp:a'])
    ).toBe('1/1')
  })

  it('MS-3 the group decides, whatever the name is; near-misses do not count', async () => {
    expect(
      await summary([
        { name: 'anything', group: 'mcp:a' },
        { name: 'mcp:b', group: 'xmcp:' },
        { name: 'mcp:c', group: 'MCP:c' },
        { name: 'mcp:d', group: '__skills__' }
      ])
    ).toBe('1/0')
  })

  it('MS-4 an undeclared server counts as selected only when ticked', async () => {
    expect(await summary([mcp('a')])).toBe('1/0')
    select('s1', ['mcp:a'])
    expect(shown()).toBe('1/1')
  })

  it('MS-5 a server the profile declares is selected by default', async () => {
    expect(await summary([mcp('a', 'Work')])).toBe('1/1')
  })

  it('MS-6 an opt-out unticks a declared server, and wins over a tick', async () => {
    expect(await summary([mcp('a', 'Work')], ['-mcp:a'])).toBe('1/0')
    select('s1', ['mcp:a', '-mcp:a'])
    expect(shown()).toBe('1/0')
    select('s1', ['-mcp:a', 'mcp:a'])
    expect(shown()).toBe('1/0')
  })

  it('MS-7 an opt-out for an undeclared or unknown server changes nothing', async () => {
    expect(await summary([mcp('a'), mcp('b', 'Work')], ['-mcp:a', '-mcp:gone'])).toBe('2/1')
  })

  it('MS-8 an empty declaredBy is not a declaration', async () => {
    expect(await summary([mcp('a', '')])).toBe('1/0')
  })

  it('MS-9 a mix: declared, ticked and unticked servers beside builtin tools', async () => {
    expect(
      await summary(
        [
          mcp('declared', 'Work'),
          mcp('ticked'),
          mcp('off'),
          { name: 'read', group: 'builtin' },
          { name: 'write', group: 'builtin' }
        ],
        ['mcp:ticked']
      )
    ).toBe('3/2')
  })

  it('MS-10 a selection change is followed without listing again', async () => {
    expect(await summary([mcp('a'), mcp('b')])).toBe('2/0')
    select('s1', ['mcp:a'])
    expect(shown()).toBe('2/1')
    select('s1', ['mcp:a', 'mcp:b'])
    expect(shown()).toBe('2/2')
    select('s1', [])
    expect(shown()).toBe('2/0')
    expect(list).toHaveBeenCalledTimes(1)
  })

  it('MS-11 a list that fails leaves 0 / 0 and nothing unhandled', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)
    try {
      rec.selection.setState({ enabled: { s1: ['mcp:a'] } })
      render()
      await reject('s1')
      await new Promise((r) => setTimeout(r, 0))
      expect(shown()).toBe('0/0')
      expect(unhandled).not.toHaveBeenCalled()
      expect(errors).not.toHaveBeenCalled()
    } finally {
      process.off('unhandledRejection', unhandled)
    }
  })

  it('MS-12 a list that arrives after unmount updates nothing', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    render()
    act(() => root.unmount())
    mounted = false
    const before = renders
    await resolve('s1', [mcp('a')])
    expect(renders).toBe(before)
    expect(errors).not.toHaveBeenCalled()
  })

  it("MS-13 the previous session's late response does not replace the current one's", async () => {
    render('a')
    render('b')
    await resolve('b', [mcp('x', 'Work')])
    expect(shown()).toBe('1/1')
    await resolve('a', [mcp('p'), mcp('q'), mcp('r')])
    expect(shown()).toBe('1/1')
  })

  it('MS-14 the list is asked for by session id, once per id', async () => {
    render('a')
    expect(list).toHaveBeenCalledTimes(1)
    expect(list).toHaveBeenLastCalledWith('a')
    render('a')
    select('a', ['mcp:z'])
    expect(list).toHaveBeenCalledTimes(1)
    render('b')
    expect(list).toHaveBeenCalledTimes(2)
    expect(list).toHaveBeenLastCalledWith('b')
    await flush()
  })
})
