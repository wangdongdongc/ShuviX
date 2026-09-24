/**
 * SL —— `getSandboxLibsDir()`：交互图沙箱能加载的库（Chart.js / D3）的随包目录，以及那个目录
 * 本身随包发没发、里面的文件对不对得上 chat-protocol 的 SANDBOX_LIBS。
 *
 * `shuvix-lib://<name>` 协议按名字白名单从这里读（customProtocols.test.ts 钉协议那一侧）。这里钉
 * 另外三件「dev 全绿、打包后才坏」的事：两条分支各指向哪里、electron-builder 把目录带上了没有、
 * 表里每个名字对应的文件真在目录里（且去掉了 sourceMappingURL —— README 这么承诺：DevTools 会
 * 拿那行去向协议要一份永远不会给的 map）。
 *
 * ⚠️ 未打包分支的 `__dirname` 基准是**构建产物** `out/main`，而 vitest 跑的是源码位置
 * （`src/main/utils`）—— 同一串 `../` 在两处落点不同。SL-1 与 builtinAgentsDir.test.ts 同一个办法：
 * 把返回值**折回相对段**，再按产线基准（`out/main`）算一次。
 */
import { describe, it, expect, afterAll, beforeEach, vi } from 'vitest'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse as parseYaml } from 'yaml'
import { SANDBOX_LIBS } from '@shuvix/chat-protocol/utils/interactiveFence'

const mocks = vi.hoisted(() => ({ packaged: undefined as boolean | undefined }))

// `app` 在半桩的单测里可能整个不存在（paths.ts 的 `app?.` 就是为此而写）
vi.mock('electron', () => ({
  get app(): { isPackaged: boolean } | undefined {
    return mocks.packaged === undefined ? undefined : { isPackaged: mocks.packaged }
  }
}))

import { getSandboxLibsDir } from '../paths'

const HERE = dirname(fileURLToPath(import.meta.url))
/** `…/apps/desktop/src/main/utils/__tests__` 往上六层 */
const REPO_ROOT = resolve(HERE, '../../../../../..')
/** 随包库文件的事实源（开发期就是它） */
const LIBS_DIR = join(REPO_ROOT, 'apps/desktop/resources/sandbox-libs')
/** vitest 下 paths.ts 的 `__dirname` */
const SRC_BASE = join(REPO_ROOT, 'apps/desktop/src/main/utils')
/** 产线（electron-vite 构建产物）里 paths.ts 的 `__dirname` */
const OUT_BASE = join(REPO_ROOT, 'apps/desktop/out/main')

const setResourcesPath = (path: string): void => {
  ;(process as unknown as { resourcesPath: string }).resourcesPath = path
}
const ORIGINAL_RESOURCES_PATH = (process as unknown as { resourcesPath?: string }).resourcesPath

beforeEach(() => {
  mocks.packaged = undefined
  setResourcesPath('/fake/Resources')
})

afterAll(() => {
  if (ORIGINAL_RESOURCES_PATH === undefined) {
    delete (process as unknown as { resourcesPath?: string }).resourcesPath
  } else {
    setResourcesPath(ORIGINAL_RESOURCES_PATH)
  }
})

describe('getSandboxLibsDir —— 两条分支（SL-1）', () => {
  it('SL-1 打包：`<resourcesPath>/sandbox-libs`；未打包（连 app 都没有）：按产线基准折回正是 resources/sandbox-libs', () => {
    mocks.packaged = true
    setResourcesPath('/Applications/ShuviX.app/Contents/Resources')
    expect(getSandboxLibsDir()).toBe(
      join('/Applications/ShuviX.app/Contents/Resources', 'sandbox-libs')
    )

    mocks.packaged = undefined
    const dir = getSandboxLibsDir()
    expect(dir.startsWith('/Applications/')).toBe(false)
    const rel = relative(SRC_BASE, dir)
    expect(rel.startsWith('..'), `未打包分支不是相对 __dirname 的路径：${dir}`).toBe(true)
    expect(resolve(OUT_BASE, rel)).toBe(LIBS_DIR)
    // app.isPackaged 为 false 与「没有 app」落在同一处
    mocks.packaged = false
    expect(getSandboxLibsDir()).toBe(dir)
  })
})

describe('随包目录与白名单对得上（SL-2…4）', () => {
  it('SL-2 electron-builder 的 extraResources 带上了这个目录 → sandbox-libs（与打包分支同一个字面量）', () => {
    // 少这一条：dev 全绿，打包后每个 `shuvix-lib://` 请求都是 500
    const builder = parseYaml(
      readFileSync(join(REPO_ROOT, 'apps/desktop/electron-builder.yml'), 'utf-8')
    ) as { extraResources?: { from?: string; to?: string }[] }
    expect(builder.extraResources ?? []).toContainEqual({
      from: 'resources/sandbox-libs',
      to: 'sandbox-libs'
    })
    expect(statSync(LIBS_DIR).isDirectory()).toBe(true)
  })

  it('SL-3 表里每个库的文件都在目录里、非空、正文里提到它挂出来的全局名', () => {
    const entries = Object.entries(SANDBOX_LIBS)
    expect(entries.length).toBeGreaterThan(0)
    for (const [name, { file, global }] of entries) {
      const path = join(LIBS_DIR, file)
      expect(existsSync(path), `${name} → ${file} 不在 ${LIBS_DIR}`).toBe(true)
      const text = readFileSync(path, 'utf8')
      expect(text.length, file).toBeGreaterThan(1000)
      expect(text, `${file} 里找不到全局名 ${global}`).toContain(global)
    }
  })

  it('SL-4 库文件里没有 sourceMappingURL（README 的承诺：DevTools 不去向协议要 map）', () => {
    for (const { file } of Object.values(SANDBOX_LIBS)) {
      expect(readFileSync(join(LIBS_DIR, file), 'utf8'), file).not.toContain('sourceMappingURL')
    }
  })
})
