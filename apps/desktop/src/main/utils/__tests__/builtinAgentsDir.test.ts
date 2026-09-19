/**
 * BAD —— `getBuiltinAgentsDir()` 的**目录算术**：内置档案 md 打包后在 `Resources/builtin-agents/`，
 * 未打包时指向仓库里 `packages/agent-runtime/src/subagent/builtinAgents/md`。
 *
 * 与 `services/__tests__/builtinAgentsResources.test.ts` 刻意分成两个被测对象：那边问「仓库里
 * 文件齐不齐」（真实目录、不经本函数），这边问「两条分支各指向哪里」。
 *
 * ⚠️ 未打包分支的 `__dirname` 基准是**构建产物** `out/main`，而 vitest 跑的是源码位置
 * （`src/main/utils`）—— 同一串 `../` 在两处落点不同，所以这里不能直接拿返回值去比仓库目录
 * （与 `builtinSkillsDir.test.ts` 记的是同一个坑）。BAD-1 因此把返回值**折回相对段**再按产线基准
 * （`out/main`）算一次：这样钉住的正是「几级 `..`」这个唯一会写错的东西，而且用的是函数自己
 * 吐出来的那串，不是测试里重抄的字面量。
 */
import { describe, it, expect, afterAll, beforeEach, vi } from 'vitest'
import { existsSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const mocks = vi.hoisted(() => ({ packaged: undefined as boolean | undefined }))

// `app` 在半桩的单测里可能整个不存在（paths.ts 的 `app?.` 就是为此而写）——
// packaged 为 undefined 时这里连 app 都不给，正好覆盖那一条
vi.mock('electron', () => ({
  get app(): { isPackaged: boolean } | undefined {
    return mocks.packaged === undefined ? undefined : { isPackaged: mocks.packaged }
  }
}))

import { getBuiltinAgentsDir } from '../paths'

const HERE = dirname(fileURLToPath(import.meta.url))
/** `…/apps/desktop/src/main/utils/__tests__` 往上六层 */
const REPO_ROOT = resolve(HERE, '../../../../../..')
/** 内置档案 md 的事实源（开发期就是它） */
const MD_DIR = join(REPO_ROOT, 'packages/agent-runtime/src/subagent/builtinAgents/md')
/** vitest 下 paths.ts 的 `__dirname` */
const SRC_BASE = join(REPO_ROOT, 'apps/desktop/src/main/utils')
/** 产线（electron-vite 构建产物）里 paths.ts 的 `__dirname` */
const OUT_BASE = join(REPO_ROOT, 'apps/desktop/out/main')

/** electron 的 process.resourcesPath 在 @types/node 里没有，赋值要绕过只读声明 */
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

describe('getBuiltinAgentsDir —— 两条分支', () => {
  it('BAD-1 未打包（半桩、连 app 都没有）：不炸，指向仓库里那个 md 目录（`work.md` 确在其中）', () => {
    // `app?.` 少一个问号就是 TypeError —— 文件工具的单测只桩半个 electron，这条路真会走到
    const dir = getBuiltinAgentsDir()
    expect(dir).not.toBe(join('/fake/Resources', 'builtin-agents'))

    // 把返回值折回「相对 __dirname 的那串」，再按产线基准（out/main）算一次：
    // 落点必须正是仓库里那个 md 目录。几级 `..` 写错会在这里现形
    const rel = relative(SRC_BASE, dir)
    expect(rel.startsWith('..'), `未打包分支不是相对 __dirname 的路径：${dir}`).toBe(true)
    expect(resolve(OUT_BASE, rel)).toBe(MD_DIR)
    expect(existsSync(join(MD_DIR, 'work.md')), `${MD_DIR} 里没有 work.md`).toBe(true)
  })

  it('BAD-2 打包：`<resourcesPath>/builtin-agents` —— 字面量与 electron-builder 的 `to` 同一个字符串', () => {
    // 这一段与 electron-builder.yml 的 `to: builtin-agents` 必须逐字相同（BA-4 从另一头钉它）：
    // 两边各改一个字，dev 全绿而打包后一个内置档案都读不出来
    mocks.packaged = true
    setResourcesPath('/Applications/ShuviX.app/Contents/Resources')
    expect(getBuiltinAgentsDir()).toBe('/Applications/ShuviX.app/Contents/Resources/builtin-agents')
    expect(getBuiltinAgentsDir()).toBe(
      join('/Applications/ShuviX.app/Contents/Resources', 'builtin-agents')
    )
  })

  it('BAD-2b 未打包不看 resourcesPath：app.isPackaged 为 false 与「没有 app」落在同一处', () => {
    mocks.packaged = undefined
    const noApp = getBuiltinAgentsDir()

    mocks.packaged = false
    setResourcesPath('/Applications/ShuviX.app/Contents/Resources')
    expect(getBuiltinAgentsDir()).toBe(noApp)
    expect(getBuiltinAgentsDir().startsWith('/Applications/')).toBe(false)
  })
})
