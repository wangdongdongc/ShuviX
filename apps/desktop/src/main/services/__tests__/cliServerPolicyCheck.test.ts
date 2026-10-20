/**
 * cliServer `policy.check` —— `shuvix policy check` 在主进程那一头（判定本身在 policyCheck.ts，这里是 spy）：
 *
 *   CPC-1 没注入宿主依赖 → 拒绝（主入口经 setPolicyCheckDeps 注入）
 *   CPC-2 入参整形：文件只收 {path, text} 两个字符串；参数只收字符串对，别的丢掉；依赖现取、原样交下去
 *   CPC-3 回包就是 runPolicyCheck 的 {stdout, stderr, exitCode}（CLI 照 db-query 那样打印、按退出码退出）
 *
 * handler 从私有的 `handlers` 表里取（构造时注册，不用 start 起 socket）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PolicyCheckDeps, PolicyCheckParams, PolicyCheckResult } from '../policyCheck'

const mocks = vi.hoisted(() => ({
  runPolicyCheck: vi.fn<(params: PolicyCheckParams, deps: PolicyCheckDeps) => PolicyCheckResult>()
}))

vi.mock('../policyCheck', () => ({ runPolicyCheck: mocks.runPolicyCheck }))
vi.mock('../bgTaskService', () => ({ stopBgTaskByAgent: vi.fn() }))
vi.mock('../widget', () => ({
  widgetService: {},
  exportWidget: vi.fn(),
  resolveExportZipPath: vi.fn(),
  WidgetExportError: class WidgetExportError extends Error {},
  runWidgetDbQuery: vi.fn()
}))
vi.mock('../widgetWindowService', () => ({ open: vi.fn() }))
vi.mock('../acl', () => ({ sessionAcl: { grantPath: vi.fn() } }))
vi.mock('../toolContext', () => ({ getDesktopSecurityContext: vi.fn() }))
vi.mock('../../logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} })
}))

import { cliServer } from '../cliServer'

type Handler = (params: Record<string, unknown>, sessionId: string | undefined) => Promise<unknown>

const checkHandler = (): Handler => {
  const handler = (cliServer as unknown as { handlers: Map<string, Handler> }).handlers.get(
    'policy.check'
  )
  if (!handler) throw new Error('policy.check handler is not registered')
  return handler
}

const DEPS = { policiesDir: '/p' } as unknown as PolicyCheckDeps

afterEach(() => {
  cliServer.setPolicyCheckDeps(null)
  mocks.runPolicyCheck.mockReset()
})

describe('cliServer policy.check', () => {
  it('CPC-1 without host deps it refuses', async () => {
    await expect(checkHandler()({ flags: [] }, 's1')).rejects.toThrow(
      'policy check is not available in this ShuviX'
    )
    expect(mocks.runPolicyCheck).not.toHaveBeenCalled()
  })

  it('CPC-2 shapes the input: file only as two strings, flags only as string pairs; deps read per call', async () => {
    const factory = vi.fn(() => DEPS)
    cliServer.setPolicyCheckDeps(factory)
    mocks.runPolicyCheck.mockReturnValue({ stdout: 'ok\n', stderr: '', exitCode: 0 })

    await checkHandler()(
      {
        file: { path: '/w/network-admission.md', text: 'TEXT', extra: 1 },
        flags: [['from', '1.2.3.4'], ['expect'], 'device', [1, 2], ['channel', 'session:list']]
      },
      's1'
    )
    expect(mocks.runPolicyCheck).toHaveBeenCalledWith(
      {
        file: { path: '/w/network-admission.md', text: 'TEXT' },
        flags: [
          ['from', '1.2.3.4'],
          ['channel', 'session:list']
        ]
      },
      DEPS
    )

    await checkHandler()({ file: { path: 3, text: 'x' }, flags: 'nope' }, 's1')
    expect(mocks.runPolicyCheck).toHaveBeenLastCalledWith({ flags: [] }, DEPS)
    expect(factory).toHaveBeenCalledTimes(2)
  })

  it('CPC-3 the reply is the check result as is', async () => {
    cliServer.setPolicyCheckDeps(() => DEPS)
    const result: PolicyCheckResult = { stdout: 'Result: deny\n', stderr: '', exitCode: 1 }
    mocks.runPolicyCheck.mockReturnValue(result)
    await expect(checkHandler()({ flags: [['from', '1.2.3.4']] }, undefined)).resolves.toEqual(
      result
    )
  })
})
