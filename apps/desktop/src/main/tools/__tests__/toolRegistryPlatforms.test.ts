/**
 * 平台特定的内置工具 —— `bash` 只在 macOS / Linux、`powershell` 只在 Windows 解析给 agent，
 * 而设置页恒列出全部工具（带平台标签）。钉四件事：
 *
 *  - A1 `isToolOnPlatform` 的真值表：不声明平台 = 全平台；缺省参数在**调用时**读 process.platform；
 *  - A2 用**真的** bash / powershell 注册项：`getPlatformBuiltinToolEntries` 按当前平台二选一，
 *    `getBuiltinToolEntries` 两个都在（设置页、呈现表读它）；
 *  - A3 两个注册项的元数据：平台常量与 shell.ts 同一份、powershell 的终端形态与代码着色；
 *  - A4 设置页的定义枚举（`getBuiltinToolDefinitions`）在任何平台上都给两个工具，`platforms`
 *    原样带过去；没声明平台的工具不带这个键。
 *
 * 注册表是真的（工具模块在加载时自注册），只顶掉让工具模块加载得起来的外围：electron（bgTaskService
 * → utils/paths）、toolContext（会拖进 SQLite）、i18n。`getPowerShellConfig` 桩成固定值 —— 在非
 * Windows 主机上 stub 成 win32 时，真函数会去 spawn `where`。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/shuvix-registry-test', isPackaged: false }
}))
vi.mock('../../services/toolContext', () => ({
  resolveProjectConfig: () => ({ workingDirectory: '/w', envVars: {} }),
  getDesktopSecurityContext: () => ({ enforceCommand: async () => ({ status: 'allowed' }) }),
  TOOL_ABORTED: 'Aborted'
}))
vi.mock('../../i18n', () => ({ t: (key: string) => key }))
vi.mock('../../utils/toolUtils/shell', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../utils/toolUtils/shell')>()
  return {
    ...actual,
    getPowerShellConfig: () => ({ exe: 'C:\\pwsh.exe', edition: 'pwsh' as const })
  }
})

import {
  getBuiltinToolEntries,
  getBuiltinToolPresentations,
  getPlatformBuiltinToolEntries,
  isToolOnPlatform,
  registerBuiltinTool,
  unregisterBuiltinTool,
  type BuiltinToolMeta
} from '../../services/toolRegistry'
import { getBuiltinToolDefinitions } from '../../services/agentToolBuilder'
import { BASH_PLATFORMS, POWERSHELL_PLATFORMS } from '../../utils/toolUtils/shell'
import '../bash'
import '../powershell'

/** 原始描述符 —— 还原时连 writable/enumerable 一起还原，不给同 worker 的后续文件留下痕迹 */
const REAL_PLATFORM_DESC = Object.getOwnPropertyDescriptor(process, 'platform')!

function setPlatform(platform: string): void {
  Object.defineProperty(process, 'platform', { ...REAL_PLATFORM_DESC, value: platform })
}

afterEach(() => {
  Object.defineProperty(process, 'platform', REAL_PLATFORM_DESC)
})

const namesOf = (entries: readonly { name: string }[]): string[] => entries.map((e) => e.name)
const entryOf = (name: string): BuiltinToolMeta => {
  const entry = getBuiltinToolEntries().find((e) => e.name === name)
  expect(entry, `注册表里应有 ${name}`).toBeDefined()
  return entry!
}

describe('isToolOnPlatform —— 真值表', () => {
  it('A1 — 不声明平台 = 全平台；声明了就只在所列平台上；缺省参数在调用时读 process.platform', () => {
    // 不声明：包括 ShuviX 不发布的平台（freebsd）在内都算有
    for (const platform of ['darwin', 'linux', 'win32', 'freebsd']) {
      expect(isToolOnPlatform({}, platform), platform).toBe(true)
    }

    const win: Pick<BuiltinToolMeta, 'platforms'> = { platforms: ['win32'] }
    expect(isToolOnPlatform(win, 'win32')).toBe(true)
    expect(isToolOnPlatform(win, 'darwin')).toBe(false)
    expect(isToolOnPlatform(win, 'linux')).toBe(false)

    const posix: Pick<BuiltinToolMeta, 'platforms'> = { platforms: ['darwin', 'linux'] }
    expect(isToolOnPlatform(posix, 'win32')).toBe(false)
    expect(isToolOnPlatform(posix, 'darwin')).toBe(true)
    expect(isToolOnPlatform(posix, 'linux')).toBe(true)

    // 缺省参数：模块早已加载，这里才改平台 —— 读的必须是调用时的值
    setPlatform('win32')
    expect(isToolOnPlatform(win)).toBe(true)
    expect(isToolOnPlatform(posix)).toBe(false)
    setPlatform('linux')
    expect(isToolOnPlatform(win)).toBe(false)
    expect(isToolOnPlatform(posix)).toBe(true)
    expect(isToolOnPlatform({})).toBe(true)
  })
})

describe('按平台过滤的视图 vs 全量视图（真实注册项）', () => {
  it.each(['darwin', 'linux'])(
    'A2 — %s：平台视图里有 bash 没有 powershell；全量视图两个都在',
    (platform) => {
      setPlatform(platform)
      const onPlatform = namesOf(getPlatformBuiltinToolEntries())
      expect(onPlatform).toContain('bash')
      expect(onPlatform).not.toContain('powershell')
      const all = namesOf(getBuiltinToolEntries())
      expect(all).toContain('bash')
      expect(all).toContain('powershell')
    }
  )

  it('A2 — win32：反过来，平台视图里有 powershell 没有 bash；全量视图两个都在', () => {
    setPlatform('win32')
    const onPlatform = namesOf(getPlatformBuiltinToolEntries())
    expect(onPlatform).toContain('powershell')
    expect(onPlatform).not.toContain('bash')
    const all = namesOf(getBuiltinToolEntries())
    expect(all).toContain('bash')
    expect(all).toContain('powershell')
  })

  it('A2 — 平台视图只滤掉声明了别的平台的项：没声明平台的工具在每个平台上都在', () => {
    const stub: BuiltinToolMeta = {
      name: 'registry-test-anywhere',
      group: 'general',
      getLabel: () => 'x',
      getHint: () => 'x'
    }
    registerBuiltinTool(stub)
    try {
      for (const platform of ['darwin', 'linux', 'win32']) {
        setPlatform(platform)
        expect(namesOf(getPlatformBuiltinToolEntries()), platform).toContain(stub.name)
      }
    } finally {
      unregisterBuiltinTool(stub.name)
    }
  })

  it('A2 — 呈现表读全量：darwin 上也有 powershell（历史会话 / 另一台机器上的记录照样能渲染）', () => {
    setPlatform('darwin')
    const presentations = getBuiltinToolPresentations()
    expect(presentations.powershell).toBeDefined()
    expect(presentations.powershell.detailView).toBe('terminal')
    expect(presentations.bash).toBeDefined()
  })
})

describe('注册项元数据', () => {
  it('A3 — bash 的 platforms 就是 shell.ts 的 BASH_PLATFORMS（macOS / Linux）', () => {
    expect(entryOf('bash').platforms).toEqual(BASH_PLATFORMS)
    expect([...BASH_PLATFORMS]).toEqual(['darwin', 'linux'])
  })

  it('A3 — powershell：只在 win32、general 分组、终端形态详情，command 按 PowerShell 着色', () => {
    const ps = entryOf('powershell')
    expect(ps.platforms).toEqual(['win32'])
    expect(ps.platforms).toEqual(POWERSHELL_PLATFORMS)
    expect(ps.group).toBe('general')
    expect(ps.factory).toBeTypeOf('function')
    expect(ps.describe).toBeTypeOf('function')
    expect(ps.presentation?.detailView).toBe('terminal')
    const command = ps.presentation?.formItems?.find((item) => item.field === 'command')
    expect(command, 'formItems 里应有 command').toBeDefined()
    expect(command!.renderer).toMatchObject({ type: 'code', language: 'powershell' })
  })
})

describe('设置页的定义枚举（getBuiltinToolDefinitions）', () => {
  /** 一个没声明平台、但声明了 describe 的工具 —— 设置页会列出它 */
  const PLAIN: BuiltinToolMeta = {
    name: 'registry-test-plain',
    group: 'general',
    getLabel: () => 'Plain',
    getHint: () => 'plain',
    describe: () => ({
      description: 'plain tool',
      parameters: { type: 'object', properties: {} } as never
    })
  }

  it.each(['darwin', 'win32'])(
    'A4 — %s：两个命令工具都在、platforms 原样带过去；没声明平台的工具没有 platforms 键；描述就是 describe() 给的',
    (platform) => {
      setPlatform(platform)
      registerBuiltinTool(PLAIN)
      try {
        const defs = getBuiltinToolDefinitions()
        const byName = new Map(defs.map((d) => [d.name, d]))

        const bash = byName.get('bash')
        const ps = byName.get('powershell')
        expect(bash, 'bash 应在设置页上').toBeDefined()
        expect(ps, 'powershell 应在设置页上').toBeDefined()
        expect(bash!.platforms).toEqual(['darwin', 'linux'])
        expect(ps!.platforms).toEqual(['win32'])
        // 拷贝，不是把注册项上那个只读数组原样递出去
        expect(bash!.platforms).not.toBe(entryOf('bash').platforms)

        const plain = byName.get(PLAIN.name)
        expect(plain).toBeDefined()
        expect('platforms' in plain!).toBe(false)

        // 与 agent 实际发给 LLM 的是同一份描述（平台与版本相关的那几句也一样）
        expect(bash!.description).toBe(entryOf('bash').describe!().description)
        expect(ps!.description).toBe(entryOf('powershell').describe!().description)
      } finally {
        unregisterBuiltinTool(PLAIN.name)
      }
    }
  )
})
