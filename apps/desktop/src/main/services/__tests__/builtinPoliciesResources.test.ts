/**
 * BPR —— 内置**安全策略**的资源约定：随应用发布、运行时现读的那批 md
 * （`packages/agent-runtime/src/security/builtinPolicies/md/<name>[.<lang>].md`，
 * 一个策略一语言一文件）。写法与定位照 builtinAgentsResources.test.ts（BA 系列）：
 *
 *   - 读的是**仓库里的真实目录**，路径从 `import.meta.url` 往上找仓库根 —— 刻意**不经**
 *     `getBuiltinPoliciesDir()`。这一组问的是「仓库里文件齐不齐」，与 electron、与打包分支无关；
 *     目录算术单独在 `utils/__tests__/builtinPoliciesDir.test.ts` 里钉。
 *   - **只读，一个字节都不写盘**：这就是产品源码本身。
 *
 * 为什么这一组最要紧：改制**前**每个 spec 的 `sources` 是显式 `?raw` import，删掉
 * `ask-on-write.ja.md` 是一个编译错误；改制**后**是运行时按文件名查表，读不到就按语言回退 ——
 * 运行时守护（builtinPolicies.test.ts）的 sourcesOf() 只把「读得到的语言」放进表，漏一份文件
 * 那边照样全绿，症状只是日语用户静默拿到英文。缺文件必须在这里、且只能在这里现形。
 *
 * 与 BA 不同的一条额外 stakes：策略是**安全门**。打包漏掉整个目录时 dev 全绿而产品里
 * 一道内置门都没有（无策略 = 放行）—— BPR-4 钉打包配置，buildBuiltinPolicies 的 throw
 * （en 文件缺失即开发期错误）是运行时的最后一道。
 *
 * 刻意不测措辞与「三语是否真的翻译了」（同 BA：只测在场，不测已译；规则的判定字段一致性
 * 由 runtime 的 BP-6 守护，这里不重复）。
 */
import { describe, it, expect } from 'vitest'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse as parseYaml } from 'yaml'
import { BUILTIN_POLICY_SPECS, parsePolicyDefinitionFile } from '@shuvix/agent-runtime'

const HERE = dirname(fileURLToPath(import.meta.url))
/** `…/apps/desktop/src/main/services/__tests__` 往上六层 */
const REPO_ROOT = resolve(HERE, '../../../../../..')

/** 内置策略 md 的事实源（打包后整目录进 `Resources/builtin-policies/`，见 BPR-4） */
const MD_DIR_REL = 'packages/agent-runtime/src/security/builtinPolicies/md'
const MD_DIR = join(REPO_ROOT, MD_DIR_REL)

/** 三门界面语言。en 是无后缀那一份 —— 整份语言回退的落点，也是规则的唯一事实源 */
const LANGS = ['en', 'zh', 'ja'] as const
const NAMES = BUILTIN_POLICY_SPECS.map((s) => s.name)

/** 某个内置策略在某语言下的文件名（en 无后缀 —— 与 builtinMdFileNames 的最后一个候选一致） */
const mdFileName = (name: string, lang: string): string =>
  lang === 'en' ? `${name}.md` : `${name}.${lang}.md`

/** 目录里的 .md 文件名（字典序） */
const mdFilesIn = (dir: string): string[] =>
  existsSync(dir)
    ? readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isFile() && e.name.endsWith('.md'))
        .map((e) => e.name)
        .sort()
    : []

/** 每个内置策略 × 每种语言的笛卡尔积，给 it.each 用 */
const MATRIX: [name: string, lang: string][] = NAMES.flatMap((name) =>
  LANGS.map((lang): [string, string] => [name, lang])
)

describe('BPR 内置策略 md：随应用发布的那批安全门', () => {
  it('BPR-0 护栏：md 根存在且真扫到了文件 —— 目录定位一错，下面所有「集合相等」都会在空集上恒真', () => {
    // 这一条必须在最前面。绿的且什么都没测，是最坏的形态。
    expect(existsSync(MD_DIR), `内置策略 md 根不存在：${MD_DIR}`).toBe(true)
    expect(statSync(MD_DIR).isDirectory()).toBe(true)
    expect(mdFilesIn(MD_DIR).length).toBeGreaterThan(0)
    expect(NAMES.length).toBeGreaterThan(0)
  })

  it.each(MATRIX)('BPR-1 %s 有 %s 那一版的文件', (name, lang) => {
    // 本轮最要紧的一条。改制前删掉一份语言文件是编译错误；现在是运行时按文件名查表、
    // 读不到就回退 —— 少一份文件运行时照样全绿，只有这里会红
    const file = join(MD_DIR, mdFileName(name, lang))
    expect(existsSync(file), `缺少内置策略 md：${mdFileName(name, lang)}`).toBe(true)
  })

  it('BPR-2 目录里的文件集合**恰好**等于上面枚举的那张表（双向）', () => {
    // 反向那一半防的是孤儿 md：改名 / 删 spec 之后留在目录里的文件会照样随包发布，
    // 用户在只读笔记本里点得开一份运行时根本不认的策略
    expect(mdFilesIn(MD_DIR)).toEqual(MATRIX.map(([name, lang]) => mdFileName(name, lang)).sort())
  })

  it.each(MATRIX)('BPR-3 %s.%s 经产线解析器解析成功、无告警、name 就是文件基名', (name, lang) => {
    // 用产线那一份解析器而不是在测试里另写一个：内置 md 解析失败时 buildBuiltinPolicies
    // 直接 throw（en）或整份不 overlay —— 磁盘上文件还在，没有任何报错会指向这里
    const fileName = mdFileName(name, lang)
    const warnings: string[] = []
    const parsed = parsePolicyDefinitionFile(
      readFileSync(join(MD_DIR, fileName), 'utf-8'),
      name,
      (msg) => warnings.push(msg)
    )
    expect(warnings, `${fileName} 解析器有话说`).toEqual([])
    expect(parsed, `${fileName} 解析失败`).not.toBeNull()
    expect(parsed!.description.trim(), `${fileName} description 是空的`).not.toBe('')
    // name 是策略的身份，各语言必须一致 —— 被翻译过去会让中文界面下按名寻址的一切
    // （同名覆盖、覆盖副本）当场失联
    expect(parsed!.name).toBe(name)
  })

  it('BPR-4 electron-builder 的 extraResources 带上了这个目录 → builtin-policies', () => {
    // 少这一条：dev 全绿，打包后 Resources/builtin-policies 空无一物 —— 内置策略一道都
    // 读不出来，而 buildBuiltinPolicies 的 throw 意味着启动即炸（比静默放行好，但不该走到）
    const builder = parseYaml(
      readFileSync(join(REPO_ROOT, 'apps/desktop/electron-builder.yml'), 'utf-8')
    ) as { extraResources?: { from?: string; to?: string }[] }
    const TO = 'builtin-policies'
    // from 是 apps/desktop 下的相对路径（electron-builder 的 cwd）
    expect(builder.extraResources ?? []).toContainEqual({ from: `../../${MD_DIR_REL}`, to: TO })
    expect(statSync(resolve(REPO_ROOT, 'apps/desktop', `../../${MD_DIR_REL}`)).isDirectory()).toBe(
      true
    )
    // 打包分支 join 的那一段与这里的 `to` 必须逐字相同 —— 两边各改一个字都会静默失配。
    // 取函数体的源码而不是调用它：调用要 electron，而这一组刻意不碰 electron
    const pathsSrc = readFileSync(join(REPO_ROOT, 'apps/desktop/src/main/utils/paths.ts'), 'utf-8')
    const body = pathsSrc.slice(pathsSrc.indexOf('export function getBuiltinPoliciesDir'))
    expect(body, 'paths.ts 里找不到 getBuiltinPoliciesDir').not.toBe('')
    expect(body.slice(0, body.indexOf('\n}'))).toContain(`join(process.resourcesPath, '${TO}')`)
  })

  it('BPR-5 桌面产品代码里没有任何文件 import `builtinPolicies/inlineSources`', () => {
    // 规则写在 inlineSources.ts 的头注释里：它一旦进了 main 的依赖图，那批 md 就又以字符串
    // 形式躺进 bundle，「跑的和看的是同一份文件」这条就没了 —— 而其余用例全都还是绿的。
    // 单测不在 bundle 里，所以只扫产品代码（`*.test.ts` / `__tests__/` 除外）。
    const offenders: string[] = []
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name)
        if (entry.isDirectory()) {
          if (entry.name !== '__tests__' && entry.name !== 'node_modules') walk(full)
          continue
        }
        if (!/\.(ts|tsx)$/.test(entry.name) || entry.name.includes('.test.')) continue
        if (/builtinPolicies\/inlineSources/.test(readFileSync(full, 'utf-8'))) {
          offenders.push(
            full
              .slice(REPO_ROOT.length + 1)
              .split(sep)
              .join('/')
          )
        }
      }
    }
    walk(join(REPO_ROOT, 'apps/desktop/src'))
    expect(offenders).toEqual([])
  })
})
