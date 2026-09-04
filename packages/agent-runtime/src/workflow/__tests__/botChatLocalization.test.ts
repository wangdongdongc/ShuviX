/**
 * bot-chat 管线三语言守护 —— 契约见 BOT_CHAT_WORKFLOW_SPEC 的文档注释（builtinWorkflows/index.ts）：
 * 三语言整文件回落（同 builtinAgents），**本地化只许动散文与 `md prompt=` 块**；
 * ```js workflow`` 脚本块与四个 ```json schema=`` 块必须与 en 逐字节同 —— 行为永远只有一份。
 *
 * 与内置策略的多语言守护（security/__tests__/builtinPolicies.test.ts BP-5/6/7）同一哲学：
 * 翻译漂移当场红，而不是静默存在一份「看起来在生效、实际另有语义」的行为拷贝。差别在机制 ——
 * policy 构建器**主动忽略**本地化文件的判定字段（恒取 en），而 bot-chat 是整文件回落、
 * 各语言文件真的会被逐份解析执行，所以这里守的是更强的「逐字节同」而非「构建后等价」。
 *
 * 用例清单（先由契约枚举，BL-6 为读实现后的白盒补充）：
 *  - BL-1 spec↔磁盘拴接：sources 恰 {en, zh, ja}，每份 `?raw` 内联原文与磁盘文件逐字节同
 *  - BL-2 每份语言文件独立解析成功且零 warning；name / shuvix-builtin 标记 / concurrency 恒定
 *  - BL-3 名集合钉板：14 个 prompt 名与 4 个 schema 名的集合，三语言逐语言一致（清单钉死）
 *  - BL-4 ```js workflow`` 脚本块 zh/ja 与 en 逐字节同（提取 helper 与解析产物 script 互校）
 *  - BL-5 每个 ```json schema=<name>`` 块 zh/ja 与 en 逐字节同
 *  - BL-6（白盒）结构字段 vars / limits / inputSchema / bindings 与 en 深度相等
 *    （本地化不得 fork 调参数值；本地化文件长出绑定 = 行为分叉）
 *  - BL-7 本地化是真的：三语言 description 两两互异（防「拷贝文件交差」让 BL-4/5 空转）
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { BOT_CHAT_WORKFLOW_SPEC } from '../builtinWorkflows'
import { parseWorkflowDefinitionFile, type ParsedWorkflowFile } from '../workflowFile'

/** 磁盘原文 —— 守护对象是仓库里的文件本身（readFileSync 相对本测试文件定位，不走 ?raw） */
const DISK: Record<string, string> = {
  en: readFileSync(new URL('../builtinWorkflows/md/bot-chat.md', import.meta.url), 'utf8'),
  zh: readFileSync(new URL('../builtinWorkflows/md/bot-chat.zh.md', import.meta.url), 'utf8'),
  ja: readFileSync(new URL('../builtinWorkflows/md/bot-chat.ja.md', import.meta.url), 'utf8')
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
    const wf = parseWorkflowDefinitionFile(DISK[lang], 'bot-chat', (msg) => warnings.push(msg))
    expect(wf, `${lang} 解析失败：${warnings.join('; ')}`).not.toBeNull()
    hit = { wf: wf!, warnings }
    parsedCache.set(lang, hit)
  }
  return hit
}

describe('bot-chat — 三语言守护（脚本与 schema 逐字节同 en）', () => {
  it('BL-1 spec↔磁盘拴接：sources 恰 en/zh/ja，且 ?raw 内联原文与磁盘文件逐字节同', () => {
    // 后面各条断在磁盘文件上；这条保证磁盘文件正是 bundle 里那三份（多一门语言/漏挂 spec 都在此现形）
    expect(Object.keys(BOT_CHAT_WORKFLOW_SPEC.sources).sort()).toEqual(['en', 'ja', 'zh'])
    for (const lang of LANGS) {
      expect(BOT_CHAT_WORKFLOW_SPEC.sources[lang], `${lang} 的 ?raw 内联与磁盘不一致`).toBe(
        DISK[lang]
      )
    }
  })

  it('BL-2 每份语言文件独立解析成功且零 warning；name / builtin 标记 / concurrency 恒定', () => {
    for (const lang of LANGS) {
      const { wf, warnings } = parsed(lang)
      expect(warnings, `${lang} 解析有 warning`).toEqual([])
      expect(wf.name, `${lang} name 漂移`).toBe('bot-chat')
      expect(wf.concurrency, `${lang} concurrency 漂移`).toBe('parallel')
      expect(DISK[lang], `${lang} 缺 shuvix-builtin 标记`).toMatch(/^shuvix-builtin: true$/m)
    }
  })

  it('BL-3 名集合钉板：14 个 prompt 名与 4 个 schema 名，三语言逐语言一致', () => {
    // 清单钉死而不只比 set 相等：改名/增删块应当在这里显形一次，而不是三语言一起改完仍然全绿。
    // notes / notesTask / sinceNotes 随笔记场合一起退役：bot 的档案经 systemContext 进系统提示词，
    // 不再是任何一个 prompt 块
    const PROMPT_NAMES = [
      'addressed',
      'boundaries',
      'gate',
      'gateBroken',
      'gateTimeout',
      'others',
      'recheck',
      'recheckSkipped',
      'since',
      'task',
      'taskFailed',
      'taskNoAgent',
      'taskTimeout',
      'window'
    ]
    const SCHEMA_NAMES = ['intent', 'intentSolo', 'recheck', 'reply']
    for (const lang of LANGS) {
      const { wf } = parsed(lang)
      expect(Object.keys(wf.prompts).sort(), `${lang} prompt 名集合漂移`).toEqual(PROMPT_NAMES)
      expect(Object.keys(wf.schemas).sort(), `${lang} schema 名集合漂移`).toEqual(SCHEMA_NAMES)
    }
  })

  it('BL-4 脚本块 zh/ja 与 en 逐字节同（行为只有一份）', () => {
    const en = block('en', 'js workflow')
    // helper 自校验：正则提取口径 = 解析器口径（口径错了这条先红，后面的逐字节比较才可信）
    expect(en).toBe(parsed('en').wf.script)
    for (const lang of LOCALIZED) {
      expect(block(lang, 'js workflow') === en, `${lang} 脚本块与 en 不同`).toBe(true)
    }
  })

  it('BL-5 四个 schema 块各自 zh/ja 与 en 逐字节同', () => {
    const names = Object.keys(parsed('en').wf.schemas)
    expect(names).toHaveLength(4)
    for (const name of names) {
      const en = block('en', `json schema=${name}`)
      for (const lang of LOCALIZED) {
        expect(block(lang, `json schema=${name}`), `${lang} 的 schema '${name}' 与 en 不同`).toBe(
          en
        )
      }
    }
  })

  it('BL-6（白盒）结构字段与 en 深度相等：vars / limits / inputSchema / bindings', () => {
    // en 侧数值本身的钉板在 builtinWorkflows.test.ts（BC-1/BC-2）；这里只守「各语言 = en」——
    // 本地化不得 fork 调参数值，本地化文件长出绑定 = 行为分叉
    const en = parsed('en').wf
    for (const lang of LOCALIZED) {
      const { wf } = parsed(lang)
      expect(wf.vars, `${lang} vars 与 en 不一致`).toEqual(en.vars)
      expect(wf.limits, `${lang} limits 与 en 不一致`).toEqual(en.limits)
      expect(wf.inputSchema, `${lang} inputSchema 与 en 不一致`).toEqual(en.inputSchema)
      expect(wf.bindings, `${lang} bindings 与 en 不一致`).toEqual(en.bindings)
    }
  })

  it('BL-7 本地化是真的：三语言 description 两两互异', () => {
    // zh/ja 若是 en 的逐字节拷贝，BL-4/5 全绿但毫无守护意义 —— 先证明「确实翻译了」
    const descriptions = LANGS.map((lang) => parsed(lang).wf.description)
    expect(new Set(descriptions).size, 'description 存在语言间拷贝').toBe(3)
    for (const lang of LOCALIZED) {
      expect(DISK[lang] === DISK.en, `${lang} 是 en 的整文件拷贝`).toBe(false)
    }
  })
})
