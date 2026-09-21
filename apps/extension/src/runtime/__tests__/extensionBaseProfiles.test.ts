/**
 * 扩展端两份基座档案（work / chat）的钉板 —— 它们是共享 `builtinAgents/md/` 的**手抄
 * 副本**，没有任何机制保证跟着共享档案走。
 *
 * 副本存在的理由：共享的两份点名了 bash / ssh / glob / grep / ls / 子会话这些扩展没有的
 * 东西，直接用会误导 Agent。但代价是漂移无声 —— 最危险的一种是把桌面 `work` 新增的
 * 「交给子会话去做」整节同步过来：扩展根本没有 `session` 工具，模型会照着提示词调一个
 * 不存在的动作。故这里钉五样：
 *   - **结构字段与共享版逐项相等**（name / 指令文件 / 项目感知）；
 *   - **六份 md 都不带退役的 `shuvix-session-awareness`**：这个键随会话内切换档案一并退役，
 *     副本是用户「创建覆盖副本」的样板，样板里留一行死键等于教用户去写它；
 *   - **六份 md 都不提 mermaid**（NM-3）：结构图也改成了手画 ```svg，共享版改掉那句时副本
 *     不会跟着改；
 *   - **两份副本的工具面完全相等** —— 桌面上两条路线差在「自己干 vs 交给 coding 子会话」，
 *     扩展既没有 shell 也没有子会话，两份文案只该差工作目录形态（项目文件夹 vs 隔离临时
 *     目录）。工具面一旦分叉，「项目会话 work / 无项目会话 chat」这条形态推导在两端就不再
 *     指同一件事；
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
  WORK_PROFILE_NAME,
  type AgentProfile
} from '@shuvix/agent-runtime'
import {
  createInlineMdReader,
  createInlineMdReaderFrom
} from '@shuvix/agent-runtime/builtinAgents/inlineSources'

const LANGUAGES = ['en', 'zh', 'ja']

/** 扩展自己那批浏览器变体 md（与 subAgent.ts 同一个 glob —— 那边够不到：import 图带 chrome.*） */
const EXT_MD_SOURCES = import.meta.glob('../builtinAgents/md/*.md', {
  query: '?raw',
  import: 'default',
  eager: true
}) as Record<string, string>

/** 文件名 → 原文（`work.zh.md` / `chat.md`），逐份断言时按它取原文 */
const extSource = (name: string, language: string): string => {
  const suffix = language === 'en' ? '' : `.${language}`
  const hit = Object.entries(EXT_MD_SOURCES).find(([path]) => path.endsWith(`/${name}${suffix}.md`))
  expect(hit, `扩展 ${name}.${language} 的 md 应存在`).toBeTruthy()
  return hit![1]
}

const EXT_MD = createInlineMdReaderFrom(EXT_MD_SOURCES)
const SHARED_MD = createInlineMdReader()

/** 扩展副本 */
const ext = (name: string, language: string): AgentProfile => {
  const built = buildBuiltinProfile({ name }, { language, readMd: EXT_MD })
  expect(built, `扩展 ${name}.${language} 应解析成合法档案`).not.toBeNull()
  return built!
}

/** 共享版（桌面用的那一份） */
const shared = (name: string, language: string): AgentProfile =>
  buildBuiltinProfiles({ language, readMd: SHARED_MD }).find((a) => a.name === name)!

const placeholders = (text: string): string[] =>
  [...new Set(text.match(/\{\{[^}]+\}\}/g) ?? [])].sort()

describe('扩展端基座档案 — 结构字段与共享版对齐', () => {
  it('六份 md 都解析成合法档案（frontmatter 写坏即整份被拒，档案会静默消失）', () => {
    for (const name of [WORK_PROFILE_NAME, CHAT_PROFILE_NAME]) {
      for (const language of LANGUAGES) {
        const built = ext(name, language)
        expect(built.name, `${name}.${language}`).toBe(name)
        expect(built.description.length, `${name}.${language}`).toBeGreaterThan(0)
        expect(built.systemPrompt.length, `${name}.${language}`).toBeGreaterThan(0)
      }
    }
  })

  it('name / 指令文件 / 项目感知与共享版逐项相等（displayName 与描述允许各说各话）', () => {
    for (const name of [WORK_PROFILE_NAME, CHAT_PROFILE_NAME]) {
      for (const language of LANGUAGES) {
        const a = ext(name, language)
        const b = shared(name, language)
        expect(
          {
            name: a.name,
            instructionFiles: a.instructionFiles,
            projectAwareness: a.projectAwareness
          },
          `${name}.${language}`
        ).toEqual({
          name: b.name,
          instructionFiles: b.instructionFiles,
          projectAwareness: b.projectAwareness
        })
      }
    }
  })

  it('六份 md 都不带退役的 shuvix-session-awareness', () => {
    for (const name of [WORK_PROFILE_NAME, CHAT_PROFILE_NAME]) {
      for (const language of LANGUAGES) {
        expect(extSource(name, language), `${name}.${language}`).not.toContain(
          'shuvix-session-awareness'
        )
      }
    }
  })

  it('NM-3 六份 md 原文里都没有 mermaid —— 结构图也手画 ```svg，副本不该还教旧写法', () => {
    // 副本是手抄的，共享版删掉 mermaid 那句时没有任何机制把这边一起改掉。
    // 份数钉死为 6（work / chat × 三语）：glob 若一份都没扫到，下面那圈恒绿
    const sources = Object.entries(EXT_MD_SOURCES)
    expect(sources).toHaveLength(6)
    for (const [path, text] of sources) {
      expect(text, path).not.toMatch(/mermaid/i)
    }
  })

  it('语言切换不改变结构字段（工具面/注入开关只该在 en 文件里定义一次）', () => {
    for (const name of [WORK_PROFILE_NAME, CHAT_PROFILE_NAME]) {
      const en = ext(name, 'en')
      for (const language of ['zh', 'ja']) {
        const loc = ext(name, language)
        expect(loc.tools, `${name}.${language} tools`).toEqual(en.tools)
        expect(loc.instructionFiles, `${name}.${language}`).toEqual(en.instructionFiles)
        expect(loc.projectAwareness, `${name}.${language}`).toBe(en.projectAwareness)
      }
    }
  })

  it('各语言文件的 {{...}} 占位符集合与 en 完全一致（漏改/误译 = 变量失效）', () => {
    for (const name of [WORK_PROFILE_NAME, CHAT_PROFILE_NAME]) {
      const expected = placeholders(extSource(name, 'en'))
      for (const language of LANGUAGES) {
        expect(placeholders(extSource(name, language)), `${name}.${language}`).toEqual(expected)
      }
    }
  })

  it('扩展 work 三语 description 都点名 "work"、不再提 "default"（覆盖提示指向正确的文件名）', () => {
    for (const language of LANGUAGES) {
      const desc = ext(WORK_PROFILE_NAME, language).description
      expect(desc, `work.${language}`).toContain('work')
      expect(desc, `work.${language}`).not.toContain('default')
    }
  })
})

describe('扩展端基座档案 — 两条路线在这一端只差工作目录形态', () => {
  it('chat 与 work 的工具面完全相等（扩展没有 shell、也没有子会话可分工）', () => {
    const chatTools = ext(CHAT_PROFILE_NAME, 'en').tools
    expect(chatTools).toEqual(ext(WORK_PROFILE_NAME, 'en').tools)
    // 正控制组：清单非空，否则上面那条在两边都为空时也成立
    expect(chatTools.length).toBeGreaterThan(0)
    // 扩展没有这些能力，一份从共享档案抄过来的清单会带上它们
    for (const gone of ['session', 'skill', 'git']) {
      expect(chatTools, `扩展档案不该持有 ${gone}`).not.toContain(gone)
    }
  })

  it('三语正文都不出现派发/子会话词汇 —— 这一端连 session 工具都没有', () => {
    const HANDOFF = ['coding', 'sub-session', '子会话', 'サブセッション']
    for (const name of [WORK_PROFILE_NAME, CHAT_PROFILE_NAME]) {
      for (const language of LANGUAGES) {
        const body = ext(name, language).systemPrompt
        for (const term of HANDOFF) {
          expect(body, `扩展 ${name}.${language} 不应出现 ${term}`).not.toContain(term)
        }
      }
    }
  })
})
