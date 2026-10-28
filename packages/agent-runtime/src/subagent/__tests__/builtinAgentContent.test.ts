/**
 * BA —— 内置 agent 提示词的**内容**用例（`subagent/builtinAgents/md/<name>[.<lang>].md`）。
 *
 * ⚠️ 与本目录其它用例性质不同：这里钉的是**仓库里那批 md 的措辞**，不是运行时逻辑。
 *   - 用 `readFileSync` + `import.meta.url` 从磁盘读，**不走 `?raw`** —— 用例不该依赖打包插件；
 *   - 只读，一个字节都不写盘。
 *
 * knowledge-writer（2026-10-12 起是 `knowledge` 工具 `submit` 的检查方）：三种语言的段落结构一致（翻译时
 * 漏掉一段，模型在那门语言里就少一条规矩），示例 frontmatter 里每个它该补的键都在 —— 键表只住在这份
 * 提示词里，示例少一个键，写手就少补一个。
 *
 * bot（bot 会话的基座档案，2026-10-24 起「自己动手干活」）：三种语言的工具面一字不差、没有 bash / MCP；description
 * 与正文里不再残留「真正的活都交给子会话、write/edit 不许用来干活」那套旧说法 —— 日报 bot 被定时叫起来时要自己写
 * 跟踪项，旧措辞会让它拒绝动手。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
/** `…/subagent/__tests__` 的隔壁 `builtinAgents/md` */
const MD_DIR = resolve(HERE, '../builtinAgents/md')

/** 一个内置 agent 的三语文件名（en 无语言后缀，与 spec.ts 的 sources 同一套命名） */
const localized = (name: string): string[] => [`${name}.md`, `${name}.ja.md`, `${name}.zh.md`]

describe.each(localized('knowledge-writer'))('BA knowledge-writer · %s', (file) => {
  const text = readFileSync(join(MD_DIR, file), 'utf8')
  const sections = text.split('\n').filter((line) => line.startsWith('## '))
  /** 正文里那段 ```yaml 示例 */
  const example = /```yaml\n([\s\S]*?)```/.exec(text)?.[1] ?? ''

  it('BA-1 三段结构一致：恰三个 `## ` 段（元数据 / 判定 / 交回），没有编号步骤', () => {
    expect(sections).toHaveLength(3)
    // 改版前的「search → create → edit → validate」四步流程不该残留
    expect(text.split('\n').some((line) => /^\d+\. /.test(line))).toBe(false)
  })

  it('BA-2 示例 frontmatter 带齐写手要补的键，且以自述行开头', () => {
    const keys = example
      .split('\n')
      .map((line) => /^([a-z_]+):/.exec(line)?.[1])
      .filter((k): k is string => !!k)
    expect(keys[0]).toBe('shuvix')
    expect(example).toContain('shuvix: okf v0.2')
    for (const key of ['type', 'title', 'description', 'tags', 'status', 'sources']) {
      expect(keys, key).toContain(key)
    }
    // 两个宿主章不进示例：示例里出现就是在教它自己写
    expect(keys).not.toContain('generated')
    expect(keys).not.toContain('verified')
  })
})

describe('BA bot 基座档案', () => {
  /** 每种语言：旧措辞（不得残留）与新措辞（必须在）—— 字面量，钉的就是这几句话 */
  const BOT = {
    'bot.md': {
      goneDescription: 'hands every real task to a sub-session',
      goneBody: ["You don't do the work yourself", 'never for a task'],
      present: ['## Working', 'You do the work yourself']
    },
    'bot.zh.md': {
      goneDescription: '把真正的活交给子会话',
      goneBody: ['活不是你自己干的', '绝不用来干活'],
      present: ['## 干活', '活由你自己用手上的工具干']
    },
    'bot.ja.md': {
      goneDescription: '実作業はすべてサブセッションに渡す',
      goneBody: ['作業は自分ではしません', '作業には使いません'],
      present: ['## 作業', '作業は自分のツールで自分で行います']
    }
  } as const
  const TOOLS =
    'read, ls, grep, glob, ask, suggest, write, edit, session, agent, knowledge, artifact, widget, skill:builtin:drawing, skill:builtin:tracking'

  it.each(Object.keys(BOT) as Array<keyof typeof BOT>)(
    'BA-3 %s：工具面不变（没有 bash / mcp:*）；description 与正文不再要求把活全交给子会话、不再禁止用 write/edit 干活',
    (file) => {
      const text = readFileSync(join(MD_DIR, file), 'utf8')
      const field = (key: string): string =>
        new RegExp(`^${key}: (.*)$`, 'm').exec(text)?.[1]?.trim() ?? ''
      const tools = field('shuvix-tools')
      expect(tools).toBe(TOOLS)
      expect(tools.split(',').map((t) => t.trim())).not.toContain('bash')
      expect(tools).not.toMatch(/mcp:/)

      const description = field('description')
      expect(description.length).toBeGreaterThan(0)
      expect(description).not.toContain(BOT[file].goneDescription)

      const body = text.slice(text.indexOf('\n---', 4) + 4)
      for (const gone of BOT[file].goneBody) expect(body, gone).not.toContain(gone)
      for (const present of BOT[file].present) expect(body, present).toContain(present)
    }
  )
})

/**
 * 提议（`suggest` 工具，2026-10-25）：三条主路线的基座（work / chat / coding，三种语言）都持有它（bot 的那份在 BA-3）；
 * 权限审查员三种语言都写着「采纳的提议是 agent 写、人点了采纳的，只授权那句话本身」—— 自动审查给这种话加了前缀，
 * 审查员得知道前缀是什么意思，否则它照样把 agent 写的一句当成用户的完整授权。
 */
describe('BA suggest', () => {
  const toolsOf = (file: string): string[] => {
    const text = readFileSync(join(MD_DIR, file), 'utf8')
    const line = /^shuvix-tools: (.*)$/m.exec(text)?.[1] ?? ''
    return line.split(',').map((t) => t.trim())
  }

  it.each(['work', 'chat', 'coding'].flatMap(localized))(
    'BA-4 %s：shuvix-tools 里有 suggest，紧跟在 ask 之后',
    (file) => {
      const tools = toolsOf(file)
      expect(tools).toContain('suggest')
      expect(tools.indexOf('suggest')).toBe(tools.indexOf('ask') + 1)
    }
  )

  const REVIEWER = {
    'permission-reviewer.md': [
      'A line marked as an accepted suggestion was written by the agent and clicked by the human',
      'it authorizes what that line says and nothing beyond it'
    ],
    'permission-reviewer.zh.md': [
      '标明是采纳的提议的那一句，是 agent 写、人点了采纳的',
      '它只授权这句话本身说的事，不多于此'
    ],
    'permission-reviewer.ja.md': [
      '採用した提案と明記された一文は、エージェントが書き人が採用をクリックしたものです',
      'その文が言っていることだけを許可し、それ以上は許可しません'
    ]
  } as const

  it.each(Object.keys(REVIEWER) as Array<keyof typeof REVIEWER>)(
    'BA-5 %s：`userMessages` 那一条里写着采纳的提议只授权那句话本身',
    (file) => {
      const text = readFileSync(join(MD_DIR, file), 'utf8')
      const bullet = text.split('\n').find((line) => line.startsWith('- `userMessages`')) ?? ''
      expect(bullet.length).toBeGreaterThan(0)
      for (const phrase of REVIEWER[file]) expect(bullet, phrase).toContain(phrase)
    }
  )
})
