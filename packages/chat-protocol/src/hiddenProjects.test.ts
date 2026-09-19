/**
 * 隐藏项目的判定 —— `isHiddenProjectId`，以及它合并的两个谓词：注册表的 `isRegistryNoteProjectId`、
 * 知识库的 `isKnowledgeProjectId`。
 *
 * 隐藏项目只承载笔记本会话：知识库的三个承载项目（项目库 / 用户库 / 内置库），以及 bot / agent /
 * 内置 agent（随包发布，只读）/ 安全策略 / hook 五个注册表目录。宿主的项目列表过滤（projectService）与 UI 的日历圆点（CalendarView）共用这一份判定 ——
 * 日历那一侧**只有这里**有覆盖。漏认一个 id，打开一份 bot md 就会让一个没人认得的项目冒进
 * 项目列表、在日历上点出一个圆点。
 *
 * id 是整串比较的常量：不 trim、不忽略大小写、不认前缀 —— 形似的输入一律不算。
 */
import { describe, expect, it } from 'vitest'
import { isHiddenProjectId } from './hiddenProjects'
import {
  isReadOnlyRegistryNoteProjectId,
  isRegistryNoteProjectId,
  REGISTRY_NOTE_PROJECT_IDS
} from './registryNotes'
import {
  isKnowledgeProjectId,
  KNOWLEDGE_BUILTIN_PROJECT_ID,
  KNOWLEDGE_PROJECT_ID,
  KNOWLEDGE_USER_PROJECT_ID
} from './knowledge'

type MaybeId = string | null | undefined

const REGISTRY_IDS = Object.values(REGISTRY_NOTE_PROJECT_IDS)

/** 形似却不是的输入：空值三种、少字符、大小写、首尾空白、kind 名本身、一个普通项目的 uuid */
const LOOKALIKES: MaybeId[] = [
  null,
  undefined,
  '',
  '__bots',
  '__BOTS__',
  ' __bots__',
  '__bots__ ',
  'bot',
  '01923f6e-5b7a-7c3d-8e9f-0a1b2c3d4e5f'
]

/** 断言消息里看得见首尾空白与 null / undefined */
const label = (id: MaybeId): string => (id === undefined ? 'undefined' : JSON.stringify(id))

describe('隐藏项目 id —— REGISTRY_NOTE_PROJECT_IDS / isRegistryNoteProjectId / isHiddenProjectId', () => {
  it('HP-1 id 表逐项钉死：五个值互不相同，也不与知识库的隐藏项目 id 撞车', () => {
    // 这些 id 是写进数据库的项目行主键：改一个字，已有的笔记本会话就从它的承载项目里掉出去。
    // 撞车更糟 —— 两个目录共用一行项目，path 自愈会让它在两个目录之间来回改写
    expect(REGISTRY_NOTE_PROJECT_IDS).toEqual({
      bot: '__bots__',
      agent: '__agents__',
      // 内置 agent 档案随包发布在应用包里：与用户档案分开一个承载项目 —— 承载项目的 path
      // 决定 notebookPath 相对哪个根解析，两个根共用一行就得改存量会话的路径
      agentBuiltin: '__agents_builtin__',
      policy: '__policies__',
      hook: '__hooks__'
    })
    expect(new Set(REGISTRY_IDS).size).toBe(5)
    for (const id of REGISTRY_IDS) {
      expect(id).not.toBe(KNOWLEDGE_PROJECT_ID)
      expect(id).not.toBe(KNOWLEDGE_USER_PROJECT_ID)
    }
  })

  it('HP-2 isRegistryNoteProjectId：五个注册表 id 为真；知识库 id 与形似输入一律为假', () => {
    // 知识库的承载项目也是隐藏项目，但不是注册表目录 —— 两个谓词各答各的问题
    for (const id of REGISTRY_IDS) expect(isRegistryNoteProjectId(id), label(id)).toBe(true)
    for (const id of [KNOWLEDGE_PROJECT_ID, KNOWLEDGE_USER_PROJECT_ID, ...LOOKALIKES]) {
      expect(isRegistryNoteProjectId(id), label(id)).toBe(false)
    }
  })

  it('HP-3 isHiddenProjectId：知识库与每个注册表 id 为真；形似输入为假（日历圆点唯一的覆盖）', () => {
    // 遍历表里的值而不是再抄一遍字面量：往表里加第五个注册表时，这条自动把它算进来
    for (const id of [KNOWLEDGE_PROJECT_ID, KNOWLEDGE_USER_PROJECT_ID, ...REGISTRY_IDS]) {
      expect(isHiddenProjectId(id), label(id)).toBe(true)
    }
    for (const id of LOOKALIKES) expect(isHiddenProjectId(id), label(id)).toBe(false)
  })
})

describe('只读的注册表笔记 —— isReadOnlyRegistryNoteProjectId', () => {
  it('HP-5 只有 `__agents_builtin__` 为真；其余注册表 / 知识库承载项目与形似输入一律为假', () => {
    // 这个谓词决定笔记本给不给输入卡片、编辑器可不可写。放宽一格，用户的 bot / 档案 / 策略 /
    // hook 就整片变成只能看；收紧一格，随包发布的内置档案就能被改 —— 改了下次更新照样被覆盖，
    // macOS 上还会破坏应用签名
    expect(isReadOnlyRegistryNoteProjectId(REGISTRY_NOTE_PROJECT_IDS.agentBuiltin)).toBe(true)

    const notReadOnly: MaybeId[] = [
      ...REGISTRY_IDS.filter((id) => id !== REGISTRY_NOTE_PROJECT_IDS.agentBuiltin),
      KNOWLEDGE_PROJECT_ID,
      KNOWLEDGE_USER_PROJECT_ID,
      // 内置知识库也是只读的，但那一头由 knowledge 自己的判定管，不从这个谓词走
      KNOWLEDGE_BUILTIN_PROJECT_ID,
      ...LOOKALIKES,
      '__agents_builtin',
      '__AGENTS_BUILTIN__',
      ' __agents_builtin__'
    ]
    for (const id of notReadOnly) {
      expect(isReadOnlyRegistryNoteProjectId(id), label(id)).toBe(false)
    }
    // 只读的那个仍然是注册表笔记、也仍然是隐藏项目 —— 三个谓词各答各的问题，不互相取代
    expect(isRegistryNoteProjectId(REGISTRY_NOTE_PROJECT_IDS.agentBuiltin)).toBe(true)
    expect(isHiddenProjectId(REGISTRY_NOTE_PROJECT_IDS.agentBuiltin)).toBe(true)
  })
})

describe('知识库承载项目 id —— isKnowledgeProjectId', () => {
  it('HP-4 只认三个知识库承载项目（id 按字面钉死）；每个注册表 id 与形似输入一律为假', () => {
    // 这个谓词不只喂隐藏项目过滤，笔记本属性卡的 okf 兜底也靠它。兜底那头最怕放宽 —— 认进 `__bots__`
    // 这类 id，bot / agent / 策略 / hook 笔记本里暂时没有自述行的 md 就会被套上一张知识库条目卡
    for (const id of ['__knowledge__', '__knowledge_user__']) {
      expect(isKnowledgeProjectId(id), label(id)).toBe(true)
    }
    for (const id of [...REGISTRY_IDS, ...LOOKALIKES, '__knowledge_user', '__KNOWLEDGE__']) {
      expect(isKnowledgeProjectId(id), label(id)).toBe(false)
    }
  })
})
