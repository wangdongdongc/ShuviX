/**
 * MM —— npm 依赖清单（仓库根 + 各 workspace 的 package.json）的迁移守卫。pi 1.0 / pi-durable
 * 迁移在清单上落下三条规矩，而 ESLint 管不到 package.json，只能在这里钉：
 *
 *   - `@earendil-works/pi-agent-core` 已整包移除（MM-2）。重新加回来**不会**报错：git worktree
 *     自己的 node_modules 里没有它，Node 沿目录往上找到**主检出**的 node_modules，静默解析到
 *     那份陈旧副本 —— 测试照样绿，跑的却是另一个检出里、旧版本的代码。
 *   - 裁定 Q18：apps/desktop 不再直接声明 `@google/genai`（MM-3）。pi-ai 1.0 自己传递带来 2.x，
 *     源码里没有任何地方 import 它，直接声明只会多出一份与传递依赖脱节的版本。
 *   - `pi-ai` / `pi-durable` / `chord` 必须**精确钉版**（MM-4），且各清单**同一版本**（MM-5）。
 *     pi-durable 还是 experimental，任何浮动范围都可能让下一次 install 悄悄换掉会话层；两个清单
 *     各钉一个版本则会并排装出两份，类型与运行时各认一份。
 *
 * 刻意**不管**包落在哪个依赖字段：apps/desktop 现在 pi-ai 在 `dependencies`，pi-durable / chord
 * 在 `devDependencies`（裁定 Q19 —— 它们由 electron-vite 打进 bundle，不能是 electron-builder
 * 会再拷进 asar 的生产依赖），agent-runtime 则三个都在 `dependencies`。字段归属是打包问题，这里
 * 只问「声明了什么、钉成什么」，四个依赖字段一视同仁。
 *
 * 清单从根 `workspaces` 的 glob 现场枚举，不抄路径表：新加的 workspace 自动纳入。枚举器只认
 * 「纯前缀 + 一个结尾斜杠星号」这一种形态，遇到别的 glob 直接抛错而不是静默少扫；MM-1 再保证
 * 扫描不是在空集上恒真（MM-2..MM-5 都是「违规清单为空」，空集上必然全绿）。只读，不写盘。
 */
import { describe, it, expect } from 'vitest'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
/** `…/apps/desktop/src/main/utils/__tests__` 往上六层 */
const REPO_ROOT = resolve(HERE, '../../../../../..')

/** 一视同仁的四个依赖字段（见头注：字段归属不归这里管） */
const FIELDS = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies'
] as const
type Field = (typeof FIELDS)[number]

type Manifest = { name?: string; workspaces?: unknown } & {
  [F in Field]?: Record<string, string>
}

interface ManifestEntry {
  /** 相对仓库根、`/` 分隔 */
  rel: string
  json: Manifest
}

interface Declaration {
  rel: string
  field: Field
  pkg: string
  version: string
}

/** 迁移中移除、任何清单都不得再声明的包 */
const REMOVED_EVERYWHERE = '@earendil-works/pi-agent-core'
/** 裁定 Q18：apps/desktop 不得再直接声明 */
const REMOVED_FROM_DESKTOP = '@google/genai'
/** 精确钉版、各清单同版本的三个包 */
const PINNED = [
  '@earendil-works/pi-ai',
  '@earendil-works/pi-durable',
  '@earendil-works/chord'
] as const

/** 精确版本：`x.y.z`，可带 prerelease / build 段；任何范围、通配、标签、协议前缀都不算 */
const EXACT = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/
/** 枚举器支持的唯一 glob 形态：纯前缀 + 一个结尾的斜杠星号 */
const SIMPLE_GLOB = /^[^*?{}[\]!]+\/\*$/

const toRel = (abs: string): string => relative(REPO_ROOT, abs).split(sep).join('/')

const readManifest = (abs: string): Manifest => JSON.parse(readFileSync(abs, 'utf8')) as Manifest

/** 根清单打头，再按根 `workspaces` 的每条 glob 收下面带 package.json 的子目录 */
function enumerateManifests(): ManifestEntry[] {
  const rootPath = join(REPO_ROOT, 'package.json')
  const root = readManifest(rootPath)
  const entries: ManifestEntry[] = [{ rel: toRel(rootPath), json: root }]
  const globs: unknown[] = Array.isArray(root.workspaces) ? root.workspaces : []
  for (const glob of globs) {
    if (typeof glob !== 'string' || !SIMPLE_GLOB.test(glob)) {
      throw new Error(
        `unsupported workspaces glob — extend the enumerator: ${JSON.stringify(glob)}`
      )
    }
    const prefix = glob.slice(0, -'/*'.length)
    const dirents = readdirSync(join(REPO_ROOT, prefix), { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .sort((a, b) => a.name.localeCompare(b.name))
    for (const d of dirents) {
      const manifestPath = join(REPO_ROOT, prefix, d.name, 'package.json')
      if (existsSync(manifestPath)) {
        entries.push({ rel: toRel(manifestPath), json: readManifest(manifestPath) })
      }
    }
  }
  return entries
}

const MANIFESTS = enumerateManifests()

/** `pkg` 在给定清单、任一依赖字段里的全部声明 */
function declarationsOf(pkg: string, manifests: ManifestEntry[] = MANIFESTS): Declaration[] {
  return manifests.flatMap(({ rel, json }) =>
    FIELDS.flatMap((field) => {
      const deps = json[field]
      return deps && Object.hasOwn(deps, pkg) ? [{ rel, field, pkg, version: deps[pkg] }] : []
    })
  )
}

const describeDecl = (d: Declaration): string => `${d.rel}:${d.field}:${d.pkg}@${d.version}`

describe('依赖清单 —— 迁移守卫', () => {
  it('MM-1 扫描不空转：根清单认得出、三份关键清单都在、三个钉版包至少各有一处声明', () => {
    const root = MANIFESTS[0]
    expect(root.rel).toBe('package.json')
    // 名字对得上才说明 REPO_ROOT 的六级 `..` 没算错
    expect(root.json.name).toBe('shuvix-workspace')
    expect(Array.isArray(root.json.workspaces)).toBe(true)
    expect((root.json.workspaces as unknown[]).length).toBeGreaterThan(0)

    const rels = MANIFESTS.map((m) => m.rel)
    expect(rels).toEqual(
      expect.arrayContaining([
        'package.json',
        'apps/desktop/package.json',
        'packages/agent-runtime/package.json',
        // P3-08-11：chat-ui 的视图同步客户端直接用 chord
        'packages/chat-ui/package.json'
      ])
    )
    expect(rels.length).toBeGreaterThanOrEqual(4)

    for (const pkg of PINNED) {
      expect(
        declarationsOf(pkg).length,
        `${pkg} 在 ${rels.join(', ')} 里一处声明都没有`
      ).toBeGreaterThan(0)
    }
  })

  it('MM-1b / P3-08-11 chat-ui 精确声明 `@earendil-works/chord` 1.0.2', () => {
    const chatUi = MANIFESTS.filter((m) => m.rel === 'packages/chat-ui/package.json')
    expect(chatUi).toHaveLength(1)
    expect(declarationsOf('@earendil-works/chord', chatUi).map((d) => d.version)).toEqual([
      '1.0.2'
    ])
  })

  it('MM-2 任何清单、任何依赖字段都不再声明 `@earendil-works/pi-agent-core`', () => {
    const offenders = declarationsOf(REMOVED_EVERYWHERE).map(describeDecl)
    expect(offenders).toEqual([])
  })

  it('MM-3 apps/desktop 不再直接声明 `@google/genai`（裁定 Q18，任何依赖字段）', () => {
    const desktop = MANIFESTS.filter((m) => m.rel === 'apps/desktop/package.json')
    expect(desktop).toHaveLength(1)
    const offenders = declarationsOf(REMOVED_FROM_DESKTOP, desktop).map(describeDecl)
    expect(offenders).toEqual([])
  })

  it('MM-4 pi-ai / pi-durable / chord 的每一处声明都是精确版本', () => {
    const offenders = PINNED.flatMap((pkg) => declarationsOf(pkg))
      .filter((d) => !EXACT.test(d.version))
      .map(describeDecl)
    expect(offenders).toEqual([])
  })

  it.each<[string, boolean]>([
    ['1.0.2', true],
    ['1.0.2-beta.1', true],
    ['^1.0.2', false],
    ['~1.0.2', false],
    ['>=1.0.2', false],
    ['1.0.x', false],
    ['1.x', false],
    ['*', false],
    ['latest', false],
    ['1.0', false],
    ['1.0.2 - 1.0.3', false],
    ['workspace:*', false],
    ['npm:@earendil-works/pi-ai@1.0.2', false]
  ])('MM-4b EXACT 判定 %j → %s', (version, accepted) => {
    expect(EXACT.test(version)).toBe(accepted)
  })

  it.each(PINNED)('MM-5 %s 在所有清单、所有字段里是同一个版本', (pkg) => {
    const decls = declarationsOf(pkg)
    const versions = new Set(decls.map((d) => d.version))
    const map = Object.fromEntries(decls.map((d) => [`${d.rel}:${d.field}`, d.version]))
    expect(versions.size, `${pkg} 各处版本不一致：${JSON.stringify(map, null, 2)}`).toBe(1)
  })
})
