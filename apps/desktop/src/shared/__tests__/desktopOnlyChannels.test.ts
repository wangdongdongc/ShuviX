/**
 * `DESKTOP_ONLY_CHANNELS`（server mode phase B §B2）—— 只有桌面窗口能用的请求通道（开窗、系统文件管理器、原生对话框）：
 * 网络客户端调它们时服务端回 `desktop_only`、处理函数不执行。表与通道表的一致性在这里核对。
 * （与分发器的交叉核对 DO-5 放在 `main/frontend/network/__tests__/dispatch.test.ts`：shared 是叶子层，不引主进程。）
 *
 *   DO-1 每个键都是通道表里某个 invoke 成员的通道
 *   DO-2 没有一个键是 event / send 通道（表或 override 里），也不是 override 通道
 *   DO-3 每个值（原因）是非空字符串；共 20 条
 *   DO-4 network:status / setEnabled / setPort / setLan / setLanInterface 都不是桌面专属
 *   DO-6 `API_TABLE.network` 恰是五条 invoke（status 0 参、setEnabled / setPort / setLan / setLanInterface 各 1 参）
 *   DO-7 phase D 的三条新通道（fs:listDirectories / fs:locateFolder / widget:exportForDownload）是 1 参的 invoke，
 *        网络客户端能用（不是桌面专属）；桌面专属仍是 20 条
 */
import { describe, expect, it } from 'vitest'
import { API_OVERRIDE_CHANNELS, API_TABLE, DESKTOP_ONLY_CHANNELS } from '../apiTable'

function tableMembers(): Array<{ kind: string; channel: string }> {
  const members: Array<{ kind: string; channel: string }> = []
  for (const ns of Object.values(API_TABLE)) {
    for (const member of Object.values(ns)) members.push(member)
  }
  return members
}

function overrideMembers(): Array<{ kind: string; channel: string }> {
  const members: Array<{ kind: string; channel: string }> = []
  for (const ns of Object.values(API_OVERRIDE_CHANNELS)) {
    for (const member of Object.values(ns)) if (member !== null) members.push(member)
  }
  return members
}

const KEYS = Object.keys(DESKTOP_ONLY_CHANNELS)

describe('DO-1 每个键都是一条 invoke 通道', () => {
  it('DO-1 键 ⊂ 通道表 invoke 成员的通道', () => {
    const invokeChannels = new Set(
      tableMembers()
        .filter((m) => m.kind === 'invoke')
        .map((m) => m.channel)
    )
    for (const key of KEYS) expect(invokeChannels.has(key), key).toBe(true)
  })
})

describe('DO-2 不是 event / send / override 通道', () => {
  it('DO-2 没有一个键是 event / send 通道，也不是 override 通道', () => {
    const nonInvoke = new Set(
      [...tableMembers(), ...overrideMembers()]
        .filter((m) => m.kind !== 'invoke')
        .map((m) => m.channel)
    )
    const overrideChannels = new Set(overrideMembers().map((m) => m.channel))
    expect([...overrideChannels].sort()).toEqual(
      ['app:event', 'knowledge:baseOptions', 'liveDoc:respond', 'sync:frame'].sort()
    )
    for (const key of KEYS) {
      expect(nonInvoke.has(key), key).toBe(false)
      expect(overrideChannels.has(key), key).toBe(false)
    }
  })
})

describe('DO-3 原因与条数', () => {
  it('DO-3 每个原因是非空字符串；共 20 条', () => {
    expect(KEYS).toHaveLength(20)
    expect(new Set(KEYS).size).toBe(20)
    for (const key of KEYS) {
      const reason = DESKTOP_ONLY_CHANNELS[key]
      expect(typeof reason).toBe('string')
      expect(reason.trim().length, key).toBeGreaterThan(0)
    }
  })
})

describe('DO-4 网络设置的五条通道不是桌面专属', () => {
  it('DO-4 network:status / setEnabled / setPort / setLan / setLanInterface', () => {
    for (const channel of [
      'network:status',
      'network:setEnabled',
      'network:setPort',
      'network:setLan',
      'network:setLanInterface'
    ]) {
      expect(Object.hasOwn(DESKTOP_ONLY_CHANNELS, channel), channel).toBe(false)
    }
  })
})

describe('DO-6 API_TABLE.network', () => {
  it('DO-6 恰是五条 invoke', () => {
    expect(API_TABLE.network).toStrictEqual({
      status: { kind: 'invoke', channel: 'network:status', args: 0 },
      setEnabled: { kind: 'invoke', channel: 'network:setEnabled', args: 1 },
      setPort: { kind: 'invoke', channel: 'network:setPort', args: 1 },
      setLan: { kind: 'invoke', channel: 'network:setLan', args: 1 },
      setLanInterface: { kind: 'invoke', channel: 'network:setLanInterface', args: 1 }
    })
  })
})

describe('DO-7 phase D 的通道', () => {
  it('DO-7 三条新通道是 1 参的 invoke、不是桌面专属；桌面专属仍是 20 条', () => {
    expect(API_TABLE.fs).toStrictEqual({
      listDirectories: { kind: 'invoke', channel: 'fs:listDirectories', args: 1 },
      locateFolder: { kind: 'invoke', channel: 'fs:locateFolder', args: 1 }
    })
    expect(API_TABLE.widget.exportForDownload).toStrictEqual({
      kind: 'invoke',
      channel: 'widget:exportForDownload',
      args: 1
    })
    for (const channel of ['fs:listDirectories', 'fs:locateFolder', 'widget:exportForDownload']) {
      const entries = tableMembers().filter((m) => m.channel === channel)
      expect(entries, channel).toHaveLength(1)
      expect(entries[0].kind, channel).toBe('invoke')
      expect(Object.hasOwn(DESKTOP_ONLY_CHANNELS, channel), channel).toBe(false)
    }
    expect(KEYS).toHaveLength(20)
  })
})
