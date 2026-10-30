/**
 * .git 不进搜索结果、也不进文件列举（真实 rg）—— 钉 `--glob=!.git` 的位置与形状。
 *
 * 不带斜杠的 `!.git` 按 gitignore 语义匹配**任意层级的基名**：根目录的 .git/、嵌套仓库（子模块）的
 * sub/.git/、工作树里那个 `.git` 文件都排除；而 `.gitignore` / `.github/` / `notes.git` / `repo.git/`
 * 这些只是名字像的，照常出现（不能过度排除）。旧代码两处都不对：内容搜索根本没排除（`--hidden` 下
 * .git 的对象库、日志都会被搜进来，吃掉结果上限），文件列举用的是带斜杠的 `!.git/*`，只锚定根目录那一个
 * —— sub/.git/config 和 wt/.git 照样列出来。
 *
 * 排除必须排在调用方 glob **之后**：rg 的 glob 后者优先，放在前面时 `*` / `**` / `.*` / `*.md` 这类
 * 白名单会把 .git 里的匹配文件重新捞回来（GR-9 / LS-2）。
 *
 * 覆盖每个列举入口：rgFilesList（文件面板、glob 工具）、直接迭代 rgFiles（技能工具）、hidden:false
 * （知识库扫描）。rg 二进制来自 @vscode/ripgrep；Windows 或二进制缺席时整组跳过。
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getRgPath, rgFiles, rgFilesList, rgSearch } from '../ripgrep'

const RG_AVAILABLE = process.platform !== 'win32' && existsSync(getRgPath())

let dir = ''

function write(rel: string, content: string): void {
  const p = join(dir, rel)
  mkdirSync(join(p, '..'), { recursive: true })
  writeFileSync(p, content)
}

/** 某条路径里有没有一段恰好叫 `.git`（`.gitignore` / `notes.git` 不算） */
const hasGitSegment = (p: string): boolean => p.split('/').includes('.git')

const sorted = (xs: string[]): string[] => [...xs].sort()

/** 命中的路径（去重排序） */
async function searchPaths(include?: string): Promise<string[]> {
  const { matches } = await rgSearch({ cwd: dir, pattern: 'needle', include })
  return sorted([...new Set(matches.map((m) => m.path))])
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'shuvix-rg-git-'))
})

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = ''
})

/**
 * GR-8 夹具：每个文件都含 needle。
 *   .git/HEAD、.git/objects/ab/cd     根仓库
 *   sub/.git/config                   嵌套仓库
 *   wt/.git                           工作树的 .git 文件（gitdir: needle）
 *   src/a.ts、.gitignore（注释行）、.gitattributes、.github/workflows/ci.yml、notes.git、repo.git/config
 *                                     名字像、但不是 .git —— 都该出现
 */
function seedSearchFixture(): void {
  write('.git/HEAD', 'needle\n')
  write('.git/objects/ab/cd', 'needle\n')
  write('sub/.git/config', 'needle\n')
  write('wt/.git', 'gitdir: needle\n')
  write('src/a.ts', 'needle\n')
  write('.gitignore', '# needle\n')
  write('.gitattributes', 'needle\n')
  write('.github/workflows/ci.yml', 'needle\n')
  write('notes.git', 'needle\n')
  write('repo.git/config', 'needle\n')
}

const NOT_GIT = [
  '.gitattributes',
  '.github/workflows/ci.yml',
  '.gitignore',
  'notes.git',
  'repo.git/config',
  'src/a.ts'
]

describe.skipIf(!RG_AVAILABLE)('rgSearch —— 不返回任何 .git 里的行（GR-8 / GR-9）', () => {
  it('GR-8 根 .git/、嵌套 sub/.git/、工作树的 .git 文件都不进结果；.gitignore / .github / notes.git / repo.git 照常', async () => {
    seedSearchFixture()

    const paths = await searchPaths()

    expect(paths).toEqual(NOT_GIT)
    expect(paths.filter(hasGitSegment)).toEqual([])
  })

  it("GR-9 带 include（'*' / '**' / '.*' / '.git*' / '**/.git/**' / '*.md'）：白名单捞不回 .git 里的文件", async () => {
    seedSearchFixture()
    write('.git/notes.md', 'needle\n')
    write('sub/.git/info/x.md', 'needle\n')
    write('docs/y.md', 'needle\n')

    for (const include of ['*', '**', '.*', '.git*', '**/.git/**', '*.md']) {
      const paths = await searchPaths(include)
      expect(paths.filter(hasGitSegment), include).toEqual([])
      expect(paths, include).not.toContain('wt/.git')
    }

    // 全收的白名单：就是 GR-8 那一份，外加 docs/y.md
    expect(await searchPaths('*')).toEqual(sorted([...NOT_GIT, 'docs/y.md']))
    expect(await searchPaths('**')).toEqual(sorted([...NOT_GIT, 'docs/y.md']))
    expect(await searchPaths('*.md')).toEqual(['docs/y.md'])
    // 专挑 .git 目录的白名单：一条都不回（是零命中，不是报错）
    expect(await searchPaths('**/.git/**')).toEqual([])
    // '.git*' 白名单的是基名以 .git 开头的**文件**：这个夹具里的 .gitattributes / .gitignore 本身含 needle，
    // 所以命中它俩 —— 而 .git/ 下的文件、wt/.git 都捞不回来（用例设计里写的「零命中」与这个夹具不符，按 rg 实际语义改）
    expect(await searchPaths('.git*')).toEqual(['.gitattributes', '.gitignore'])
    expect(await searchPaths('.*')).toEqual(['.gitattributes', '.gitignore'])
  })
})

/**
 * LS-1 夹具：
 *   .git/HEAD、.git/objects/x、sub/.git/config、wt/.git（文件）—— 都不该列出
 *   src/a.ts、.gitignore（空）、.github/ci.yml、notes.git —— 都该列出
 */
function seedListingFixture(): void {
  write('.git/HEAD', 'ref\n')
  write('.git/objects/x', 'x\n')
  write('sub/.git/config', 'x\n')
  write('wt/.git', 'gitdir: x\n')
  write('src/a.ts', 'x\n')
  write('.gitignore', '')
  write('.github/ci.yml', 'x\n')
  write('notes.git', 'x\n')
}

const LISTED = ['.github/ci.yml', '.gitignore', 'notes.git', 'src/a.ts']

describe.skipIf(!RG_AVAILABLE)(
  '文件列举 —— 不列任何 .git 目录里的东西、也不列 .git 文件（LS-1…3）',
  () => {
    it('LS-1 rgFilesList（hidden 缺省为 true）：恰好四个文件，没有 .git 段、没有 wt/.git', async () => {
      seedListingFixture()

      const { files, truncated } = await rgFilesList({ cwd: dir })

      expect(sorted(files)).toEqual(LISTED)
      expect(truncated).toBe(false)
      expect(files.filter(hasGitSegment)).toEqual([])
      expect(files).not.toContain('wt/.git')
    })

    it("LS-2 调用方 glob 在前、排除在后且胜出：['*.md'] / ['**/.git/**'] / ['.*'] / ['.git']", async () => {
      seedListingFixture()
      write('.git/n.md', 'x\n')
      write('sub/.git/info/x.md', 'x\n')
      write('docs/y.md', 'x\n')

      const list = async (glob: string[]): Promise<string[]> =>
        sorted((await rgFilesList({ cwd: dir, glob })).files)

      expect(await list(['*.md'])).toEqual(['docs/y.md'])
      expect(await list(['**/.git/**'])).toEqual([])
      const dot = await list(['.*'])
      expect(dot).not.toContain('wt/.git')
      expect(dot.filter(hasGitSegment)).toEqual([])
      expect(await list(['.git'])).toEqual([])
    })

    it('LS-3 直接迭代 rgFiles（技能工具的走法）与 hidden:false（知识库扫描的走法）同样排除；基名 !.git 不误伤 notes.git', async () => {
      seedListingFixture()

      const iterated: string[] = []
      for await (const file of rgFiles({ cwd: dir, hidden: true })) iterated.push(file)
      expect(sorted(iterated)).toEqual(LISTED)

      const visible = await rgFilesList({ cwd: dir, hidden: false })
      expect(sorted(visible.files)).toEqual(['notes.git', 'src/a.ts'])
    })
  }
)
