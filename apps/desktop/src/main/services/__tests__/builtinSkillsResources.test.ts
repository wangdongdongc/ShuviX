/**
 * BS —— 内置技能的**资源约定**：随应用发布、只读的那批 know-how
 * （`apps/desktop/resources/skills/<lang>/<name>/SKILL.md` + 伴随文件，一种语言一版）。
 *
 * ⚠️ 与隔壁 skillService / skillTool 那批用例**性质不同，别照抄写法**（同 knowledge 的
 * builtinContent.test.ts）：
 *   - 读的是**仓库里的真实目录**，路径从 `import.meta.url` 往上找仓库根 —— 刻意**不经**
 *     `getBuiltinSkillsDir()`。这一组问的是「仓库里文件齐不齐」，与 electron、与打包分支无关；
 *     一旦经过那个函数，开发分支的 `__dirname` 在 vitest 下会错位（`src/main/utils` 往上两级
 *     不是 `apps/desktop`），扫描返回空集，于是「每个语言目录都有每个技能」在空集上恒真。
 *     目录算术单独在 `utils/__tests__/builtinSkillsDir.test.ts` 里用自建 fixture 钉。
 *   - **只读，一个字节都不写盘**（`skillService` 的构造函数会 mkdir `~/.shuvix/skills`，
 *     所以借它的 parseSkillMarkdown 之前先把 HOME 指到临时目录）。
 *
 * 刻意不测的两件事：SKILL.md / references 的**正文措辞**（提示散文，会随调优改动），以及
 * 「三语言是否真的翻译了」—— ja 目前就是 en 的逐字副本，这是约定允许的（未翻译的先放英文原文，
 * 翻译债因此摆在正确的位置，而不是变成「某个语言的用户静默少一个技能」）。只测在场，不测已译。
 */
import { describe, it, expect, afterAll } from 'vitest'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse as parseYaml } from 'yaml'

const HERE = dirname(fileURLToPath(import.meta.url))
/** `…/apps/desktop/src/main/services/__tests__` 往上六层 */
const REPO_ROOT = resolve(HERE, '../../../../../..')
/** 内置技能资源根（打包后是 `Resources/skills/`，开发时就是它）；下面按语言分层 */
const SKILLS_ROOT = join(REPO_ROOT, 'apps/desktop/resources/skills')
/** 提示片段：指路那句 `builtin:<name>` 写在这里，与技能目录分属两个 workspace（见 BS-6） */
const HINT_FILES = [
  'visual-skill-hint.md',
  'visual-skill-hint.zh.md',
  'visual-skill-hint.ja.md'
].map((name) => join(REPO_ROOT, 'packages/agent-runtime/src/agentProfile/fragments', name))
const LOCALE_FILES = ['en', 'zh', 'ja'].map((lang) => ({
  lang,
  path: join(REPO_ROOT, 'packages/chat-protocol/src/i18n/locales', `${lang}.json`)
}))

/**
 * `skillService` 只在这里出场一件事：借它的 **parseSkillMarkdown**。用产线那一份而不是在
 * 测试里重写一个解析器 —— frontmatter 写坏时它会静默回落「目录名当 name、全文当 content」，
 * 技能还在、不报错、只是索引那行描述空了，而这正是 BS-3 要抓的形态。
 * 它的构造函数会 mkdir `~/.shuvix/skills`，所以 HOME 先指到临时目录再动态 import
 * （静态 import 会先于赋值执行）。
 */
const ORIGINAL_HOME = process.env.HOME
const FAKE_HOME = mkdtempSync(join(tmpdir(), 'shuvix-builtin-skills-home-'))
process.env.HOME = FAKE_HOME
const { skillService } = await import('../skillService')
if (ORIGINAL_HOME === undefined) delete process.env.HOME
else process.env.HOME = ORIGINAL_HOME

afterAll(() => {
  rmSync(FAKE_HOME, { recursive: true, force: true })
})

const dirNamesIn = (dir: string): string[] =>
  existsSync(dir)
    ? readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .sort()
    : []

/** 语言目录（`skills/<lang>/`） */
const LANGS = dirNamesIn(SKILLS_ROOT)
/** 技能目录名（`skills/<lang>/<name>/`），取第一种语言的那一份；三语一致由 BS-1 钉 */
const SKILL_NAMES = LANGS.length > 0 ? dirNamesIn(join(SKILLS_ROOT, LANGS[0])) : []

const skillDir = (lang: string, name: string): string => join(SKILLS_ROOT, lang, name)

/** 技能目录下的全部文件（递归，相对路径，`/` 分隔），用于三语言比对 */
const filesUnder = (dir: string): string[] => {
  const out: string[] = []
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name)
    )) {
      const full = join(current, entry.name)
      if (entry.isDirectory()) walk(full)
      else out.push(relative(dir, full).split(sep).join('/'))
    }
  }
  walk(dir)
  return out.sort()
}

const readSkillMd = (lang: string, name: string): string =>
  readFileSync(join(skillDir(lang, name), 'SKILL.md'), 'utf8')

/** 每种语言 × 每个技能的笛卡尔积，给 it.each 用 */
const MATRIX: [lang: string, name: string][] = LANGS.flatMap((lang) =>
  SKILL_NAMES.map((name): [string, string] => [lang, name])
)

describe('BS 内置技能资源：随应用发布的那批 know-how', () => {
  it('BS-0 护栏：真的扫到了技能 —— 目录定位一错，下面所有「集合相等」都会在空集上恒真', () => {
    // 这一条必须在最前面。绿的且什么都没测，是最坏的形态。
    expect(existsSync(SKILLS_ROOT), `内置技能根不存在：${SKILLS_ROOT}`).toBe(true)
    expect(LANGS.length).toBeGreaterThan(0)
    expect(SKILL_NAMES.length).toBeGreaterThan(0)
  })

  it('BS-1 每个语言目录都有每一个技能（集合相等，份数不硬编码）', () => {
    // 加一个内置技能不该让用例变红；少给某一种语言一份才该红 —— 未翻译的那份先放英文原文，
    // 而不是让那个语言的用户静默少一个技能。
    for (const lang of LANGS) {
      expect({ lang, names: dirNamesIn(join(SKILLS_ROOT, lang)) }).toEqual({
        lang,
        names: SKILL_NAMES
      })
    }
  })

  it('BS-2 en 目录必须存在 —— 它是整份语言回退的落点', () => {
    expect(LANGS).toContain('en')
  })

  it.each(MATRIX)('BS-3 %s/%s SKILL.md 解析出非空 name + 非空 description', (lang, name) => {
    // frontmatter 写坏时 parseSkillMarkdown 返回 null，loadSkillFromDir 会静默回落
    // （目录名当 name、全文当 content）：技能还在、不报错、只是索引那行描述空了。
    const parsed = skillService.parseSkillMarkdown(readSkillMd(lang, name))
    expect(parsed, `${lang}/${name}: frontmatter 解析失败`).not.toBeNull()
    expect(parsed!.name.trim()).not.toBe('')
    expect(parsed!.description.trim()).not.toBe('')
  })

  it.each(MATRIX)('BS-4 %s/%s 的 name 字段等于目录名（三语言因此也一致）', (lang, name) => {
    // name 被翻译过去（`name: 作图`）会让 globalName 变成 `builtin:作图`，而提示片段里
    // 写死的是 `builtin:drawing` —— 指路当场变死链，且只在那一种界面语言下。
    expect(skillService.parseSkillMarkdown(readSkillMd(lang, name))!.name).toBe(name)
  })

  it.each(SKILL_NAMES)('BS-5 %s 的伴随文件集合三语言一致', (name) => {
    const [first, ...rest] = LANGS
    const files = filesUnder(skillDir(first, name))
    expect(files).toContain('SKILL.md')
    for (const lang of rest) {
      expect({ lang, files: filesUnder(skillDir(lang, name)) }).toEqual({ lang, files })
    }
  })

  it('BS-6 提示片段里指的 `builtin:<name>` 都是真实存在的技能', () => {
    // 最高价值的一条：片段在 packages/agent-runtime、技能在 apps/desktop/resources，
    // 分属两个 workspace —— 改技能名时没人会同时改那三份 md，指路直接变死链。
    let referenced = 0
    for (const file of HINT_FILES) {
      expect(existsSync(file), `片段不存在：${file}`).toBe(true)
      const names = [...readFileSync(file, 'utf8').matchAll(/builtin:([A-Za-z0-9._-]+)/g)].map(
        (m) => m[1]
      )
      expect(names.length, `${file}: 片段里一个 builtin:<name> 都没有`).toBeGreaterThan(0)
      for (const name of names) {
        expect(SKILL_NAMES, `${file} 指向不存在的技能 builtin:${name}`).toContain(name)
      }
      referenced += names.length
    }
    expect(referenced).toBeGreaterThan(0)
  })

  it.each(MATRIX)('BS-7 %s/%s 正文点名的 references/*.md 都真实存在', (lang, name) => {
    const dir = skillDir(lang, name)
    const cited = [
      ...new Set([...readSkillMd(lang, name).matchAll(/references\/[\w.-]+\.md/g)].map((m) => m[0]))
    ]
    expect(cited.length, `${lang}/${name}: 正文没点名任何 references/`).toBeGreaterThan(0)
    const missing = cited.filter((rel) => !existsSync(join(dir, rel)))
    expect(missing).toEqual([])
  })
})

describe('BS 内置技能的两条接线', () => {
  it('BS-8 electron-builder 的 extraResources 带上了 resources/skills → skills', () => {
    // 少这一条，dev 下一切正常而打包后内置技能整组消失（getBuiltinSkillsRoot 指向
    // Resources/skills/，那里什么都没有）—— 是本仓最看不出来的一类回归。
    const builderPath = join(REPO_ROOT, 'apps/desktop/electron-builder.yml')
    const builder = parseYaml(readFileSync(builderPath, 'utf8')) as {
      extraResources?: { from?: string; to?: string }[]
    }
    expect(builder.extraResources ?? []).toContainEqual({ from: 'resources/skills', to: 'skills' })
    // from 指的是 apps/desktop 下的相对路径，得真的存在
    expect(statSync(SKILLS_ROOT).isDirectory()).toBe(true)
  })

  it.each(SKILL_NAMES)('BS-9 command.skills.%s 三份 locale 里都有且非空', (name) => {
    // findEnabledAsCommands 里有一条「内置 skill 用单独维护的多语言短描述覆盖 popover 文案」
    // 的分支（i18next.exists 才覆盖）—— 缺 key 不报错，只是静默退回 frontmatter 那段塞满
    // 触发关键词的长描述。
    for (const { lang, path } of LOCALE_FILES) {
      const locale = JSON.parse(readFileSync(path, 'utf8')) as {
        command?: { skills?: Record<string, string> }
      }
      const text = locale.command?.skills?.[name]
      expect(text, `${lang}.json 缺 command.skills.${name}`).toBeTypeOf('string')
      expect(text!.trim(), `${lang}.json 的 command.skills.${name} 是空的`).not.toBe('')
    }
  })
})
