import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowUpCircle } from 'lucide-react'
import { getChatApi, useChatStore } from '@shuvix/chat-ui'
import { REGISTRY_NOTE_PROJECT_IDS } from '@shuvix/chat-protocol/registryNotes'
import { isSkillProjectId } from '@shuvix/chat-protocol/skillNotes'
import {
  Sidebar as SharedSidebar,
  AgentGroup,
  type AgentGroupAdapter,
  PolicyGroup,
  type PolicyGroupAdapter,
  BotGroup,
  type BotGroupAdapter,
  KnowledgeGroup,
  type KnowledgeGroupAdapter,
  SkillGroup,
  type SkillGroupAdapter,
  type SkillGroupFolder,
  useProjects,
  useSessionDelete,
  SessionConfigDialog
} from '@shuvix/app-shell'
import { useUpdateStore } from '../../stores/updateStore'
import { usePinChatStore } from '../../stores/pinChatStore'
import { ProjectEditDialog } from './ProjectEditDialog'
import { newAgentTemplate } from './agentTemplate'
import { newPolicyTemplate } from './policyTemplate'
import { SkillDirDialog } from './SkillDirDialog'
import { ConfirmDialog } from '../common/ConfirmDialog'
import { fileNameOf, uniqueName } from '../common/registryFiles'

/**
 * 桌面侧边栏 —— 薄封装共享 <Sidebar>，注入桌面专属能力：
 *   - 窗口拖拽 / 置顶徽标 / 分享·Telegram 徽标（caps）
 *   - 打开文件夹走 Electron 目录对话框；置顶会话选中时聚焦悬浮窗
 *   - 会话/分组右键菜单由共享组件统一渲染（桌面经 ContextMenuProvider 注入原生渲染器）
 *   - 会话配置弹窗、项目编辑弹窗
 *   - Bots 置顶分组（BotGroup 经 groupsPrepend 注入，接 window.api.bot.*；点行开 / 复用该文件的
 *     笔记本会话，删除的确认框在这里）+ 智能体档案置顶分组（AgentGroup，接 window.api.subAgent.*；
 *     用户档案点行开可编辑的笔记本，内置档案点行开**随包发布那份 md 的只读笔记本**，右键才是
 *     「创建覆盖副本」）+ 安全策略置顶分组（PolicyGroup，接 window.api.policy.*；用户策略点行开
 *     可编辑的笔记本，内置策略点行开**随包发布那份 md 的只读笔记本**，右键才是「创建覆盖副本」）
 *     + 技能置顶分组（SkillGroup，接 window.api.skill.*；目录成行、默认目录的
 *     技能平铺，点行开那个技能 SKILL.md 的笔记本，启用开关与增删在菜单里）+ 知识库置顶分组
 *     （KnowledgeGroup，接 window.api.knowledge.*，点行开 / 复用条目的笔记本会话）
 *   - 底部更新提示。侧栏只有项目视图 —— 日历已迁至右面板 Calendar tab（CalendarPanel）
 *   - 归档项目的恢复 / 删除已移至「设置 → 已归档 → 项目」
 */
export function Sidebar(): React.JSX.Element {
  const { t } = useTranslation()
  const setActiveSessionId = useChatStore((s) => s.setActiveSessionId)
  const { projects } = useProjects()
  const pinnedSessionIds = usePinChatStore((s) => s.pinnedSessionIds)
  const updateEvent = useUpdateStore((s) => s.updateEvent)
  const hasUpdate = updateEvent?.type === 'available' || updateEvent?.type === 'ready'
  const { requestDelete: handleDelete, deleteDialog } = useSessionDelete()

  const [editingProjectId, setEditingProjectId] = useState<string | null>(null)
  const [configuringSessionId, setConfiguringSessionId] = useState<string | null>(null)
  /** 待确认删除的 bot（按名删，文件名用来认出开着的笔记本）或无法解析的 bot 文件（按文件名） */
  const [confirmingBotDelete, setConfirmingBotDelete] = useState<
    { name: string; fileName: string } | { fileName: string } | null
  >(null)
  /** 待确认删除的智能体档案（按名删生效的那份）或按文件名删（非法 / 同名里被遮蔽的那份） */
  const [confirmingAgentDelete, setConfirmingAgentDelete] = useState<
    { name: string; displayName: string; fileName: string } | { fileName: string } | null
  >(null)
  /** 待确认删除的用户策略（按名删生效的那份）或按文件名删（非法 / 同名里被遮蔽的那份） */
  const [confirmingPolicyDelete, setConfirmingPolicyDelete] = useState<
    { name: string; displayName: string; fileName: string } | { fileName: string } | null
  >(null)
  /** 待确认删除的技能（整个子目录）或待移除的外部技能目录 */
  const [confirmingSkill, setConfirmingSkill] = useState<
    { kind: 'skill'; name: string } | { kind: 'dir'; dirName: string } | null
  >(null)
  /** 已选好目录、正在给它取名（添加外部技能目录的第二步） */
  const [namingSkillDir, setNamingSkillDir] = useState<string | null>(null)

  // 在指定项目下新建会话（文件夹流程用）
  const handleNewChat = async (projectId: string | null): Promise<void> => {
    const session = await getChatApi().session.create({ projectId: projectId ?? null })
    useChatStore.getState().setSessions(await getChatApi().session.list())
    setActiveSessionId(session.id)
  }

  /** 打开文件夹并创建为项目（已存在同路径则复用），随后新建会话 */
  const handleOpenFolder = async (): Promise<void> => {
    const folder = await window.electron.ipcRenderer.invoke('dialog:openDirectory')
    if (!folder) return
    const existing = (await getChatApi().project.list()).find((p) => p.path === folder)
    const projectId = existing?.id ?? (await getChatApi().project.create({ path: folder })).id
    await handleNewChat(projectId)
  }

  /** 选中会话；若已悬浮则同时把悬浮窗拉到前台 */
  const handleSelectSession = (id: string): void => {
    setActiveSessionId(id)
    if (pinnedSessionIds.has(id)) void window.api.pinChat.focus(id)
  }

  /** bots 能力注入（窄投影）—— 注入即点亮项目分组菜单里的「新建 Bot 会话」入口与 bot 单选 */
  const botsAdapter = useMemo(
    () => ({
      list: async () => (await window.api.bot.list()).bots,
      openFolder: () => window.api.bot.openFolder()
    }),
    []
  )

  /**
   * Bots 分组能力注入 —— 清单 = 合法 bot + 无法解析的文件。点一行 / 新建一份都是打开那份文件的
   * **笔记本会话**（main 侧去重，隐藏项目 `__bots__`）；「新建 Bot 会话」建的是一条**普通有根会话**
   * （`settings.bot`，根档案由形态推导成基座 `bot`）；删除先弹确认框（见 overlays），真删掉后
   * bot.changed 事件让分组重扫。引用必须稳定（useMemo）：分组以 adapter 为扫描依赖。
   */
  const botGroupAdapter = useMemo<BotGroupAdapter>(() => {
    const openNote = async (fileName: string, title?: string): Promise<void> => {
      let session: { id: string }
      try {
        session = await window.api.bot.openNote({ fileName, title })
      } catch {
        return // 文件已不在（清单过期）—— bot.changed / 聚焦重扫会把这一行拿掉
      }
      useChatStore.getState().setSessions(await getChatApi().session.list())
      setActiveSessionId(session.id)
    }
    return {
      list: () => window.api.bot.list(),
      open: openNote,
      create: async () => {
        const r = await window.api.bot.createNew()
        if (r.success && r.fileName) await openNote(r.fileName, r.name)
      },
      openFolder: () => window.api.bot.openFolder(),
      newSession: async (name) => {
        const session = await getChatApi().session.create({ projectId: null, bot: name })
        useChatStore.getState().setSessions(await getChatApi().session.list())
        setActiveSessionId(session.id)
      },
      delete: (bot) => setConfirmingBotDelete({ name: bot.name, fileName: bot.fileName }),
      deleteFile: (fileName) => setConfirmingBotDelete({ fileName })
    }
  }, [setActiveSessionId])

  /**
   * 确认删除：删掉的正是主区开着的那份文件的笔记本时顺手离开它 —— 留着接着打字，自动保存会把
   * 刚删掉的文件写回来。
   */
  const handleBotDelete = async (
    target: { name: string; fileName: string } | { fileName: string }
  ): Promise<void> => {
    setConfirmingBotDelete(null)
    const r =
      'name' in target
        ? await window.api.bot.delete({ name: target.name })
        : await window.api.bot.deleteByFile({ fileName: target.fileName })
    if (!r.success) return
    const { sessions, activeSessionId } = useChatStore.getState()
    const active = sessions.find((s) => s.id === activeSessionId)
    if (
      active?.projectId === REGISTRY_NOTE_PROJECT_IDS.bot &&
      active.settings.notebookPath === target.fileName
    ) {
      setActiveSessionId(null)
    }
  }

  /**
   * 智能体档案分组能力注入 —— 清单 = 一次同名裁决的全部份数（`subAgent.list`）+ 无法解析的文件。
   * 用户档案点一行 / 新建一份 / 建覆盖副本，落点都是那份文件的**笔记本会话**（main 侧去重，
   * 隐藏项目 `__agents__`）；内置档案的 md 随包发布在应用包里（运行时读的就是它），点行开的是
   * 它的**只读**笔记本（载体 `__agents_builtin__`，main 侧按名挑当前语言那一版）。
   * 新建与覆盖副本共用 `createSource` 这一个写入口（非法一律拒绝），建好后按名回查文件名再开笔记。
   * 删除先弹确认框（见 overlays），真删掉后 `agent.changed` 让分组重扫。
   * 引用必须稳定（useMemo）：分组以 adapter 为扫描依赖。
   */
  const agentGroupAdapter = useMemo<AgentGroupAdapter>(() => {
    /** 打开一份档案 md 的笔记本会话并选中它（用户档案与内置档案只差 main 侧那一步怎么找文件） */
    const openNoteWith = async (open: () => Promise<{ id: string }>): Promise<void> => {
      let session: { id: string }
      try {
        session = await open()
      } catch {
        return // 文件已不在（清单过期）—— agent.changed / 聚焦重扫会把这一行拿掉
      }
      useChatStore.getState().setSessions(await getChatApi().session.list())
      setActiveSessionId(session.id)
    }
    const openNote = (fileName: string, title?: string): Promise<void> =>
      openNoteWith(() => window.api.subAgent.openNote({ fileName, title }))
    /** 落一份新的用户档案并打开它：createSource 只回名字，文件名回查列表（派生时可能加了后缀） */
    const createAndOpen = async (text: string): Promise<void> => {
      const r = await window.api.subAgent.createSource({ text })
      if (!r.success || !r.name) return
      const hit = (await window.api.subAgent.list()).find(
        (a) => a.source === 'user' && a.name === r.name
      )
      if (hit) await openNote(fileNameOf(hit.basePath), hit.displayName)
    }
    return {
      list: async () => {
        const [list, invalid] = await Promise.all([
          window.api.subAgent.list(),
          window.api.subAgent.listInvalid()
        ])
        return {
          agents: list.map((a) => ({
            name: a.name,
            displayName: a.displayName || a.name,
            description: a.description,
            source: a.source,
            // 两种档案的 basePath 都是真实文件：用户的在 ~/.shuvix/agents，内置的在应用包里
            // （运行时按语言挑中的那一份）—— 行按文件名认，点行开的就是这份 md 的笔记本
            fileName: fileNameOf(a.basePath),
            ...(a.overridden ? { overridden: true } : {}),
            ...(a.overriddenBy ? { overriddenBy: a.overriddenBy } : {})
          })),
          invalid
        }
      },
      open: openNote,
      openBuiltin: (agent) =>
        openNoteWith(() =>
          window.api.subAgent.openBuiltinNote({ name: agent.name, title: agent.displayName })
        ),
      create: async () => {
        const taken = (await window.api.subAgent.list()).map((a) => a.name)
        await createAndOpen(newAgentTemplate(t, uniqueName('my-agent', taken)))
      },
      createOverride: async (agent) => {
        const r = await window.api.subAgent.getSource({ name: agent.name, source: 'builtin' })
        if ('error' in r) return
        await createAndOpen(r.text)
      },
      openFolder: () => window.api.subAgent.openFolder(),
      delete: (agent) =>
        setConfirmingAgentDelete({
          name: agent.name,
          displayName: agent.displayName,
          fileName: agent.fileName
        }),
      deleteFile: (fileName) => setConfirmingAgentDelete({ fileName })
    }
  }, [setActiveSessionId, t])

  /**
   * 确认删除档案：按名删的是生效的那份（删掉后同名内置自动恢复生效），按文件名删的是非法的 /
   * 同名里被遮蔽的那份。删掉的正是主区开着的那份文件的笔记本时顺手离开它 —— 留着接着打字，
   * 自动保存会把刚删掉的文件写回来。
   */
  const handleAgentDelete = async (
    target: { name: string; fileName: string } | { fileName: string }
  ): Promise<void> => {
    setConfirmingAgentDelete(null)
    const r =
      'name' in target
        ? await window.api.subAgent.delete({ name: target.name })
        : await window.api.subAgent.deleteByFile({ fileName: target.fileName })
    if (!r.success) return
    const { sessions, activeSessionId } = useChatStore.getState()
    const active = sessions.find((s) => s.id === activeSessionId)
    if (
      active?.projectId === REGISTRY_NOTE_PROJECT_IDS.agent &&
      active.settings.notebookPath === target.fileName
    ) {
      setActiveSessionId(null)
    }
  }

  /**
   * 安全策略分组能力注入 —— 清单 = 一次同名裁决的全部份数（`policy.list`）+ 无法解析的文件。
   * 用户策略点一行 / 新建一份 / 建覆盖副本，落点都是那份文件的**笔记本会话**（main 侧去重，
   * 隐藏项目 `__policies__`）；内置策略的 md 随包发布在应用包里（运行时读的就是它），点行开的是
   * 它的**只读**笔记本（载体 `__policies_builtin__`，main 侧按名挑当前语言那一版）。
   * 新建与覆盖副本共用 `policy.create` 这一个写入口（非法一律拒绝），建好后按名回查文件名再开笔记。
   * 删除先弹确认框（见 overlays），真删掉后 `policy.changed` 让分组重扫。
   * 引用必须稳定（useMemo）：分组以 adapter 为扫描依赖。
   */
  const policyGroupAdapter = useMemo<PolicyGroupAdapter>(() => {
    /** 打开一份策略 md 的笔记本会话并选中它（用户策略与内置策略只差 main 侧那一步怎么找文件） */
    const openNoteWith = async (open: () => Promise<{ id: string }>): Promise<void> => {
      let session: { id: string }
      try {
        session = await open()
      } catch {
        return // 文件已不在（清单过期）—— policy.changed / 聚焦重扫会把这一行拿掉
      }
      useChatStore.getState().setSessions(await getChatApi().session.list())
      setActiveSessionId(session.id)
    }
    const openNote = (fileName: string, title?: string): Promise<void> =>
      openNoteWith(() => window.api.policy.openNote({ fileName, title }))
    /** 落一份新的用户策略并打开它：create 只回名字，文件名回查列表（派生时可能加了后缀） */
    const createAndOpen = async (text: string): Promise<void> => {
      const r = await window.api.policy.create({ text })
      if (!r.success || !r.name) return
      const hit = (await window.api.policy.list()).find(
        (p) => p.source === 'user' && p.name === r.name
      )
      if (hit) await openNote(fileNameOf(hit.basePath), hit.displayName)
    }
    return {
      list: async () => {
        const [list, invalid] = await Promise.all([
          window.api.policy.list(),
          window.api.policy.listInvalid()
        ])
        return {
          policies: list.map((p) => ({
            name: p.name,
            displayName: p.displayName || p.name,
            description: p.description,
            source: p.source,
            // 两种策略的 basePath 都是真实文件：用户的在 ~/.shuvix/policies，内置的在应用包里
            // （运行时按语言挑中的那一份）—— 行按文件名认，点行开的就是这份 md 的笔记本
            fileName: fileNameOf(p.basePath),
            ...(p.overridden ? { overridden: true } : {}),
            ...(p.overriddenBy ? { overriddenBy: p.overriddenBy } : {})
          })),
          invalid
        }
      },
      open: openNote,
      openBuiltin: (policy) =>
        openNoteWith(() =>
          window.api.policy.openBuiltinNote({ name: policy.name, title: policy.displayName })
        ),
      create: async () => {
        const taken = (await window.api.policy.list()).map((p) => p.name)
        await createAndOpen(newPolicyTemplate(t, uniqueName('my-policy', taken)))
      },
      createOverride: async (policy) => {
        const r = await window.api.policy.getSource({ name: policy.name, source: 'builtin' })
        if ('error' in r) return
        await createAndOpen(r.text)
      },
      openFolder: () => window.api.policy.openFolder(),
      delete: (policy) =>
        setConfirmingPolicyDelete({
          name: policy.name,
          displayName: policy.displayName,
          fileName: policy.fileName
        }),
      deleteFile: (fileName) => setConfirmingPolicyDelete({ fileName })
    }
  }, [setActiveSessionId, t])

  /**
   * 确认删除策略：按名删的是生效的那份（删掉后同名内置自动恢复生效），按文件名删的是非法的 /
   * 同名里被遮蔽的那份。删掉的正是主区开着的那份文件的笔记本时顺手离开它 —— 留着接着打字，
   * 自动保存会把刚删掉的文件写回来。
   */
  const handlePolicyDelete = async (
    target: { name: string; fileName: string } | { fileName: string }
  ): Promise<void> => {
    setConfirmingPolicyDelete(null)
    const r =
      'name' in target
        ? await window.api.policy.delete({ name: target.name })
        : await window.api.policy.deleteByFile({ fileName: target.fileName })
    if (!r.success) return
    const { sessions, activeSessionId } = useChatStore.getState()
    const active = sessions.find((s) => s.id === activeSessionId)
    if (
      active?.projectId === REGISTRY_NOTE_PROJECT_IDS.policy &&
      active.settings.notebookPath === target.fileName
    ) {
      setActiveSessionId(null)
    }
  }

  /**
   * 项目记忆能力注入 —— 清单读盘，打开一条即打开/复用绑定它的笔记本会话（进 live-preview 直接编辑）。
   * 引用必须稳定（useMemo）：子文件夹以 adapter 为扫描依赖，每渲染新建对象会导致反复扫盘。
   */
  const memoryAdapter = useMemo(
    () => ({
      list: (projectId: string) => window.api.memory.list({ projectId }),
      open: async (projectId: string, slug: string): Promise<void> => {
        const session = await window.api.memory.openNote({ projectId, slug })
        if (!session) return // 文件已不在（清单过期）——下次聚焦/展开会重扫
        useChatStore.getState().setSessions(await getChatApi().session.list())
        setActiveSessionId(session.id)
      }
    }),
    [setActiveSessionId]
  )

  /**
   * 技能分组能力注入 —— 清单按**展示顺序**重排：内置置顶 → 用户添加的外部目录 → 默认目录
   * （分组组件按 `isDefault` 决定「画不画那行文件夹」，默认目录的技能平铺在最后）。项目级技能
   * 刻意不列：它随当前会话的项目变，而这一组是全局的，混在一起就看不出「当前生不生效」。
   * 点一行开的是那个技能 `SKILL.md` 的笔记本（main 侧按技能标识找文件、去重会话）；
   * 开关 / 增删目录 / 删除技能落回 window.api.skill.*，写完由 `skill.changed` 让本组重扫。
   * 引用必须稳定（useMemo）：分组以 adapter 为扫描依赖。
   */
  const skillGroupAdapter = useMemo<SkillGroupAdapter>(
    () => ({
      list: async () => {
        const groups = await window.api.skill.listGrouped()
        const toFolder = (g: (typeof groups)[number]): SkillGroupFolder => ({
          dirName: g.dirName,
          dirPath: g.dirPath,
          isDefault: g.isDefault,
          isBuiltin: g.dirName === 'builtin',
          isEnabled: g.isEnabled,
          skills: g.skills.map((skill) => ({
            name: skill.name,
            // 外部技能的标识带目录前缀，行上只显示技能自己的名字
            displayName: skill.name.includes(':')
              ? skill.name.slice(skill.name.indexOf(':') + 1)
              : skill.name,
            // 磁盘目录名取自 basePath —— 技能的 name 来自 SKILL.md 的 frontmatter，两者不一定相等
            dirEntry: skill.basePath.split(/[\\/]/).filter(Boolean).pop() ?? skill.name,
            description: skill.description,
            isEnabled: skill.isEnabled
          }))
        })
        const builtin = groups.filter((g) => g.dirName === 'builtin').map(toFolder)
        const external = groups
          .filter((g) => !g.isDefault && g.dirName !== 'builtin' && g.dirName !== 'project')
          .map(toFolder)
        const def = groups.filter((g) => g.isDefault).map(toFolder)
        return [...builtin, ...external, ...def]
      },
      open: async (skill) => {
        let session: { id: string }
        try {
          session = await window.api.skill.openNote({ name: skill.name, title: skill.displayName })
        } catch {
          return // 技能目录已不在（清单过期）—— skill.changed / 聚焦重扫会把这一行拿掉
        }
        useChatStore.getState().setSessions(await getChatApi().session.list())
        setActiveSessionId(session.id)
      },
      setSkillEnabled: (skill, isEnabled) =>
        window.api.skill.update({ name: skill.name, isEnabled }),
      setFolderEnabled: (folder, isEnabled) =>
        window.api.skill.setGroupEnabled({ dirName: folder.dirName, isEnabled }),
      addFolder: async () => {
        // 两步：先让 OS 选目录，再给它取名（名字会成为组内技能标识的前缀，不能重名）
        const picked = await window.api.skill.pickExternalDir()
        if (picked.success && picked.path) setNamingSkillDir(picked.path)
      },
      removeFolder: (folder) => setConfirmingSkill({ kind: 'dir', dirName: folder.dirName }),
      deleteSkill: (skill) => setConfirmingSkill({ kind: 'skill', name: skill.name }),
      openFolder: (folder) => window.api.app.openFolder(folder.dirPath)
    }),
    [setActiveSessionId]
  )

  /**
   * 确认删除技能 / 移除外部目录。删掉的正是主区开着的那份笔记时顺手离开它 —— 留着接着打字，
   * 自动保存会把刚删掉的文件写回来（移除目录时 main 侧会把那一组笔记会话一并清掉）。
   */
  const handleSkillConfirm = async (
    target: { kind: 'skill'; name: string } | { kind: 'dir'; dirName: string }
  ): Promise<void> => {
    setConfirmingSkill(null)
    if (target.kind === 'skill') await window.api.skill.deleteDefault(target.name)
    else await window.api.skill.removeExternalDir(target.dirName)
    const { sessions, activeSessionId } = useChatStore.getState()
    const active = sessions.find((s) => s.id === activeSessionId)
    if (isSkillProjectId(active?.projectId)) {
      useChatStore.getState().setSessions(await getChatApi().session.list())
      const stillThere = (await getChatApi().session.list()).some((s) => s.id === activeSessionId)
      if (!stillThere || target.kind === 'skill') setActiveSessionId(null)
    }
  }

  /**
   * 知识库分组能力注入 —— 清单（只读），打开一条即打开 / 复用绑定它的笔记本会话（main 侧去重），
   * 刷新列表并选中；三个「新建」交给 main（建目录 / 按标题派生文件名写条目）。
   * 引用必须稳定（useMemo）：分组以 adapter 为扫描依赖。
   */
  const knowledgeAdapter = useMemo<KnowledgeGroupAdapter>(
    () => ({
      list: () => window.api.knowledge.list(),
      open: async (path, title) => {
        const session = await window.api.knowledge.openNote({ path, title })
        useChatStore.getState().setSessions(await getChatApi().session.list())
        setActiveSessionId(session.id)
      },
      openFolder: () => window.api.knowledge.openFolder(),
      revealFile: (path) => window.api.knowledge.revealFile({ path }),
      // 手动新建：宿主建目录 / 写条目并广播 knowledge.changed，分组自己重扫
      createBase: (name) => window.api.knowledge.createBase({ name }),
      createFolder: (dir, name) => window.api.knowledge.createFolder({ dir, name }),
      createEntry: (dir, title) => window.api.knowledge.createEntry({ dir, title })
    }),
    [setActiveSessionId]
  )

  return (
    <SharedSidebar
      caps={{ windowDrag: true, pin: true }}
      memory={memoryAdapter}
      bots={botsAdapter}
      projects={projects}
      pinnedSessionIds={pinnedSessionIds}
      onOpenFolder={handleOpenFolder}
      onOpenSettings={(tab) => void getChatApi().app.openSettings(tab)}
      onSelectSession={handleSelectSession}
      onDeleteSession={handleDelete}
      onConfigureSession={setConfiguringSessionId}
      onEditProject={setEditingProjectId}
      footerActions={
        hasUpdate ? (
          <button
            onClick={() => void getChatApi().app.openSettings('about')}
            className="flex-shrink-0 p-1.5 rounded-md text-accent/80 hover:bg-accent/10 hover:text-accent transition-colors"
            title={
              updateEvent?.type === 'ready'
                ? t('sidebar.updateReady')
                : t('sidebar.updateAvailable')
            }
          >
            <ArrowUpCircle size={14} />
          </button>
        ) : undefined
      }
      groupsPrepend={
        <>
          <BotGroup adapter={botGroupAdapter} />
          <AgentGroup adapter={agentGroupAdapter} />
          <PolicyGroup adapter={policyGroupAdapter} />
          <SkillGroup adapter={skillGroupAdapter} />
          <KnowledgeGroup adapter={knowledgeAdapter} />
        </>
      }
      overlays={
        <>
          {editingProjectId && (
            <ProjectEditDialog
              projectId={editingProjectId}
              onClose={() => setEditingProjectId(null)}
            />
          )}
          {configuringSessionId && (
            <SessionConfigDialog
              sessionId={configuringSessionId}
              onClose={() => setConfiguringSessionId(null)}
            />
          )}
          {deleteDialog}
          {confirmingBotDelete && (
            <ConfirmDialog
              title={t('settings.botDeleteConfirmTitle')}
              description={
                'name' in confirmingBotDelete
                  ? t('settings.botDeleteConfirmDesc', { name: confirmingBotDelete.name })
                  : t('settings.botDeleteFileConfirmDesc', { name: confirmingBotDelete.fileName })
              }
              confirmText={t('common.delete')}
              cancelText={t('common.cancel')}
              onConfirm={() => void handleBotDelete(confirmingBotDelete)}
              onCancel={() => setConfirmingBotDelete(null)}
            />
          )}
          {confirmingSkill && (
            <ConfirmDialog
              title={
                confirmingSkill.kind === 'skill'
                  ? t('settings.skillDeleteConfirm', { name: confirmingSkill.name })
                  : t('settings.skillDirRemoveConfirm', { name: confirmingSkill.dirName })
              }
              confirmText={
                confirmingSkill.kind === 'skill' ? t('common.delete') : t('settings.skillDirRemove')
              }
              cancelText={t('common.cancel')}
              onConfirm={() => void handleSkillConfirm(confirmingSkill)}
              onCancel={() => setConfirmingSkill(null)}
            />
          )}
          {namingSkillDir && (
            <SkillDirDialog
              path={namingSkillDir}
              onSubmit={async (name) => {
                const r = await window.api.skill.addExternalDir({ name, path: namingSkillDir })
                return r.success ? null : (r.reason ?? 'Failed to add directory')
              }}
              onClose={() => setNamingSkillDir(null)}
            />
          )}
          {confirmingAgentDelete && (
            <ConfirmDialog
              title={t('tool.subAgentDeleteConfirmTitle')}
              description={
                'name' in confirmingAgentDelete
                  ? t('tool.subAgentDeleteConfirmDesc', {
                      name: confirmingAgentDelete.displayName
                    })
                  : t('tool.subAgentDeleteFileConfirmDesc', {
                      name: confirmingAgentDelete.fileName
                    })
              }
              confirmText={t('common.delete')}
              cancelText={t('common.cancel')}
              onConfirm={() => void handleAgentDelete(confirmingAgentDelete)}
              onCancel={() => setConfirmingAgentDelete(null)}
            />
          )}
          {confirmingPolicyDelete && (
            <ConfirmDialog
              title={t('settings.policyDeleteConfirmTitle')}
              description={
                'name' in confirmingPolicyDelete
                  ? t('settings.policyDeleteConfirmDesc', {
                      name: confirmingPolicyDelete.displayName
                    })
                  : t('settings.policyDeleteFileConfirmDesc', {
                      name: confirmingPolicyDelete.fileName
                    })
              }
              confirmText={t('common.delete')}
              cancelText={t('common.cancel')}
              onConfirm={() => void handlePolicyDelete(confirmingPolicyDelete)}
              onCancel={() => setConfirmingPolicyDelete(null)}
            />
          )}
        </>
      }
    />
  )
}
