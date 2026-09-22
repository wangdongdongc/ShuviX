/**
 * BA —— 内置**智能体档案**的资源约定：随应用发布、运行时现读的那批 md
 * （`packages/agent-runtime/src/subagent/builtinAgents/md/<name>[.<lang>].md`，
 * 一个 agent 一语言一文件）。
 *
 * ⚠️ 与 agentService / registry 那批用例**性质不同，别照抄写法**（同 builtinSkillsResources）：
 *   - 读的是**仓库里的真实目录**，路径从 `import.meta.url` 往上找仓库根 —— 刻意**不经**
 *     `getBuiltinAgentsDir()`。这一组问的是「仓库里文件齐不齐」，与 electron、与打包分支无关；
 *     一旦经过那个函数，开发分支的 `__dirname` 在 vitest 下会错位（它的基准是构建产物
 *     `out/main`，源码位置往上四级落在 `apps/`），扫描返回空集，于是 BA-1/BA-2 那两条
 *     「集合相等」会在空集上恒真。目录算术单独在 `utils/__tests__/builtinAgentsDir.test.ts` 里钉。
 *   - **只读，一个字节都不写盘**：这就是产品源码本身。
 *
 * 为什么这一组是本轮最要紧的守护：改制**前**每个 spec 的 `sources` 是显式 `?raw` import，
 * 删掉 `work.ja.md` 是一个编译错误；改制**后**是运行时按文件名查表，读不到就按语言回退 ——
 * `registry.test.ts` 的 `sourcesOf()` 也只把「读得到的语言」放进表，所以漏一份文件那边照样全绿，
 * 症状只是日语用户静默拿到英文。缺文件必须在这里、且只能在这里现形。
 *
 * 刻意不测的两件事：md 正文的**措辞**（提示散文，会随调优改动），以及「三语是否真的翻译了」
 * —— 未翻译的那份先放英文原文是约定允许的，翻译债因此摆在正确的位置，而不是变成
 * 「某个语言的用户静默少一个内置档案」。只测在场，不测已译。
 */
import { describe, it, expect } from 'vitest'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse as parseYaml } from 'yaml'
import { BUILTIN_PROFILE_SPECS, parseAgentDefinitionFile } from '@shuvix/agent-runtime'

const HERE = dirname(fileURLToPath(import.meta.url))
/** `…/apps/desktop/src/main/services/__tests__` 往上六层 */
const REPO_ROOT = resolve(HERE, '../../../../../..')

/** 内置档案 md 的事实源（打包后整目录进 `Resources/builtin-agents/`，见 BA-4） */
const MD_DIR_REL = 'packages/agent-runtime/src/subagent/builtinAgents/md'
const MD_DIR = join(REPO_ROOT, MD_DIR_REL)

/** 三门界面语言。en 是无后缀那一份 —— 整份语言回退的落点 */
const LANGS = ['en', 'zh', 'ja'] as const
const NAMES = BUILTIN_PROFILE_SPECS.map((s) => s.name)

/** 某个内置 agent 在某语言下的文件名（en 无后缀 —— 与 builtinMdFileNames 的最后一个候选一致） */
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

/** 每个内置 × 每种语言的笛卡尔积，给 it.each 用 */
const MATRIX: [name: string, lang: string][] = NAMES.flatMap((name) =>
  LANGS.map((lang): [string, string] => [name, lang])
)

describe('BA 内置档案 md：随应用发布的那批文案', () => {
  it('BA-0 护栏：md 根存在且真扫到了文件 —— 目录定位一错，下面所有「集合相等」都会在空集上恒真', () => {
    // 这一条必须在最前面。绿的且什么都没测，是最坏的形态。
    expect(existsSync(MD_DIR), `内置档案 md 根不存在：${MD_DIR}`).toBe(true)
    expect(statSync(MD_DIR).isDirectory()).toBe(true)
    expect(mdFilesIn(MD_DIR).length).toBeGreaterThan(0)
    expect(NAMES.length).toBeGreaterThan(0)
  })

  it.each(MATRIX)('BA-1 %s 有 %s 那一版的文件', (name, lang) => {
    // 本轮最要紧的一条。改制前 spec.sources 是显式 `?raw` import，删掉 work.ja.md 是编译错误；
    // 现在是运行时按文件名查表、读不到就回退，registry.test.ts 的 sourcesOf() 也只收读得到的
    // 语言 —— 少一份文件那边照样全绿，日语用户静默拿到英文，只有这里会红。
    const file = join(MD_DIR, mdFileName(name, lang))
    expect(existsSync(file), `缺少内置档案 md：${mdFileName(name, lang)}`).toBe(true)
  })

  it('BA-2 目录里的文件集合**恰好**等于上面枚举的那张表（双向）', () => {
    // 反向那一半防的是孤儿 md：改名 / 删 spec 之后留在目录里的文件会照样随包发布，
    // 用户在只读笔记本里点得开一份运行时根本不认的档案
    expect(mdFilesIn(MD_DIR)).toEqual(MATRIX.map(([name, lang]) => mdFileName(name, lang)).sort())
  })

  it.each(MATRIX)('BA-3 %s.%s 经产线解析器解析成功、无告警、name 就是文件基名', (name, lang) => {
    // 用产线那一份解析器而不是在测试里另写一个：内置 md 解析失败时 buildBuiltinProfile 返回
    // null，那个 agent 就整个消失（派发工具的名单里没有它），而磁盘上文件还在 —— 没有任何
    // 报错会指向这里
    const fileName = mdFileName(name, lang)
    const warnings: string[] = []
    const parsed = parseAgentDefinitionFile(
      readFileSync(join(MD_DIR, fileName), 'utf-8'),
      name,
      (msg) => warnings.push(msg)
    )
    expect(warnings, `${fileName} 解析器有话说`).toEqual([])
    expect(parsed, `${fileName} 解析失败`).not.toBeNull()
    expect(parsed!.description.trim(), `${fileName} description 是空的`).not.toBe('')
    // name 是档案的身份，各语言必须一致 —— 被翻译过去（`name: 工作`）会让中文界面下按名
    // 寻址的一切（派发、覆盖副本、子会话 agent_profile）当场失联
    expect(parsed!.name).toBe(name)
  })

  it('BA-4 electron-builder 的 extraResources 带上了这个目录 → builtin-agents', () => {
    // 少这一条：dev 全绿，打包后 Resources/builtin-agents 空无一物 —— 一个内置档案都读不出来
    const builder = parseYaml(
      readFileSync(join(REPO_ROOT, 'apps/desktop/electron-builder.yml'), 'utf-8')
    ) as { extraResources?: { from?: string; to?: string }[] }
    const TO = 'builtin-agents'
    // from 是 apps/desktop 下的相对路径（electron-builder 的 cwd）
    expect(builder.extraResources ?? []).toContainEqual({ from: `../../${MD_DIR_REL}`, to: TO })
    expect(statSync(resolve(REPO_ROOT, 'apps/desktop', `../../${MD_DIR_REL}`)).isDirectory()).toBe(
      true
    )
    // 打包分支 join 的那一段与这里的 `to` 必须逐字相同 —— 两边各改一个字都会静默失配。
    // 取函数体的源码而不是调用它：调用要 electron，而这一组刻意不碰 electron
    const pathsSrc = readFileSync(join(REPO_ROOT, 'apps/desktop/src/main/utils/paths.ts'), 'utf-8')
    const body = pathsSrc.slice(pathsSrc.indexOf('export function getBuiltinAgentsDir'))
    expect(body, 'paths.ts 里找不到 getBuiltinAgentsDir').not.toBe('')
    expect(body.slice(0, body.indexOf('\n}'))).toContain(`join(process.resourcesPath, '${TO}')`)
  })

  it('BA-5 桌面产品代码里没有任何文件 import `builtinAgents/inlineSources`', () => {
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
        if (/builtinAgents\/inlineSources/.test(readFileSync(full, 'utf-8'))) {
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
