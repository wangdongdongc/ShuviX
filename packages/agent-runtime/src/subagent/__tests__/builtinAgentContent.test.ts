/**
 * BA —— 内置 agent 提示词的**内容**用例（`subagent/builtinAgents/md/<name>[.<lang>].md`）。
 *
 * ⚠️ 与本目录其它用例性质不同：这里钉的是**仓库里那批 md 的措辞**，不是运行时逻辑。
 *   - 用 `readFileSync` + `import.meta.url` 从磁盘读，**不走 `?raw`** —— 用例不该依赖打包插件；
 *   - 只读，一个字节都不写盘。
 *
 * 钉的是 2026-09-17 那次裁决（设计附录 Q）落在提示词里的那一半：检索是**两步走** ——
 * `search` 只回答「哪几条可能相关」，正文由 `read` 取，正文里的字面串用 `grep` 找。三种语言
 * 都得教同一件事，且步骤编号结构一致（翻译时漏掉一步，模型就少做一步）。
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
  /** 编号步骤（每一步恰一行）：`[序号, 那一行的其余部分]` */
  const steps = text
    .split('\n')
    .map((line) => /^(\d+)\. (.*)$/.exec(line))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m): [string, string] => [m[1], m[2]])

  it('BA-1 第 1 步教「`search` 出候选 → `read` 取正文」，并把 `grep` 指给找字面串', () => {
    const first = steps.find(([n]) => n === '1')?.[1]
    expect(first).toBeDefined()
    // 三个动作词都得在**同一步**里：拆开写就等于让模型自己拼出两步走
    for (const verb of ['search', 'read', 'grep']) {
      expect(first, verb).toContain(`\`${verb}\``)
    }
  })

  it('BA-2 四步编号结构一致：`1.`–`4.` 按序各一次，不多不少', () => {
    // 不用 Set / Map：重复的序号得看得见（翻译时复制粘贴漏改就是这么来的）
    expect(steps.map(([n]) => n)).toEqual(['1', '2', '3', '4'])
  })
})
