/**
 * 隐藏项目的判定 —— `isHiddenProjectId` 与它的注册表那一半 `isRegistryNoteProjectId`。
 *
 * 隐藏项目只承载笔记本会话：旧 wiki、知识库 v2，以及 bot / agent / 安全策略 / 工作流四个注册表
 * 目录。宿主的项目列表过滤（projectService）与 UI 的日历圆点（CalendarView）共用这一份判定 ——
 * 日历那一侧**只有这里**有覆盖。漏认一个 id，打开一份 bot md 就会让一个没人认得的项目冒进
 * 项目列表、在日历上点出一个圆点。
 *
 * id 是整串比较的常量：不 trim、不忽略大小写、不认前缀 —— 形似的输入一律不算。
 */
import { describe, expect, it } from 'vitest'
import { isHiddenProjectId } from './hiddenProjects'
import { isRegistryNoteProjectId, REGISTRY_NOTE_PROJECT_IDS } from './registryNotes'
import { KNOWLEDGE_PROJECT_ID } from './knowledge'
import { WIKI_PROJECT_ID } from './wiki'

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
  it('HP-1 id 表逐项钉死：四个值互不相同，也不与 wiki / 知识库的隐藏项目 id 撞车', () => {
    // 这些 id 是写进数据库的项目行主键：改一个字，已有的笔记本会话就从它的承载项目里掉出去。
    // 撞车更糟 —— 两个目录共用一行项目，path 自愈会让它在两个目录之间来回改写
    expect(REGISTRY_NOTE_PROJECT_IDS).toEqual({
      bot: '__bots__',
      agent: '__agents__',
      policy: '__policies__',
      workflow: '__workflows__'
    })
    expect(new Set(REGISTRY_IDS).size).toBe(4)
    for (const id of REGISTRY_IDS) {
      expect(id).not.toBe(WIKI_PROJECT_ID)
      expect(id).not.toBe(KNOWLEDGE_PROJECT_ID)
    }
  })

  it('HP-2 isRegistryNoteProjectId：四个注册表 id 为真；wiki / 知识库 id 与形似输入一律为假', () => {
    // wiki 与知识库也是隐藏项目，但不是注册表目录 —— 两个谓词各答各的问题
    for (const id of REGISTRY_IDS) expect(isRegistryNoteProjectId(id), label(id)).toBe(true)
    for (const id of [WIKI_PROJECT_ID, KNOWLEDGE_PROJECT_ID, ...LOOKALIKES]) {
      expect(isRegistryNoteProjectId(id), label(id)).toBe(false)
    }
  })

  it('HP-3 isHiddenProjectId：wiki、知识库与每个注册表 id 为真；形似输入为假（日历圆点唯一的覆盖）', () => {
    // 遍历表里的值而不是再抄一遍字面量：往表里加第五个注册表时，这条自动把它算进来
    for (const id of [WIKI_PROJECT_ID, KNOWLEDGE_PROJECT_ID, ...REGISTRY_IDS]) {
      expect(isHiddenProjectId(id), label(id)).toBe(true)
    }
    for (const id of LOOKALIKES) expect(isHiddenProjectId(id), label(id)).toBe(false)
  })
})
