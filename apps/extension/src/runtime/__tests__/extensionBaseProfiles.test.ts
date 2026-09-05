/**
 * 扩展端两份基座档案（default / chat）的钉板 —— 它们是共享 `builtinAgents/md/` 的**手抄
 * 副本**，没有任何机制保证跟着共享档案走。
 *
 * 副本存在的理由：共享的两份点名了 bash / ssh / glob / grep / ls / 子会话这些扩展没有的
 * 东西，直接用会误导 Agent。但代价是漂移无声 —— 最危险的一种是把桌面 `default` 新增的
 * 「交给子会话去做」整节同步过来：扩展根本没有 `session` 工具，模型会照着提示词调一个
 * 不存在的动作。故这里钉三样：
 *   - **结构字段与共享版逐项相等**（name / 会话感知 / 指令文件 / 项目感知）—— 一份改了
 *     `shuvix-session-awareness` 的副本会让「切回基座」这条退路在扩展端单独失效；
 *   - **两份副本的工具面完全相等** —— 桌面上两条路线差在「自己干 vs 交给 coding 子会话」，
 *     扩展既没有 shell 也没有子会话，两份文案只该差工作目录形态（项目文件夹 vs 隔离临时
 *     目录）。工具面一旦分叉，「按会话形态选默认档案」这套配置在两端就不再指同一件事；
 *   - **三语正文都不出现派发/子会话词汇**，以及占位符集合跨语言一致（翻译时漏改占位符
 *     = 变量失效，与 registry.test.ts 对共享档案的同名断言一个道理）。
 *
 * 只 import 六份 md 原文 + agent-runtime 的构建器：`subAgent.ts` / `chatApiAdapter.ts` 会把
 * chrome.* / OPFS / IndexedDB 拖进 import 图，在 node 环境下起不来（同 instructionFilesRuntime
 * 那条 mock 说明）。
 */
import { describe, expect, it } from 'vitest'
import {
  buildBuiltinProfile,
  buildBuiltinProfiles,
  CHAT_PROFILE_NAME,
  DEFAULT_PROFILE_NAME,
  type AgentProfile,
  type BuiltinProfileSpec
} from '@shuvix/agent-runtime'

import extDefaultEn from '../builtinAgents/md/default.md?raw'
import extDefaultZh from '../builtinAgents/md/default.zh.md?raw'
import extDefaultJa from '../builtinAgents/md/default.ja.md?raw'
import extChatEn from '../builtinAgents/md/chat.md?raw'
import extChatZh from '../builtinAgents/md/chat.zh.md?raw'
import extChatJa from '../builtinAgents/md/chat.ja.md?raw'

const LANGUAGES = ['en', 'zh', 'ja']

/** 与 subAgent.ts 的 EXTENSION_*_SPEC 同形（那边够不到：import 图带 chrome.*） */
const SPECS: Record<string, BuiltinProfileSpec> = {
  [DEFAULT_PROFILE_NAME]: {
    name: DEFAULT_PROFILE_NAME,
    sources: { en: extDefaultEn, zh: extDefaultZh, ja: extDefaultJa }
  },
  [CHAT_PROFILE_NAME]: {
    name: CHAT_PROFILE_NAME,
    sources: { en: extChatEn, zh: extChatZh, ja: extChatJa }
  }
}

/** 扩展副本 */
const ext = (name: string, language: string): AgentProfile => {
  const built = buildBuiltinProfile(SPECS[name], { language })
  expect(built, `扩展 ${name}.${language} 应解析成合法档案`).not.toBeNull()
  return built!
}

/** 共享版（桌面用的那一份） */
const shared = (name: string, language: string): AgentProfile =>
  buildBuiltinProfiles({ language }).find((a) => a.name === name)!

const placeholders = (text: string): string[] =>
  [...new Set(text.match(/\{\{[^}]+\}\}/g) ?? [])].sort()

describe('扩展端基座档案 — 结构字段与共享版对齐', () => {
  it('六份 md 都解析成合法档案（frontmatter 写坏即整份被拒，档案会静默消失）', () => {
    for (const name of [DEFAULT_PROFILE_NAME, CHAT_PROFILE_NAME]) {
      for (const language of LANGUAGES) {
        const built = ext(name, language)
        expect(built.name, `${name}.${language}`).toBe(name)
        expect(built.description.length, `${name}.${language}`).toBeGreaterThan(0)
        expect(built.systemPrompt.length, `${name}.${language}`).toBeGreaterThan(0)
      }
    }
  })

  it('name / 会话感知 / 指令文件 / 项目感知与共享版逐项相等（displayName 与描述允许各说各话）', () => {
    for (const name of [DEFAULT_PROFILE_NAME, CHAT_PROFILE_NAME]) {
      for (const language of LANGUAGES) {
        const a = ext(name, language)
        const b = shared(name, language)
        expect(
          {
            name: a.name,
            sessionAwareness: a.sessionAwareness,
            instructionFiles: a.instructionFiles,
            projectAwareness: a.projectAwareness
          },
          `${name}.${language}`
        ).toEqual({
          name: b.name,
          sessionAwareness: b.sessionAwareness,
          instructionFiles: b.instructionFiles,
          projectAwareness: b.projectAwareness
        })
      }
    }
  })

  it('语言切换不改变结构字段（工具面/注入开关只该在 en 文件里定义一次）', () => {
    for (const name of [DEFAULT_PROFILE_NAME, CHAT_PROFILE_NAME]) {
      const en = ext(name, 'en')
      for (const language of ['zh', 'ja']) {
        const loc = ext(name, language)
        expect(loc.tools, `${name}.${language} tools`).toEqual(en.tools)
        expect(loc.instructionFiles, `${name}.${language}`).toEqual(en.instructionFiles)
        expect(loc.projectAwareness, `${name}.${language}`).toBe(en.projectAwareness)
        expect(loc.sessionAwareness, `${name}.${language}`).toBe(en.sessionAwareness)
      }
    }
  })

  it('各语言文件的 {{...}} 占位符集合与 en 完全一致（漏改/误译 = 变量失效）', () => {
    for (const [name, spec] of Object.entries(SPECS)) {
      const expected = placeholders(spec.sources.en)
      for (const [language, source] of Object.entries(spec.sources)) {
        expect(placeholders(source), `${name}.${language}`).toEqual(expected)
      }
    }
  })
})

describe('扩展端基座档案 — 两条路线在这一端只差工作目录形态', () => {
  it('chat 与 default 的工具面完全相等（扩展没有 shell、也没有子会话可分工）', () => {
    const chatTools = ext(CHAT_PROFILE_NAME, 'en').tools
    expect(chatTools).toEqual(ext(DEFAULT_PROFILE_NAME, 'en').tools)
    // 正控制组：清单非空，否则上面那条在两边都为空时也成立
    expect(chatTools.length).toBeGreaterThan(0)
    // 扩展没有这些能力，一份从共享档案抄过来的清单会带上它们
    for (const gone of ['session', 'skill', 'preview', 'git']) {
      expect(chatTools, `扩展档案不该持有 ${gone}`).not.toContain(gone)
    }
  })

  it('三语正文都不出现派发/子会话词汇 —— 这一端连 session 工具都没有', () => {
    const HANDOFF = ['coding', 'sub-session', '子会话', 'サブセッション']
    for (const name of [DEFAULT_PROFILE_NAME, CHAT_PROFILE_NAME]) {
      for (const language of LANGUAGES) {
        const body = ext(name, language).systemPrompt
        for (const term of HANDOFF) {
          expect(body, `扩展 ${name}.${language} 不应出现 ${term}`).not.toContain(term)
        }
      }
    }
  })
})
