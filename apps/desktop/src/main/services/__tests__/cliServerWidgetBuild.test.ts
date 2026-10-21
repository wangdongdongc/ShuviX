/**
 * cliServer `widget.build`（HG-3 / HG-4）—— **先校验 id，再授权**；`message` 只有是字符串才转给构建。
 *
 * 授权（sessionAcl.grantPath，来源 widget）是持久写进会话权限表的，而 id 原样拼进路径：
 * `../../etc` 这类 id 若先授权后校验，会话就凭空多出一个任意目录的读写授权（命令沙箱还会把写授权
 * 当成可写根）—— widgetService.build 自己的校验在授权之后才跑，挡不住这一步。
 *
 * handler 从私有的 `handlers` 表里取（构造时注册，不用 start 起 socket）。`widgetService.validateId`
 * 保持真实（真正的 id 规则：kebab-case 且至少一个短横）；getWidgetDir 是透传 spy，build 是假的。
 *
 *   HG-3  非法 id 拒绝在授权与构建之前；合法 id 先授写（含读，来源 widget、来源键 = id）再构建
 *         （不带 message → `{ message: undefined }`）
 *   HG-4a 字符串 message 原样转给 build；handler 的结果就是 build 的返回（含 commit）
 *   HG-4b 不是字符串的 message（数字 / null / 对象）→ `{ message: undefined }`
 *   HG-4c 空字符串 message 原样转（缺省说明由 widgetService 自己补）
 *   HG-4d 非法 id 带着 message 照样在授权与构建之前被拒
 *   HG-5  结果在 build 的返回之外多一个 `token`：这个 widget 的 cli 范围令牌（智能体在 shell 里 curl db/ 用；
 *         读不了 fs/，见 widget/widgetToken.ts）—— 有没有会话都给；`widget.init` 同样
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { join } from 'path'

const WIDGETS_DIR = '/nonexistent/shuvix-unit/widgets'

const mocks = vi.hoisted(() => ({
  grantPath:
    vi.fn<
      (
        sessionId: string,
        path: string,
        access: 'read' | 'write',
        opts?: { source?: string; sourceKey?: string }
      ) => unknown
    >()
}))

// widget 模块：只要真实的 widgetService（validateId / getWidgetDir），其余出口给空壳
vi.mock('../widget', async () => {
  const { widgetService } =
    await vi.importActual<typeof import('../widget/widgetService')>('../widget/widgetService')
  return {
    widgetService,
    exportWidget: vi.fn(),
    resolveExportZipPath: vi.fn(),
    WidgetExportError: class WidgetExportError extends Error {},
    runWidgetDbQuery: vi.fn()
  }
})
// widgetService 的重依赖：打包服务 / pglite / git —— 本文件一个都不碰
vi.mock('../widget/widgetServer', () => ({ widgetServer: {} }))
vi.mock('../widget/widgetDb', () => ({
  applyWidgetSchema: vi.fn(),
  dropWidgetSchema: vi.fn(),
  WidgetDbError: class WidgetDbError extends Error {}
}))
vi.mock('../widget/widgetRepo', () => ({
  ensureRepo: vi.fn(),
  commitHostChange: vi.fn(),
  commitBuild: vi.fn(),
  defaultBuildMessage: (id: string) => `chore(${id}): build`
}))
vi.mock('../../utils/paths', () => ({ getWidgetsDir: () => WIDGETS_DIR }))
vi.mock('../widgetWindowService', () => ({ open: vi.fn() }))
vi.mock('../acl', () => ({ sessionAcl: { grantPath: mocks.grantPath } }))
vi.mock('../toolContext', () => ({ getDesktopSecurityContext: vi.fn() }))
vi.mock('../../logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} })
}))

import { cliServer } from '../cliServer'
import { widgetTokenScope } from '../widget/widgetToken'
import { widgetService } from '../widget'

type Handler = (params: Record<string, unknown>, sessionId: string | undefined) => Promise<unknown>

const buildHandler = (): Handler => {
  const handler = (cliServer as unknown as { handlers: Map<string, Handler> }).handlers.get(
    'widget.build'
  )
  if (!handler) throw new Error('widget.build handler is not registered')
  return handler
}

const BUILD_RESULT = {
  id: 'json-formatter',
  url: 'http://127.0.0.1:1/w/json-formatter/',
  buildSuccess: true
}

let buildSpy: ReturnType<typeof vi.spyOn>
let dirSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  vi.restoreAllMocks()
  mocks.grantPath.mockReset()
  dirSpy = vi.spyOn(widgetService, 'getWidgetDir')
  buildSpy = vi.spyOn(widgetService, 'build').mockResolvedValue(BUILD_RESULT)
})

describe('HG-3 widget.build —— 先校验 id，再授权', () => {
  it.each(['../../etc', 'foo', 'Foo_Bar'])(
    'HG-3 非法 id %j → 以 Invalid widget id 拒绝，不授权、不构建',
    async (id) => {
      await expect(buildHandler()({ id }, 'sess-1')).rejects.toThrow('Invalid widget id')
      // 授权是持久的：拒绝之前一条都不能落进会话权限表
      expect(mocks.grantPath).not.toHaveBeenCalled()
      expect(buildSpy).not.toHaveBeenCalled()
    }
  )

  it('HG-3 合法 id + sessionId → 对 getWidgetDir(id) 授写（含读），然后构建并返回构建结果', async () => {
    const dir = join(WIDGETS_DIR, 'json-formatter')

    await expect(buildHandler()({ id: 'json-formatter' }, 'sess-1')).resolves.toMatchObject(
      BUILD_RESULT
    )

    expect(dirSpy).toHaveBeenCalledWith('json-formatter')
    expect(mocks.grantPath.mock.calls).toEqual([
      ['sess-1', dir, 'write', { source: 'widget', sourceKey: 'json-formatter' }]
    ])
    expect(buildSpy.mock.calls).toEqual([['json-formatter', { message: undefined }]])
    // 授权在构建之前：构建本身（以及之后 agent 改源码）要用到这条授权
    expect(mocks.grantPath.mock.invocationCallOrder[0]).toBeLessThan(
      buildSpy.mock.invocationCallOrder[0]
    )
  })

  it('HG-3 合法 id、没有 sessionId（CLI 不在会话里调）→ 不授权，照样构建', async () => {
    await expect(buildHandler()({ id: 'json-formatter' }, undefined)).resolves.toMatchObject(
      BUILD_RESULT
    )

    expect(mocks.grantPath).not.toHaveBeenCalled()
    expect(buildSpy.mock.calls).toEqual([['json-formatter', { message: undefined }]])
  })
})

describe('HG-4 widget.build 的 message', () => {
  it('HG-4a 字符串 message 原样转给 build；结果就是 build 的返回（含 commit）', async () => {
    const withCommit = { ...BUILD_RESULT, commit: 'abc1234' }
    buildSpy.mockResolvedValue(withCommit)

    const out = await buildHandler()({ id: 'json-formatter', message: 'feat: x' }, 'sess-1')

    expect(out).toMatchObject({ ...BUILD_RESULT, commit: 'abc1234' })
    expect(buildSpy.mock.calls).toEqual([['json-formatter', { message: 'feat: x' }]])
  })

  it.each([42, null, { a: 1 }])(
    'HG-4b message %j 不是字符串 → { message: undefined }',
    async (m) => {
      await buildHandler()({ id: 'json-formatter', message: m }, 'sess-1')
      expect(buildSpy.mock.calls).toEqual([['json-formatter', { message: undefined }]])
    }
  )

  it("HG-4c message '' 原样转", async () => {
    await buildHandler()({ id: 'json-formatter', message: '' }, 'sess-1')
    expect(buildSpy.mock.calls).toEqual([['json-formatter', { message: '' }]])
  })

  it('HG-4d 非法 id 带 message → 照样在授权与构建之前拒绝', async () => {
    await expect(buildHandler()({ id: '../../etc', message: 'feat: x' }, 'sess-1')).rejects.toThrow(
      'Invalid widget id'
    )
    expect(mocks.grantPath).not.toHaveBeenCalled()
    expect(buildSpy).not.toHaveBeenCalled()
  })
})

describe('HG-5 结果带 cli 令牌', () => {
  it('HG-5 build 的返回之外多一个 token：这个 widget 的 cli 范围；有没有会话都给', async () => {
    for (const sid of ['sess-1', undefined]) {
      const out = (await buildHandler()({ id: 'json-formatter' }, sid)) as Record<string, unknown>
      expect(out).toMatchObject(BUILD_RESULT)
      expect(widgetTokenScope(out.token as string, 'json-formatter')).toBe('cli')
      expect(widgetTokenScope(out.token as string, 'other-widget')).toBeNull()
    }
  })

  it('HG-5 widget.init 同样多一个 cli 令牌', async () => {
    const INIT = { id: 'json-formatter', projectDir: '/x', url: 'u', files: [], buildSuccess: true }
    const initSpy = vi.spyOn(widgetService, 'init').mockResolvedValue(INIT as never)
    const init = (cliServer as unknown as { handlers: Map<string, Handler> }).handlers.get(
      'widget.init'
    )!
    const out = (await init({ id: 'json-formatter', name: 'JSON' }, undefined)) as Record<
      string,
      unknown
    >
    expect(initSpy).toHaveBeenCalled()
    expect(out).toMatchObject(INIT)
    expect(widgetTokenScope(out.token as string, 'json-formatter')).toBe('cli')
  })
})
