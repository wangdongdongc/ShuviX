/**
 * auto-title 三语言守护 —— 契约见 AUTO_TITLE_WORKFLOW_SPEC 的文档注释（builtinWorkflows/index.ts）：
 * 三语言整文件回落（同 builtinAgents），**本地化只许动人读面**（`shuvix-displayName` /
 * `description` / 散文）；```js workflow`` 脚本块与 ```json schema=`` 块必须与 en 逐字节同 ——
 * 行为永远只有一份。
 *
 * 与 bot-chat 的同名守护（botChatLocalization.test.ts BL-1…BL-7）逐条同形：整文件回落意味着
 * 各语言文件真的会被逐份解析执行，所以守的是「逐字节同」而非「构建后等价」。
 * auto-title 比 bot-chat 更需要这层守护的一点在于它是**埋点驱动**的：
 * 未知埋点 id 只 warn 不判非法（绑定惰性化），一条被翻译坏的 `trigger:` 会安安静静地
 * 变成一份「装上了、永远不响」的绑定 —— AL-2 的零 warning 就是拦这个。
 *
 * 用例清单（先由契约枚举，AL-6 为读实现后的白盒补充）：
 *  - AL-1 spec↔磁盘拴接：sources 恰 {en, zh, ja}，每份 `?raw` 内联原文与磁盘文件逐字节同
 *  - AL-2 每份语言文件独立解析成功且零 warning；name / shuvix-builtin 标记 / concurrency 恒定
 *  - AL-3 块名钉板：schema 名恰 [result]，prompt 块一个都没有（提示词就地在脚本里拼）
 *  - AL-4 ```js workflow`` 脚本块 zh/ja 与 en 逐字节同（提取 helper 与解析产物 script 互校）
 *  - AL-5 ```json schema=result`` 块 zh/ja 与 en 逐字节同
 *  - AL-6（白盒）结构字段 bindings / vars / limits / inputSchema 与 en 深度相等
 *  - AL-7 本地化是真的：三语言 description 两两互异（防「拷贝文件交差」让 AL-4/5 空转）
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { AUTO_TITLE_WORKFLOW_SPEC } from '../builtinWorkflows'
import { parseWorkflowDefinitionFile, type ParsedWorkflowFile } from '../workflowFile'

/** 磁盘原文 —— 守护对象是仓库里的文件本身（readFileSync 相对本测试文件定位，不走 ?raw） */
const DISK: Record<string, string> = {
  en: readFileSync(new URL('../builtinWorkflows/md/auto-title.md', import.meta.url), 'utf8'),
  zh: readFileSync(new URL('../builtinWorkflows/md/auto-title.zh.md', import.meta.url), 'utf8'),
  ja: readFileSync(new URL('../builtinWorkflows/md/auto-title.ja.md', import.meta.url), 'utf8')
}
const LANGS = ['en', 'zh', 'ja'] as const
const LOCALIZED = ['zh', 'ja'] as const

/**
 * 顶格围栏块提取（与解析器同口径：info 顶格、闭栏是裸 ``` 行）。
 * 找不到即断言失败 —— 「某语言少一个块」要报块名，而不是在 toBe 里比对 undefined。
 */
const block = (lang: string, info: string): string => {
  const m = new RegExp('^```' + info + '\\n([\\s\\S]*?)\\n```$', 'm').exec(DISK[lang])
  expect(m, `${lang}: 找不到 \`${info}\` 块`).not.toBeNull()
  return m![1]
}

const parsedCache = new Map<string, { wf: ParsedWorkflowFile; warnings: string[] }>()
const parsed = (lang: string): { wf: ParsedWorkflowFile; warnings: string[] } => {
  let hit = parsedCache.get(lang)
  if (!hit) {
    const warnings: string[] = []
    const wf = parseWorkflowDefinitionFile(DISK[lang], 'auto-title', (msg) => warnings.push(msg))
    expect(wf, `${lang} 解析失败：${warnings.join('; ')}`).not.toBeNull()
    hit = { wf: wf!, warnings }
    parsedCache.set(lang, hit)
  }
  return hit
}

describe('auto-title — 三语言守护（脚本与 schema 逐字节同 en）', () => {
  it('AL-1 spec↔磁盘拴接：sources 恰 en/zh/ja，且 ?raw 内联原文与磁盘文件逐字节同', () => {
    // 后面各条断在磁盘文件上；这条保证磁盘文件正是 bundle 里那三份（多一门语言/漏挂 spec 都在此现形）
    expect(Object.keys(AUTO_TITLE_WORKFLOW_SPEC.sources).sort()).toEqual(['en', 'ja', 'zh'])
    for (const lang of LANGS) {
      expect(AUTO_TITLE_WORKFLOW_SPEC.sources[lang], `${lang} 的 ?raw 内联与磁盘不一致`).toBe(
        DISK[lang]
      )
    }
  })

  it('AL-2 每份语言文件独立解析成功且零 warning；name / builtin 标记 / concurrency 恒定', () => {
    for (const lang of LANGS) {
      const { wf, warnings } = parsed(lang)
      // 零 warning 在这份文件上格外要紧：未知埋点 id **只 warn 不判非法**（绑定惰性化），
      // 一个被翻译坏的 `trigger:` 因此会静默地交付一份永不触发的绑定
      expect(warnings, `${lang} 解析有 warning`).toEqual([])
      expect(wf.name, `${lang} name 漂移`).toBe('auto-title')
      expect(wf.concurrency, `${lang} concurrency 漂移`).toBe('skip')
      expect(DISK[lang], `${lang} 缺 shuvix-builtin 标记`).toMatch(/^shuvix-builtin: true$/m)
    }
  })

  it('AL-3 块名钉板：schema 名恰 [result]，且一个 prompt 块都没有', () => {
    // 清单钉死而不只比语言间相等：改名/增删块应当在这里显形一次，而不是三语言一起改完仍然全绿。
    // prompts 为空是**刻意的** —— auto-title 的提示词就地在脚本里拼；某一门语言的译者把那段
    // 英文抽成 `md prompt=` 块，就等于让这门语言的行为与 en 分叉（而 AL-4 只看脚本块）
    const SCHEMA_NAMES = ['result']
    for (const lang of LANGS) {
      const { wf } = parsed(lang)
      expect(Object.keys(wf.schemas).sort(), `${lang} schema 名集合漂移`).toEqual(SCHEMA_NAMES)
      expect(Object.keys(wf.prompts), `${lang} 长出了 prompt 块`).toEqual([])
    }
  })

  it('AL-4 脚本块 zh/ja 与 en 逐字节同（行为只有一份）', () => {
    const en = block('en', 'js workflow')
    // helper 自校验：正则提取口径 = 解析器口径（口径错了这条先红，后面的逐字节比较才可信）
    expect(en).toBe(parsed('en').wf.script)
    for (const lang of LOCALIZED) {
      expect(block(lang, 'js workflow') === en, `${lang} 脚本块与 en 不同`).toBe(true)
    }
  })

  it('AL-5 schema 块 zh/ja 与 en 逐字节同', () => {
    // 块名从解析产物取：schema 改名时这里报「块名漂移」，而不是循环空转一遍照样全绿
    const names = Object.keys(parsed('en').wf.schemas)
    expect(names, 'en 的 schema 块名漂移').toEqual(['result'])
    for (const name of names) {
      const en = block('en', `json schema=${name}`)
      for (const lang of LOCALIZED) {
        expect(block(lang, `json schema=${name}`), `${lang} 的 schema '${name}' 与 en 不同`).toBe(
          en
        )
      }
    }
  })

  it('AL-6（白盒）结构字段与 en 深度相等：bindings / vars / limits / inputSchema', () => {
    // en 侧数值本身的钉板在 builtinWorkflows.test.ts（两条绑定 / concurrency / limits）；
    // 这里只守「各语言 = en」—— 本地化不得 fork 触发条件，本地化文件长出调参数值 = 行为分叉。
    // bindings 是承重的那一半：两条埋点、两串 when CEL，其中第二条是 YAML 折叠标量（`>-`）。
    // 折叠标量对**缩进**敏感而对纯换行不敏感：同缩进重排折回同一串（这条因此不会误报），
    // 但多一级缩进或夹一个空行都会往 CEL 里塞进真的换行符 —— 那正是本地化编辑最常见的手滑。
    // vars / limits / inputSchema 三项守的是「本地化保持为空」
    const en = parsed('en').wf
    for (const lang of LOCALIZED) {
      const { wf } = parsed(lang)
      expect(wf.bindings, `${lang} bindings 与 en 不一致`).toEqual(en.bindings)
      expect(wf.vars, `${lang} vars 与 en 不一致`).toEqual(en.vars)
      expect(wf.limits, `${lang} limits 与 en 不一致`).toEqual(en.limits)
      expect(wf.inputSchema, `${lang} inputSchema 与 en 不一致`).toEqual(en.inputSchema)
    }
  })

  it('AL-7 本地化是真的：三语言 description 两两互异', () => {
    // zh/ja 若是 en 的逐字节拷贝，AL-4/5 全绿但毫无守护意义 —— 先证明「确实翻译了」。
    // displayName 的同类断言归 builtinWorkflows.test.ts 的 WD-1/WD-2（那边逐份内置扫）
    const descriptions = LANGS.map((lang) => parsed(lang).wf.description)
    expect(new Set(descriptions).size, 'description 存在语言间拷贝').toBe(3)
    for (const lang of LOCALIZED) {
      expect(DISK[lang] === DISK.en, `${lang} 是 en 的整文件拷贝`).toBe(false)
    }
  })
})
