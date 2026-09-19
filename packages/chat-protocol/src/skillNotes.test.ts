/**
 * 技能笔记的承载项目 id —— 纯代数，没有任何 IO。
 *
 * 这四个导出是「点侧栏技能行 → 打开哪条笔记本会话」两端共用的唯一算法：main 侧
 * （services/skillNotes）据它插项目行、查会话、级联删；渲染侧（SkillGroup）据它认「哪一行是
 * 当前开着的那份笔记」。两端各算各的，中间没有对账口 —— 一旦这里的字面量或判定漂了，表现是
 * 「点了没反应」或「高亮错行」，两种都不会报错。
 *
 * 技能比其它注册表多一层麻烦：外部目录**数量不定、名字由用户取**，所以承载 id 只能按目录名
 * 现拼（`__skills:<name>__`）。于是这一组盯的是两件事：三个形态的 id 互不相撞、也不与知识库 /
 * 注册表那八个隐藏项目撞车（撞了就是两个载体共用一行项目，path 自愈会让它在两个根之间来回
 * 改写存量会话的落点）；以及 `isSkillProjectId` 只认整串、不 trim、不忽略大小写。
 */
import { describe, expect, it } from 'vitest'
import {
  SKILL_BUILTIN_PROJECT_ID,
  SKILL_DEFAULT_PROJECT_ID,
  isReadOnlySkillProjectId,
  isSkillProjectId,
  skillExternalProjectId,
  skillNotebookPath
} from './skillNotes'
import { isHiddenProjectId } from './hiddenProjects'
import { REGISTRY_NOTE_PROJECT_IDS } from './registryNotes'
import {
  KNOWLEDGE_BUILTIN_PROJECT_ID,
  KNOWLEDGE_PROJECT_ID,
  KNOWLEDGE_USER_PROJECT_ID
} from './knowledge'

type MaybeId = string | null | undefined

const REGISTRY_IDS = Object.values(REGISTRY_NOTE_PROJECT_IDS)
const KNOWLEDGE_IDS = [
  KNOWLEDGE_PROJECT_ID,
  KNOWLEDGE_USER_PROJECT_ID,
  KNOWLEDGE_BUILTIN_PROJECT_ID
]

/** 断言消息里看得见首尾空白与 null / undefined */
const label = (id: MaybeId): string => (id === undefined ? 'undefined' : JSON.stringify(id))

/** 形似却不是的输入：空值三种、少字符、大小写、首尾空白、缺尾、裸词、一个普通项目的 uuid */
const LOOKALIKES: MaybeId[] = [
  null,
  undefined,
  '',
  '__skills',
  '__SKILLS__',
  ' __skills__',
  '__skills__ ',
  '__skills:abc',
  'skills',
  '01923f6e-5b7a-7c3d-8e9f-0a1b2c3d4e5f'
]

describe('技能承载项目 id —— 三种形态', () => {
  it('SN-1 id 按字面钉死，且与知识库 / 注册表的隐藏项目两两不撞', () => {
    // 这些是写进数据库的项目行主键：改一个字，已有的技能笔记就从它的承载项目里掉出去；
    // 与别的隐藏项目撞车更糟 —— 两个载体共用一行，path 自愈会在两个根之间来回改写
    expect(SKILL_DEFAULT_PROJECT_ID).toBe('__skills__')
    expect(SKILL_BUILTIN_PROJECT_ID).toBe('__skills_builtin__')
    expect(skillExternalProjectId('x')).toBe('__skills:x__')

    const all = [
      SKILL_DEFAULT_PROJECT_ID,
      SKILL_BUILTIN_PROJECT_ID,
      skillExternalProjectId('x'),
      ...REGISTRY_IDS,
      ...KNOWLEDGE_IDS
    ]
    expect(new Set(all).size).toBe(all.length)
  })

  it('SN-2 isSkillProjectId 认三种形态；形似输入一律为假（整串比较，不 trim、不忽略大小写）', () => {
    for (const id of [
      SKILL_DEFAULT_PROJECT_ID,
      SKILL_BUILTIN_PROJECT_ID,
      skillExternalProjectId('ext'),
      skillExternalProjectId('a'),
      // 目录名里带下划线 / 冒号形状的怪名字照样是外部目录（准入在服务端，判定在这里只看形状）
      skillExternalProjectId('my_dir'),
      skillExternalProjectId('__')
    ]) {
      expect(isSkillProjectId(id), label(id)).toBe(true)
    }
    for (const id of LOOKALIKES) expect(isSkillProjectId(id), label(id)).toBe(false)
  })

  it('SN-3 [钉现状] 空目录名拼得出 id，但那个 id 不被认作技能项目（服务端已拒空名）', () => {
    // 代数事实：前缀 + `__` 长度恰好不够，落在「有尾却没内容」的缝里。后果是那一行隐藏载体
    // 会冒进项目列表与日历 —— 真正的闸门在 skillService.addExternalDir（SSG-7），这里只记事实
    expect(skillExternalProjectId('')).toBe('__skills:__')
    expect(isSkillProjectId('__skills:__')).toBe(false)
    expect(isHiddenProjectId('__skills:__')).toBe(false)
  })

  it('SN-4 isReadOnlySkillProjectId 只对内置为真；它仍是技能项目、仍是隐藏项目', () => {
    // 这个谓词决定笔记本给不给输入卡片、编辑器可不可写。放宽一格，用户自己的技能就整片
    // 变成只能看；收紧一格，随包发布的内置技能就能被改 —— 下次更新照样被覆盖，macOS 上还会
    // 破坏应用签名
    expect(isReadOnlySkillProjectId(SKILL_BUILTIN_PROJECT_ID)).toBe(true)

    const notReadOnly: MaybeId[] = [
      SKILL_DEFAULT_PROJECT_ID,
      skillExternalProjectId('ext'),
      skillExternalProjectId('builtin'),
      ...KNOWLEDGE_IDS,
      ...REGISTRY_IDS,
      ...LOOKALIKES,
      '__skills_builtin',
      '__SKILLS_BUILTIN__',
      ' __skills_builtin__'
    ]
    for (const id of notReadOnly) expect(isReadOnlySkillProjectId(id), label(id)).toBe(false)

    // 三个谓词各答各的问题，不互相取代
    expect(isSkillProjectId(SKILL_BUILTIN_PROJECT_ID)).toBe(true)
    expect(isHiddenProjectId(SKILL_BUILTIN_PROJECT_ID)).toBe(true)
  })
})

describe('技能笔记的 notebookPath', () => {
  it('SN-5 逐字拼「目录名 + /SKILL.md」：不归一化、无前导 /', () => {
    // 一个技能是目录而不是单文件，所以 notebookPath 天然带一层子路径（同知识库条目）。
    // 它是查重键（sessionDao.findByProjectAndNotebookPath），做任何归一都会让存量会话查不到
    expect(skillNotebookPath('drawing')).toBe('drawing/SKILL.md')
    expect(skillNotebookPath('my dir')).toBe('my dir/SKILL.md')
    expect(skillNotebookPath('我的技能')).toBe('我的技能/SKILL.md')
    expect(skillNotebookPath('dot.name')).toBe('dot.name/SKILL.md')
    expect(skillNotebookPath('drawing').startsWith('/')).toBe(false)
  })
})

describe('外部目录名 ↔ 承载 id', () => {
  it('SN-6 一一对应：形状相近的目录名拼出的 id 互不相等', () => {
    // 拼法若换成「去掉尾巴」或「按下划线切」，这几对就会塌成同一个 id —— 两个外部目录
    // 于是共用一行承载项目，移除其一会把另一个的笔记会话一并级联删掉
    const names = ['a', 'a_', 'a__', '_', '__', 'a:b', 'ab', 'A']
    const ids = names.map(skillExternalProjectId)
    expect(new Set(ids).size).toBe(names.length)
    expect(skillExternalProjectId('a__')).not.toBe(skillExternalProjectId('a'))
    expect(skillExternalProjectId('_')).not.toBe(skillExternalProjectId(''))
  })
})
