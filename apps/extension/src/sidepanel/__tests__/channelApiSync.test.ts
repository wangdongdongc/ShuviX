/**
 * P3-05-12（扩展那一半）：侧边栏的 `SessionChannelApi.sync` 是桩子，直到 P3-09 接上桥上的传输 ——
 * `invoke` 以 code `'unsupported'` 拒绝，`onFrame` 交回一个注销函数（帧永远不来），一次请求都不发。
 */
import { describe, expect, it, vi } from 'vitest'
import { createPanelChannelApi } from '../channelApi'
import type { PanelLink } from '../panelLink'

describe('P3-05-12 扩展侧边栏的 sync 桩子', () => {
  it("P3-05-12 invoke 以 code 'unsupported' 拒绝；onFrame 交回函数；不经桥发任何请求", async () => {
    const request = vi.fn()
    const link = { request } as unknown as PanelLink
    const api = createPanelChannelApi(link)

    const rejected = (await api.sync
      .invoke({ kind: 'session', sessionId: 's1' }, null)
      .catch((e: unknown) => e)) as Error & { code?: string }
    expect(rejected).toBeInstanceOf(Error)
    expect(rejected.code).toBe('unsupported')

    const off = api.sync.onFrame(() => {})
    expect(typeof off).toBe('function')
    expect(() => off()).not.toThrow()
    expect(request).not.toHaveBeenCalled()
  })
})
