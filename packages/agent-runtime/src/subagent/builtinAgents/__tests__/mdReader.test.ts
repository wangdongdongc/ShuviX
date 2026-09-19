/**
 * BM —— 内置档案的**读取口**：候选文件名（`builtinMdFileNames`）与构建器如何用它
 * （`buildBuiltinProfile` 的语言回退 / `basePath` 回带 / 单份解析失败的影响面）。
 *
 * 与 `agentProfile/__tests__/registry.test.ts` 分工明确：那边拿**真实的内置 md** 钉内容与
 * 语言解析的结果（"工作" / "ワーク"），这边用**桩 reader** 钉机制 —— 试了哪几个文件名、
 * 按什么顺序、命中之后还试不试、命中的那一份的路径有没有原样回带。桩 reader 是唯一能问出
 * 「读到第几个就停」的办法：真文件三份都在，停没停都一样绿。
 *
 * `basePath` 为什么值得单独钉：它就是侧栏点内置行时打开的那份只读笔记本的文件。
 * 让它回落成 `<name>.md`（而不是命中的 `<name>.zh.md`），症状是「中文界面下跑的是中文档案、
 * 点开看到的是英文那一份」—— 而两边都不报错。
 */
import { describe, it, expect, vi } from 'vitest'
import {
  buildBuiltinProfile,
  buildBuiltinProfiles,
  builtinMdFileNames,
  BUILTIN_PROFILE_SPECS,
  type BuiltinMdReader
} from '../index'

/** 最小合法内置 md（正文里带文件名，好认出「读到的是哪一份」） */
const md = (name: string, fileName: string): string =>
  [
    '---',
    'shuvix: agent v1',
    `name: ${name}`,
    `description: fixture ${fileName}`,
    '---',
    '',
    `Body of ${fileName}.`,
    ''
  ].join('\n')

/** 注入开关写成非布尔 → 解析器判整份非法 */
const BROKEN_MD = [
  '---',
  'shuvix: agent v1',
  'name: coding',
  'shuvix-project-awareness: yes please',
  '---',
  '',
  'Broken.',
  ''
].join('\n')

/** 按一张「文件名 → 原文」的表读，并记下被问过的文件名（顺序即调用序） */
function recordingReader(table: Record<string, string>): {
  read: BuiltinMdReader
  asked: string[]
} {
  const asked: string[] = []
  return {
    asked,
    read: (fileName) => {
      asked.push(fileName)
      return table[fileName] ?? null
    }
  }
}

describe('builtinMdFileNames —— 候选顺序与去重', () => {
  it('BM-1 精确语言 → 基础语言 → en（无后缀），重复的候选去掉；语言归一为小写', () => {
    // 候选表就是「按文件整体回退」这条规则的全部：半中半英的档案比全英文更难读，
    // 所以回退发生在文件这一层，不是字段这一层
    expect(builtinMdFileNames('work', 'zh-CN')).toEqual(['work.zh-cn.md', 'work.zh.md', 'work.md'])
    // lang === base：`work.zh.md` 只该出现一次（Set 去重），否则命中前会白读一次
    expect(builtinMdFileNames('work', 'zh')).toEqual(['work.zh.md', 'work.md'])
    // en 也走同一条路：`work.en.md` 允许存在（今天没有），读不到就落到无后缀那一份
    expect(builtinMdFileNames('work', 'en')).toEqual(['work.en.md', 'work.md'])
    expect(builtinMdFileNames('work', undefined)).toEqual(builtinMdFileNames('work', 'en'))
    expect(builtinMdFileNames('work', '')).toEqual(builtinMdFileNames('work', 'en'))
    // i18next 可能给出 'ZH-CN'：文件名是小写的，不归一就一份都读不到
    expect(builtinMdFileNames('work', 'ZH-CN')).toEqual(builtinMdFileNames('work', 'zh-CN'))
  })
})

describe('buildBuiltinProfile —— 语言回退与 basePath', () => {
  const SPEC = { name: 'coding' }

  it('BM-2 取第一个读得到的候选就停：前面返回 null 的跳过、后面的不再问', () => {
    const { read, asked } = recordingReader({ 'coding.zh.md': md('coding', 'coding.zh.md') })

    const built = buildBuiltinProfile(SPEC, { language: 'zh-CN', readMd: read })!
    expect(built.systemPrompt).toContain('Body of coding.zh.md.')
    // 问到命中为止：`coding.md` 明明也在表外，但根本不该被问
    expect(asked).toEqual(['coding.zh-cn.md', 'coding.zh.md'])
  })

  it('BM-2b 命中第一个候选时后面的一个都不问', () => {
    const { read, asked } = recordingReader({
      'coding.ja.md': md('coding', 'coding.ja.md'),
      'coding.md': md('coding', 'coding.md')
    })

    expect(buildBuiltinProfile(SPEC, { language: 'ja', readMd: read })!.systemPrompt).toContain(
      'Body of coding.ja.md.'
    )
    expect(asked).toEqual(['coding.ja.md'])
  })

  it('BM-3 basePath 是**命中的那一份**的路径（不是第一个候选、也不是 `<name>.md`）；省略 mdPath 为空串', () => {
    // 侧栏点内置行打开的就是这份文件。回落成 `<name>.md` 的症状是「跑的是中文档案、
    // 点开看到的是英文那一份」，两边都不报错
    const table = { 'coding.zh.md': md('coding', 'coding.zh.md') }
    const built = buildBuiltinProfile(SPEC, {
      language: 'zh-CN',
      readMd: recordingReader(table).read,
      mdPath: (fileName) => `/pkg/builtin-agents/${fileName}`
    })!
    expect(built.basePath).toBe('/pkg/builtin-agents/coding.zh.md')
    expect(built.source).toBe('builtin')

    // 没有文件系统的宿主（扩展）不给 mdPath —— 空串，不是 undefined
    const inlined = buildBuiltinProfile(SPEC, {
      language: 'zh-CN',
      readMd: recordingReader(table).read
    })!
    expect(inlined.basePath).toBe('')
  })

  it('BM-3b 一份候选都读不到 → null + 一条 warn', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect(buildBuiltinProfile(SPEC, { readMd: () => null })).toBeNull()
      expect(warn).toHaveBeenCalledTimes(1)
      expect(String(warn.mock.calls[0][0])).toContain('coding')
    } finally {
      warn.mockRestore()
    }
  })
})

describe('buildBuiltinProfiles —— 一份坏 md 的影响面', () => {
  it('BM-4 解析不了的那份 → 该 agent 为 null + 有 warn；其余照常产出', () => {
    // 内置 md 随包发布，出现即开发期错误 —— 但它不该把整张名单带走：一份坏掉的 coding.md
    // 让 work / chat 也消失，症状会是「所有会话都建不出根 Agent」
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const table: Record<string, string> = { 'coding.md': BROKEN_MD }
      for (const spec of BUILTIN_PROFILE_SPECS) {
        if (spec.name !== 'coding') table[`${spec.name}.md`] = md(spec.name, `${spec.name}.md`)
      }

      const names = buildBuiltinProfiles({
        widgetsRoot: '/w',
        readMd: (fileName) => table[fileName] ?? null
      }).map((a) => a.name)

      expect(names).not.toContain('coding')
      expect(names).toEqual(BUILTIN_PROFILE_SPECS.map((s) => s.name).filter((n) => n !== 'coding'))
      // 诊断通道现成，别静默：坏的那一份必须说出自己是谁
      expect(warn).toHaveBeenCalled()
      expect(warn.mock.calls.map((c) => String(c[0])).join('\n')).toContain('coding.md')
    } finally {
      warn.mockRestore()
    }
  })
})
