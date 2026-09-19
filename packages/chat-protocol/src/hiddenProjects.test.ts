/**
 * 隐藏项目的判定 —— `isHiddenProjectId`，以及它合并的三个谓词：注册表的 `isRegistryNoteProjectId`、
 * 知识库的 `isKnowledgeProjectId`、技能的 `isSkillProjectId`。
 *
 * 隐藏项目只承载笔记本会话：知识库的三个承载项目（项目库 / 用户库 / 内置库），bot / agent /
 * 内置 agent（随包发布，只读）/ 安全策略 / 内置安全策略（随包发布，只读）/ hook / 内置 hook（随包发布，只读）七个注册表目录，以及技能的承载项目（默认目录 /
 * 内置目录 / 每个外部目录一个）。宿主的项目列表过滤（projectService）与 UI 的日历圆点（CalendarView）共用这一份判定 ——
 * 日历那一侧**只有这里**有覆盖。漏认一个 id，打开一份 bot md 就会让一个没人认得的项目冒进
 * 项目列表、在日历上点出一个圆点。
 *
 * 技能的三个形态在 skillNotes.test.ts 里逐条钉死，这里只钉「它们进不进这几个谓词」——
 * 三个谓词各答各的问题，认串了后果具体：`isKnowledgeProjectId` 若认进技能 id，SKILL.md
 * 打开就会被套上知识库条目卡（okf 兜底），而不是它自己那张 `skill` 卡。
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
import {
  isSkillProjectId,
  skillExternalProjectId,
  SKILL_BUILTIN_PROJECT_ID,
  SKILL_DEFAULT_PROJECT_ID
} from './skillNotes'

type MaybeId = string | null | undefined

const REGISTRY_IDS = Object.values(REGISTRY_NOTE_PROJECT_IDS)
/** 技能的三个形态：默认目录 / 内置目录 / 一个外部目录 */
const SKILL_IDS = [
  SKILL_DEFAULT_PROJECT_ID,
  SKILL_BUILTIN_PROJECT_ID,
  skillExternalProjectId('ext')
]

/**
 * 形似却不是的输入：空值三种、少字符、大小写、首尾空白、kind 名本身、一个普通项目的 uuid，
 * 外加技能那三个形似 —— 少字符的 `__skills`、缺尾的 `__skills:x`、以及空目录名拼出的
 * `__skills:__`（服务端拒空名，见 SSG-7；这里钉的是「拼出来了也不算」）
 */
const LOOKALIKES: MaybeId[] = [
  null,
  undefined,
  '',
  '__bots',
  '__BOTS__',
  ' __bots__',
  '__bots__ ',
  'bot',
  '__skills',
  '__skills:x',
  '__skills:__',
  '01923f6e-5b7a-7c3d-8e9f-0a1b2c3d4e5f'
]

/** 断言消息里看得见首尾空白与 null / undefined */
const label = (id: MaybeId): string => (id === undefined ? 'undefined' : JSON.stringify(id))

describe('隐藏项目 id —— REGISTRY_NOTE_PROJECT_IDS / isRegistryNoteProjectId / isHiddenProjectId', () => {
  it('HP-1 id 表逐项钉死：七个值互不相同，也不与知识库的隐藏项目 id 撞车', () => {
    // 这些 id 是写进数据库的项目行主键：改一个字，已有的笔记本会话就从它的承载项目里掉出去。
    // 撞车更糟 —— 两个目录共用一行项目，path 自愈会让它在两个目录之间来回改写
    expect(REGISTRY_NOTE_PROJECT_IDS).toEqual({
      bot: '__bots__',
      agent: '__agents__',
      // 内置 agent 档案随包发布在应用包里：与用户档案分开一个承载项目 —— 承载项目的 path
      // 决定 notebookPath 相对哪个根解析，两个根共用一行就得改存量会话的路径
      agentBuiltin: '__agents_builtin__',
      policy: '__policies__',
      // 内置安全策略同 agentBuiltin：随包发布、只读，与用户策略分开一个承载项目
      policyBuiltin: '__policies_builtin__',
      hook: '__hooks__',
      // 内置 hook 同理：随包发布、只读
      hookBuiltin: '__hooks_builtin__'
    })
    expect(new Set(REGISTRY_IDS).size).toBe(7)
    for (const id of REGISTRY_IDS) {
      expect(id).not.toBe(KNOWLEDGE_PROJECT_ID)
      expect(id).not.toBe(KNOWLEDGE_USER_PROJECT_ID)
    }
  })

  it('HP-2 isRegistryNoteProjectId：七个注册表 id 为真；知识库 / 技能 id 与形似输入一律为假', () => {
    // 知识库与技能的承载项目也是隐藏项目，但不是注册表目录 —— 三个谓词各答各的问题
    for (const id of REGISTRY_IDS) expect(isRegistryNoteProjectId(id), label(id)).toBe(true)
    for (const id of [
      KNOWLEDGE_PROJECT_ID,
      KNOWLEDGE_USER_PROJECT_ID,
      ...SKILL_IDS,
      ...LOOKALIKES
    ]) {
      expect(isRegistryNoteProjectId(id), label(id)).toBe(false)
    }
  })

  it('HP-3 isHiddenProjectId：知识库 / 注册表 / 技能三族 id 全为真；形似输入为假（日历圆点唯一的覆盖）', () => {
    // 遍历表里的值而不是再抄一遍字面量：往表里加第七个注册表时，这条自动把它算进来。
    // 技能那三个是这一版新加的载体（默认 / 内置 / 每个外部目录一个）——漏认一个，
    // 点开一份 SKILL.md 就会让一个没人认得的项目冒进项目列表、在日历上点出一个圆点
    for (const id of [
      KNOWLEDGE_PROJECT_ID,
      KNOWLEDGE_USER_PROJECT_ID,
      ...REGISTRY_IDS,
      ...SKILL_IDS
    ]) {
      expect(isHiddenProjectId(id), label(id)).toBe(true)
    }
    for (const id of LOOKALIKES) expect(isHiddenProjectId(id), label(id)).toBe(false)
    // 技能那一支真的是经 isSkillProjectId 进来的（而不是恰好撞上别的谓词）
    for (const id of SKILL_IDS) expect(isSkillProjectId(id), label(id)).toBe(true)
  })
})

describe('只读的注册表笔记 —— isReadOnlyRegistryNoteProjectId', () => {
  it('HP-5 只有 `__agents_builtin__` / `__policies_builtin__` / `__hooks_builtin__` 为真；其余注册表 / 知识库承载项目与形似输入一律为假', () => {
    // 这个谓词决定笔记本给不给输入卡片、编辑器可不可写。放宽一格，用户的 bot / 档案 / 策略 /
    // hook 就整片变成只能看；收紧一格，随包发布的内置档案 / 内置策略就能被改 —— 改了下次更新
    // 照样被覆盖，macOS 上还会破坏应用签名
    const READ_ONLY = [
      REGISTRY_NOTE_PROJECT_IDS.agentBuiltin,
      REGISTRY_NOTE_PROJECT_IDS.policyBuiltin,
      REGISTRY_NOTE_PROJECT_IDS.hookBuiltin
    ]
    for (const id of READ_ONLY) expect(isReadOnlyRegistryNoteProjectId(id), label(id)).toBe(true)

    const notReadOnly: MaybeId[] = [
      ...REGISTRY_IDS.filter((id) => !READ_ONLY.includes(id)),
      KNOWLEDGE_PROJECT_ID,
      KNOWLEDGE_USER_PROJECT_ID,
      // 内置知识库也是只读的，但那一头由 knowledge 自己的判定管，不从这个谓词走
      KNOWLEDGE_BUILTIN_PROJECT_ID,
      // 技能的内置载体同样只读，但那一头由 skillNotes 自己的谓词管（isReadOnlySkillProjectId）——
      // 认进这个谓词，笔记本就会按「注册表笔记」的那条路去判只读，两套判定从此可以各走各的
      ...SKILL_IDS,
      ...LOOKALIKES,
      '__agents_builtin',
      '__AGENTS_BUILTIN__',
      ' __agents_builtin__'
    ]
    for (const id of notReadOnly) {
      expect(isReadOnlyRegistryNoteProjectId(id), label(id)).toBe(false)
    }
    // 只读的那三个仍然是注册表笔记、也仍然是隐藏项目 —— 三个谓词各答各的问题，不互相取代
    for (const id of READ_ONLY) {
      expect(isRegistryNoteProjectId(id), label(id)).toBe(true)
      expect(isHiddenProjectId(id), label(id)).toBe(true)
    }
  })
})

describe('知识库承载项目 id —— isKnowledgeProjectId', () => {
  it('HP-4 只认三个知识库承载项目（id 按字面钉死）；注册表 / 技能 id 与形似输入一律为假', () => {
    // 这个谓词不只喂隐藏项目过滤，笔记本属性卡的 okf 兜底也靠它。兜底那头最怕放宽 —— 认进 `__bots__`
    // 这类 id，bot / agent / 策略 / hook 笔记本里暂时没有自述行的 md 就会被套上一张知识库条目卡。
    // 技能尤其要挡住：SKILL.md 的 frontmatter 本就没有 `shuvix:` 自述行，靠的正是笔记本传
    // `frontmatterFallbackType: 'skill'` 兜底 —— 这里放宽一格，它就先被 okf 那张卡截走
    for (const id of ['__knowledge__', '__knowledge_user__']) {
      expect(isKnowledgeProjectId(id), label(id)).toBe(true)
    }
    for (const id of [
      ...REGISTRY_IDS,
      ...SKILL_IDS,
      ...LOOKALIKES,
      '__knowledge_user',
      '__KNOWLEDGE__'
    ]) {
      expect(isKnowledgeProjectId(id), label(id)).toBe(false)
    }
  })
})
