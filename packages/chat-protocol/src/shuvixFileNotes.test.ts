/**
 * 「这条笔记本会话的文档是哪一种 ShuviX 文件」—— `shuvixFileKindOfProject`，以及「哪几种由宿主拿真解析器
 * 判定」的那份名单 `PARSED_SHUVIX_FILE_KINDS` / `isParsedShuvixFileKind`。
 *
 * 判定按**承载项目**，不按文件里的 `shuvix:` 标记（见 shuvixFileNotes.ts 文件头）：会话挂在哪个隐藏目录
 * 从建起就不变，那个目录决定宿主拿它当什么用。两处读这份判定 —— 笔记本 agent 的
 * `{{shuvix:documentKind}}` 与会话的隐式说明书 `shuvix` —— 口径必须一致，所以这里把映射逐条钉死。
 *
 *   FK-1 七个注册表载体逐条：bot / agent（含内置）/ policy（含内置）/ hook（含内置）
 *   FK-2 技能的三个形态（默认 / 内置 / 外部目录，含共用目录 claude）→ skill；知识库三个载体 → knowledge
 *   FK-3 不是 ShuviX 文件的：空值、日报、跟踪项、普通项目、形似输入、kind 名本身 → null
 *   FK-4 守护：全部隐藏载体里，只有日报 / 跟踪项没有种类；有种类的一定是隐藏项目 ——
 *        将来新加一个隐藏载体却没决定它算不算 ShuviX 文件，这条先红
 *   FK-5 宿主真解析的恰是 agent / bot / policy / hook 四种
 *
 * id 是整串比较的常量：不 trim、不忽略大小写、不认前缀（与 hiddenProjects.test 同口径）。
 */
import { describe, expect, it } from 'vitest'
import {
  isParsedShuvixFileKind,
  PARSED_SHUVIX_FILE_KINDS,
  shuvixFileKindOfProject,
  type ShuvixFileKind
} from './shuvixFileNotes'
import { REGISTRY_NOTE_PROJECT_IDS } from './registryNotes'
import {
  KNOWLEDGE_BUILTIN_PROJECT_ID,
  KNOWLEDGE_PROJECT_ID,
  KNOWLEDGE_USER_PROJECT_ID
} from './knowledge'
import {
  skillExternalProjectId,
  SKILL_BUILTIN_PROJECT_ID,
  SKILL_DEFAULT_PROJECT_ID
} from './skillNotes'
import { DAILY_PROJECT_ID } from './dailyNotes'
import { TRACKING_PROJECT_ID } from './trackingNotes'
import { isHiddenProjectId } from './hiddenProjects'

type MaybeId = string | null | undefined

/** 断言消息里看得见首尾空白与 null / undefined */
const label = (id: MaybeId): string => (id === undefined ? 'undefined' : JSON.stringify(id))

/** 技能的承载项目：默认 / 内置 / 一个外部目录 / 共用目录（claude 套外部目录的拼法） */
const SKILL_IDS = [
  SKILL_DEFAULT_PROJECT_ID,
  SKILL_BUILTIN_PROJECT_ID,
  skillExternalProjectId('ext'),
  skillExternalProjectId('claude')
]
const KNOWLEDGE_IDS = [
  KNOWLEDGE_PROJECT_ID,
  KNOWLEDGE_USER_PROJECT_ID,
  KNOWLEDGE_BUILTIN_PROJECT_ID
]

describe('shuvixFileKindOfProject —— 承载项目 → 文件种类', () => {
  it.each([
    ['__bots__', 'bot'],
    ['__agents__', 'agent'],
    ['__agents_builtin__', 'agent'],
    ['__policies__', 'policy'],
    ['__policies_builtin__', 'policy'],
    ['__hooks__', 'hook'],
    ['__hooks_builtin__', 'hook']
  ] as Array<[string, ShuvixFileKind]>)(
    'FK-1 注册表载体 %s → %s（内置的只读载体归回本类）',
    (id, kind) => {
      expect(shuvixFileKindOfProject(id)).toBe(kind)
    }
  )

  it('FK-1 表驱动的自检：上面那七个恰是 REGISTRY_NOTE_PROJECT_IDS 的全部值（表里加一个，这里得补一行）', () => {
    expect(Object.values(REGISTRY_NOTE_PROJECT_IDS).sort()).toEqual(
      [
        '__agents__',
        '__agents_builtin__',
        '__bots__',
        '__hooks__',
        '__hooks_builtin__',
        '__policies__',
        '__policies_builtin__'
      ].sort()
    )
    // 每一个注册表载体都有种类 —— 漏一个，那个目录的笔记本就拿不到说明、也不隐式启用说明书
    for (const id of Object.values(REGISTRY_NOTE_PROJECT_IDS)) {
      expect(shuvixFileKindOfProject(id), id).not.toBeNull()
    }
  })

  it('FK-2 技能的四种载体 → skill；知识库的三个载体（项目库 / 用户库 / 内置库）→ knowledge', () => {
    for (const id of SKILL_IDS) expect(shuvixFileKindOfProject(id), id).toBe('skill')
    for (const id of KNOWLEDGE_IDS) expect(shuvixFileKindOfProject(id), id).toBe('knowledge')
  })

  it('FK-3 不是 ShuviX 文件 → null：空值、日报、跟踪项、普通项目、形似输入、kind 名本身', () => {
    const notShuvixFiles: MaybeId[] = [
      null,
      undefined,
      '',
      // 日报、跟踪项是用户自己的笔记：宿主不按什么格式解析它们
      DAILY_PROJECT_ID,
      TRACKING_PROJECT_ID,
      '01923f6e-5b7a-7c3d-8e9f-0a1b2c3d4e5f',
      '__bots',
      '__BOTS__',
      ' __bots__',
      'bot',
      '__skills',
      '__skills:x',
      '__skills:__',
      'policy',
      'skill'
    ]
    for (const id of notShuvixFiles) expect(shuvixFileKindOfProject(id), label(id)).toBeNull()
  })

  it('FK-4 守护：全部隐藏载体里，种类为 null ⇔ 日报 / 跟踪项；有种类的一定是隐藏项目', () => {
    // 隐藏载体的并集（与 hiddenProjects.ts 的五个谓词一一对应）。新加一个隐藏载体时把它补进来：
    // 它要么有种类，要么像日报 / 跟踪项一样是用户自己的笔记 —— 两者都得是有意的决定
    const hidden = [
      ...Object.values(REGISTRY_NOTE_PROJECT_IDS),
      ...KNOWLEDGE_IDS,
      ...SKILL_IDS,
      DAILY_PROJECT_ID,
      TRACKING_PROJECT_ID
    ]
    const userNotes = new Set([DAILY_PROJECT_ID, TRACKING_PROJECT_ID])
    // 正控制组：并集里的每一个确实都是隐藏项目 —— 否则下面那圈说的不是「全部隐藏载体」
    for (const id of hidden) expect(isHiddenProjectId(id), id).toBe(true)
    for (const id of hidden) {
      const kind = shuvixFileKindOfProject(id)
      expect(kind === null, id).toBe(userNotes.has(id))
      if (kind !== null) expect(isHiddenProjectId(id), id).toBe(true)
    }
    // 反向：普通项目（不隐藏）一定没有种类
    expect(isHiddenProjectId('proj-1')).toBe(false)
    expect(shuvixFileKindOfProject('proj-1')).toBeNull()
  })
})

describe('PARSED_SHUVIX_FILE_KINDS / isParsedShuvixFileKind —— 宿主拿真解析器判定的那几种', () => {
  it('FK-5 恰是 agent / bot / policy / hook；技能、知识库与其它输入一律为假', () => {
    expect([...PARSED_SHUVIX_FILE_KINDS].sort()).toEqual(['agent', 'bot', 'hook', 'policy'])
    for (const kind of ['agent', 'bot', 'policy', 'hook']) {
      expect(isParsedShuvixFileKind(kind), kind).toBe(true)
    }
    // skill / knowledge 是 ShuviX 文件，但宿主不拿解析器判它们（没有「能不能解析」可报）
    for (const kind of ['skill', 'knowledge', null, undefined, '', 'memory', 'AGENT', ' agent']) {
      expect(isParsedShuvixFileKind(kind), label(kind)).toBe(false)
    }
  })
})
