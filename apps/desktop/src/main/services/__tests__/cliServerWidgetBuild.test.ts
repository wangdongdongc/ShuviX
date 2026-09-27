/**
 * cliServer `widget.build`（HG-3）—— **先校验 id，再授权**。
 *
 * 授权（sessionService.addAllowListPaths）是持久写进会话 allowList 的，而 id 原样拼进路径：
 * `../../etc` 这类 id 若先授权后校验，会话就凭空多出一个任意目录的读写授权（命令沙箱还会把写授权
 * 当成可写根）—— widgetService.build 自己的校验在授权之后才跑，挡不住这一步。
 *
 * handler 从私有的 `handlers` 表里取（构造时注册，不用 start 起 socket）。`widgetService.validateId`
 * 保持真实（真正的 id 规则：kebab-case 且至少一个短横）；getWidgetDir 是透传 spy，build 是假的。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { join } from 'path'

const WIDGETS_DIR = '/nonexistent/shuvix-unit/widgets'

const mocks = vi.hoisted(() => ({
  addAllowListPaths: vi.fn<(sessionId: string, mode: 'read' | 'write', paths: string[]) => void>()
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
vi.mock('../widget/widgetRepo', () => ({ ensureRepo: vi.fn(), commitHostChange: vi.fn() }))
vi.mock('../../utils/paths', () => ({ getWidgetsDir: () => WIDGETS_DIR }))
vi.mock('../widgetWindowService', () => ({ open: vi.fn() }))
vi.mock('../sessionService', () => ({
  sessionService: { addAllowListPaths: mocks.addAllowListPaths }
}))
vi.mock('../toolContext', () => ({
  resolveProjectConfig: vi.fn(),
  isPathWithinWorkspace: vi.fn()
}))
vi.mock('../../logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} })
}))

import { cliServer } from '../cliServer'
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
  mocks.addAllowListPaths.mockReset()
  dirSpy = vi.spyOn(widgetService, 'getWidgetDir')
  buildSpy = vi.spyOn(widgetService, 'build').mockResolvedValue(BUILD_RESULT)
})

describe('HG-3 widget.build —— 先校验 id，再授权', () => {
  it.each(['../../etc', 'foo', 'Foo_Bar'])(
    'HG-3 非法 id %j → 以 Invalid widget id 拒绝，不授权、不构建',
    async (id) => {
      await expect(buildHandler()({ id }, 'sess-1')).rejects.toThrow('Invalid widget id')
      // 授权是持久的：拒绝之前一条都不能落进会话 allowList
      expect(mocks.addAllowListPaths).not.toHaveBeenCalled()
      expect(buildSpy).not.toHaveBeenCalled()
    }
  )

  it('HG-3 合法 id + sessionId → 对 getWidgetDir(id) 先授读、再授写，然后构建并返回构建结果', async () => {
    const dir = join(WIDGETS_DIR, 'json-formatter')

    await expect(buildHandler()({ id: 'json-formatter' }, 'sess-1')).resolves.toEqual(BUILD_RESULT)

    expect(dirSpy).toHaveBeenCalledWith('json-formatter')
    expect(mocks.addAllowListPaths.mock.calls).toEqual([
      ['sess-1', 'read', [dir]],
      ['sess-1', 'write', [dir]]
    ])
    expect(buildSpy.mock.calls).toEqual([['json-formatter']])
    // 授权在构建之前：构建本身（以及之后 agent 改源码）要用到这两条授权
    const lastGrant = Math.max(...mocks.addAllowListPaths.mock.invocationCallOrder)
    expect(lastGrant).toBeLessThan(buildSpy.mock.invocationCallOrder[0])
  })

  it('HG-3 合法 id、没有 sessionId（CLI 不在会话里调）→ 不授权，照样构建', async () => {
    await expect(buildHandler()({ id: 'json-formatter' }, undefined)).resolves.toEqual(BUILD_RESULT)

    expect(mocks.addAllowListPaths).not.toHaveBeenCalled()
    expect(buildSpy.mock.calls).toEqual([['json-formatter']])
  })
})
