/**
 * BSD —— `getBuiltinSkillsDir()` 的**目录算术**：界面语言 → `skills/<lang>/`，以及整份回退。
 *
 * 与 `services/__tests__/builtinSkillsResources.test.ts` 刻意分成两个被测对象：那边问「仓库里
 * 文件齐不齐」（真实目录、不经本函数），这边问「给定一棵目录树，语言怎么选」（自建 fixture 根、
 * 不碰仓库里的资源）。谁都不碰对方的脆弱点 —— fixture 自建 ⇒「zh 存在 / fr 不存在」是用例
 * 自己造的事实，明天真加一种语言，这一组一条都不用改。
 *
 * 走**打包分支**（`app.isPackaged = true` + `process.resourcesPath`）：这两样能干净顶掉，而
 * 开发分支的 `__dirname` 不能 —— 它断言的是构建产物布局（`out/main/` 往上两级），任何让它在
 * 单测里通过的写法都是在测一个假布局，所以开发分支刻意不单测。
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const mocks = vi.hoisted(() => ({ language: undefined as string | undefined }))

vi.mock('electron', () => ({ app: { isPackaged: true } }))
vi.mock('i18next', () => ({
  default: {
    get language(): string | undefined {
      return mocks.language
    }
  }
}))

import { getBuiltinSkillsDir } from '../paths'

/** 自建的「打包后 Resources/」根：下面只放 skills/en、skills/zh、skills/ja 三个空目录 */
const FIXTURE_ROOT = mkdtempSync(join(tmpdir(), 'shuvix-builtin-skills-res-'))
const FIXTURE_LANGS = ['en', 'zh', 'ja']
for (const lang of FIXTURE_LANGS) mkdirSync(join(FIXTURE_ROOT, 'skills', lang), { recursive: true })

const HERE = dirname(fileURLToPath(import.meta.url))
/** `…/apps/desktop/src/main/utils/__tests__` 往上四层就是 apps/desktop */
const REAL_RESOURCES = resolve(HERE, '../../../../resources')

/** electron 的 process.resourcesPath 在 @types/node 里没有，赋值要绕过只读声明 */
const setResourcesPath = (path: string): void => {
  ;(process as unknown as { resourcesPath: string }).resourcesPath = path
}
const ORIGINAL_RESOURCES_PATH = (process as unknown as { resourcesPath?: string }).resourcesPath

beforeEach(() => {
  mocks.language = undefined
  setResourcesPath(FIXTURE_ROOT)
})

afterAll(() => {
  if (ORIGINAL_RESOURCES_PATH === undefined) {
    delete (process as unknown as { resourcesPath?: string }).resourcesPath
  } else {
    setResourcesPath(ORIGINAL_RESOURCES_PATH)
  }
  rmSync(FIXTURE_ROOT, { recursive: true, force: true })
})

describe('getBuiltinSkillsDir —— 语言选择', () => {
  it('BSD-1 界面语言的目录存在就用它：zh → skills/zh', () => {
    mocks.language = 'zh'
    expect(getBuiltinSkillsDir()).toBe(join(FIXTURE_ROOT, 'skills', 'zh'))
  })

  it('BSD-2 精确语言取基础语言段：zh-CN → skills/zh', () => {
    mocks.language = 'zh-CN'
    expect(getBuiltinSkillsDir()).toBe(join(FIXTURE_ROOT, 'skills', 'zh'))
  })

  it('BSD-3 大小写不敏感：ZH-CN → skills/zh', () => {
    mocks.language = 'ZH-CN'
    expect(getBuiltinSkillsDir()).toBe(join(FIXTURE_ROOT, 'skills', 'zh'))
  })

  it('BSD-4 没有对应目录 → **整份**回退到 en，不半路停在 skills/', () => {
    mocks.language = 'fr'
    expect(existsSync(join(FIXTURE_ROOT, 'skills', 'fr'))).toBe(false)
    expect(getBuiltinSkillsDir()).toBe(join(FIXTURE_ROOT, 'skills', 'en'))
    // 回退到 `skills/` 本身会让扫描把 en/zh/ja 三个语言目录当成三个技能（目录即技能），
    // 于是索引里出现三条叫 builtin:en / builtin:zh / builtin:ja 的东西。
    expect(getBuiltinSkillsDir()).not.toBe(join(FIXTURE_ROOT, 'skills'))
  })

  it.each([undefined, ''])('BSD-5 i18next.language 缺省（%j）→ en', (language) => {
    mocks.language = language
    expect(getBuiltinSkillsDir()).toBe(join(FIXTURE_ROOT, 'skills', 'en'))
  })

  it('BSD-6 记录当前行为：下划线形式 zh_CN 落到 en —— 中文用户会静默拿到英文', () => {
    // 分隔符只认 `-`（`split('-')[0]`），`zh_CN` 整段当语言名，没有那个目录 → 回退 en。
    // 今天 i18next 产出的是 BCP-47 的 `zh-CN`，所以这是理论路径；哪天它（或某个宿主）
    // 给出下划线形式，症状是「中文界面下内置技能全是英文」而没有任何报错。
    mocks.language = 'zh_CN'
    expect(getBuiltinSkillsDir()).toBe(join(FIXTURE_ROOT, 'skills', 'en'))
  })

  it('BSD-7 冒烟：指向仓库里真实的 resources/，en 目录里确有 drawing/SKILL.md', () => {
    // 上面六条都在自建 fixture 上做算术；这一条确认那套算术落到真实产物布局上也对得上
    // （`<resourcesPath>/skills/<lang>/<name>/SKILL.md` 这一层嵌套没写错）。
    setResourcesPath(REAL_RESOURCES)
    mocks.language = 'en'
    const dir = getBuiltinSkillsDir()
    expect(dir).toBe(join(REAL_RESOURCES, 'skills', 'en'))
    expect(existsSync(join(dir, 'drawing', 'SKILL.md'))).toBe(true)
  })
})
