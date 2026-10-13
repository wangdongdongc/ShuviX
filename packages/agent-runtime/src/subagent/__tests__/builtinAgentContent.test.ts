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
