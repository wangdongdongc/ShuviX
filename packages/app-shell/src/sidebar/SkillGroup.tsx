/**
 * SkillGroup —— 侧栏的「技能」分组。一个技能是**目录**（`SKILL.md` + `references/` 那些伴随
 * 文件），所以这一组比智能体那组多一层：
 *
 *   - **目录成行、可折叠**：内置目录置顶（锁徽标、只读），其后是用户添加的外部目录；
 *   - **默认目录（`~/.shuvix/skills/`）不占一行**，它的技能直接平铺在最后 —— 它是「你自己的
 *     技能」的那一摞，和智能体那组的用户档案同一副样子，多包一层文件夹只是多一次点击。
 *
 * 顺序由宿主给（内置 → 外部目录 → 默认），这里只按 `isDefault` 决定「画不画那行文件夹」。
 *
 * 点任一行技能 = 打开 / 复用它 `SKILL.md` 的**笔记本会话**（内置那份只读）—— 与 Bots、智能体
 * 档案、知识库条目同一条路。技能比它们多一样东西：**启用开关**（单个技能 + 整个目录两级）。
 * 开关收在右键 / ⋮ 菜单里，禁用的行划线表示（与被覆盖的智能体行同一副样子）——
 * 侧栏每行常驻一个控件与这里的语汇不符。
 *
 * prop 驱动、不触宿主 API：清单 / 打开 / 开关 / 增删目录 / 删除技能由宿主注入。扫描是懒的：
 * 首次展开才扫，之后展开 + 窗口聚焦 + `skill.changed` 事件重扫，stale-guard 防乱序回包。
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { FolderClosed, FolderOpen, Lock } from 'lucide-react'
import { useAppEvent, useChatStore } from '@shuvix/chat-ui'
import {
  SKILL_BUILTIN_PROJECT_ID,
  SKILL_DEFAULT_PROJECT_ID,
  isSkillProjectId,
  skillExternalProjectId,
  skillNotebookPath
} from '@shuvix/chat-protocol/skillNotes'
import type { ContextMenuItem } from '@shuvix/chat-protocol/types/contextMenu'
import { SessionGroup } from './SessionGroup'
import { RowMenuButton } from './RowMenuButton'
import { AnimatedCollapse } from '../common/AnimatedCollapse'
import { useFocusDim } from './useFocusDim'
import { useContextMenu } from '../contextmenu/ContextMenuProvider'

/** 分组里的一个技能 */
export interface SkillGroupItem {
  /** 技能标识：默认 / 内置目录为原名，外部目录为 `<dirName>:<skillName>` —— 宿主按它认 */
  name: string
  /** 行上显示的名字（外部技能去掉目录前缀） */
  displayName: string
  /**
   * 这个技能在磁盘上的**目录名**（`basePath` 的最后一段）。刻意由宿主给而不在这里从 `name`
   * 切：技能的 name 来自 SKILL.md frontmatter，与目录名并不总是相等，按名字推会指到一个
   * 不存在的文件上。这里只用它认「哪一行是当前开着的那份笔记」。
   */
  dirEntry: string
  /** 触发条件（行的 title 提示） */
  description: string
  isEnabled: boolean
}

/** 一个技能目录 */
export interface SkillGroupFolder {
  /** 目录名（默认目录固定 `default`，内置固定 `builtin`，外部是用户取的名字） */
  dirName: string
  dirPath: string
  /** 默认目录：**不画文件夹行**，技能平铺在最后 */
  isDefault: boolean
  /** 内置目录：只读（不能移除、里面的技能不能删） */
  isBuiltin: boolean
  /** 整组开关：关掉之后组内技能全部失效 */
  isEnabled: boolean
  skills: SkillGroupItem[]
}

/** 宿主注入的技能注册表能力（桌面：window.api.skill 的窄投影） */
export interface SkillGroupAdapter {
  /** 拉取清单，**按展示顺序**：内置 → 外部目录 → 默认目录（须为稳定引用，避免重复扫描） */
  list: () => Promise<SkillGroupFolder[]>
  /** 打开 / 复用这个技能 SKILL.md 的笔记本会话 */
  open: (skill: SkillGroupItem) => void | Promise<void>
  /** 单个技能的启用开关（回执不看：写完由宿主广播 `skill.changed`，本组照常重扫） */
  setSkillEnabled: (skill: SkillGroupItem, isEnabled: boolean) => void | Promise<unknown>
  /** 整个目录的启用开关（同上） */
  setFolderEnabled: (folder: SkillGroupFolder, isEnabled: boolean) => void | Promise<unknown>
  /** 添加一个外部技能目录（宿主负责选目录 + 取名） */
  addFolder: () => void | Promise<void>
  /** 移除一个外部技能目录（宿主自带确认框） */
  removeFolder: (folder: SkillGroupFolder) => void
  /** 删除默认目录里的一个技能（整个子目录；宿主自带确认框） */
  deleteSkill: (skill: SkillGroupItem) => void
  /** 在系统文件管理器里打开某个技能目录 */
  openFolder: (folder: SkillGroupFolder) => void | Promise<unknown>
}

export interface SkillGroupProps {
  adapter: SkillGroupAdapter
}

export function SkillGroup({ adapter }: SkillGroupProps): React.JSX.Element {
  const { t } = useTranslation()
  const { dim } = useFocusDim()
  const showContextMenu = useContextMenu()
  // 活动会话是不是某个技能的 SKILL.md 笔记本（分组头高亮 + 命中行选中态）。合成字符串键，
  // 免得选择器每次返回新对象（useChatStore 按 Object.is 比较）
  const activeNote = useChatStore((s) => {
    const active = s.sessions.find((x) => x.id === s.activeSessionId)
    if (!isSkillProjectId(active?.projectId)) return null
    const path = active?.settings.notebookPath
    return path ? `${active?.projectId}:${path}` : null
  })
  const isNoteActive = activeNote !== null

  const [collapsed, setCollapsed] = useState(true)
  /** 展开着的目录（默认全折叠 —— 一个外部目录动辄几十个技能） */
  const [openDirs, setOpenDirs] = useState<Set<string>>(() => new Set())
  const [scanned, setScanned] = useState<SkillGroupFolder[] | null>(null)
  const scannedOnce = useRef(false)
  const scanSeq = useRef(0)

  const scan = useCallback(async (): Promise<void> => {
    scannedOnce.current = true
    const seq = ++scanSeq.current
    try {
      const r = await adapter.list()
      if (seq === scanSeq.current) setScanned(r)
    } catch {
      if (seq === scanSeq.current) setScanned([])
    }
  }, [adapter])

  useEffect(() => {
    const onFocus = (): void => {
      if (scannedOnce.current) void scan()
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [scan])

  // 宿主观察到的变更（开关 / 增删目录 / 删除技能 / 经笔记本落盘的 SKILL.md 编辑）
  useAppEvent('skill.changed', () => {
    if (scannedOnce.current) void scan()
  })

  const toggle = (): void => {
    const next = !collapsed
    setCollapsed(next)
    if (!next) void scan()
  }

  const toggleDir = (dirName: string): void =>
    setOpenDirs((prev) => {
      const next = new Set(prev)
      if (next.has(dirName)) next.delete(dirName)
      else next.add(dirName)
      return next
    })

  /** 这个目录的笔记本承载项目 id（与 main 侧 skillNotes 的那张表同源） */
  const carrierIdOf = (folder: SkillGroupFolder): string =>
    folder.isDefault
      ? SKILL_DEFAULT_PROJECT_ID
      : folder.isBuiltin
        ? SKILL_BUILTIN_PROJECT_ID
        : skillExternalProjectId(folder.dirName)

  /** 这一行技能是不是当前活动的那份笔记（承载项目 + 目录内路径逐字对上） */
  const isActiveSkill = (folder: SkillGroupFolder, skill: SkillGroupItem): boolean =>
    activeNote === `${carrierIdOf(folder)}:${skillNotebookPath(skill.dirEntry)}`

  const openGroupMenu = (e: React.MouseEvent): void => {
    const def = scanned?.find((f) => f.isDefault)
    const items: ContextMenuItem[] = [
      { id: 'add-folder', label: t('settings.skillDirAdd') },
      { id: 'open-default', label: t('settings.skillOpenDir') },
      ...(def
        ? [
            {
              id: 'toggle-default',
              label: def.isEnabled ? t('common.disable') : t('common.enable')
            }
          ]
        : []),
      { type: 'separator' as const },
      { id: 'refresh', label: t('panel.filesRefresh') }
    ]
    void showContextMenu(e, items, (action) => {
      if (action === 'add-folder') void adapter.addFolder()
      if (action === 'open-default' && def) void adapter.openFolder(def)
      if (action === 'toggle-default' && def) void adapter.setFolderEnabled(def, !def.isEnabled)
      if (action === 'refresh') void scan()
    })
  }

  const openFolderMenu = (folder: SkillGroupFolder, e: React.MouseEvent): void => {
    const items: ContextMenuItem[] = [
      { id: 'toggle', label: folder.isEnabled ? t('common.disable') : t('common.enable') },
      { id: 'open', label: t('settings.skillOpenDir') },
      ...(folder.isBuiltin
        ? []
        : [{ type: 'separator' as const }, { id: 'remove', label: t('settings.skillDirRemove') }])
    ]
    void showContextMenu(e, items, (action) => {
      if (action === 'toggle') void adapter.setFolderEnabled(folder, !folder.isEnabled)
      if (action === 'open') void adapter.openFolder(folder)
      if (action === 'remove') adapter.removeFolder(folder)
    })
  }

  const openSkillMenu = (
    folder: SkillGroupFolder,
    skill: SkillGroupItem,
    e: React.MouseEvent
  ): void => {
    const items: ContextMenuItem[] = [
      { id: 'toggle', label: skill.isEnabled ? t('common.disable') : t('common.enable') },
      // 删除只对默认目录开放：外部目录是用户自己的文件夹（移除来源即可），内置随包发布
      ...(folder.isDefault
        ? [{ type: 'separator' as const }, { id: 'delete', label: t('common.delete') }]
        : [])
    ]
    void showContextMenu(e, items, (action) => {
      if (action === 'toggle') void adapter.setSkillEnabled(skill, !skill.isEnabled)
      if (action === 'delete') adapter.deleteSkill(skill)
    })
  }

  // 行的通用外壳：与 Bots / 智能体 / 知识库条目行同一副排版
  const rowClass = (active: boolean, indented: boolean): string =>
    `group relative flex items-center gap-1.5 ${indented ? 'pl-6' : 'pl-2.5'} pr-1.5 py-0.5 cursor-pointer transition-opacity duration-200 ${
      active
        ? 'bg-bg-active/80 text-text-primary'
        : `text-text-secondary hover:bg-bg-hover/50 hover:text-text-primary ${
            dim && isNoteActive ? 'opacity-30 hover:opacity-100' : ''
          }`
    }`

  const skillRow = (folder: SkillGroupFolder, skill: SkillGroupItem): React.JSX.Element => {
    // 整组关掉时组内技能一律失效 —— 行上要看得出来，否则「我明明开着」是个谜
    const off = !skill.isEnabled || !folder.isEnabled
    return (
      <div
        key={skill.name}
        data-skill-row={skill.name}
        {...(off ? { 'data-skill-off': '' } : {})}
        onClick={() => void adapter.open(skill)}
        onContextMenu={(e) => openSkillMenu(folder, skill, e)}
        title={skill.description}
        className={rowClass(isActiveSkill(folder, skill), !folder.isDefault)}
      >
        <span className={`flex-shrink-0 w-3 ${off ? 'opacity-40' : ''}`} />
        <span
          className={`flex-1 min-w-0 text-[13px] truncate group-hover:pr-5 ${off ? 'line-through opacity-60' : ''}`}
        >
          {skill.displayName}
        </span>
        <RowMenuButton
          className="absolute right-1.5 opacity-0 group-hover:opacity-100"
          onOpen={(e) => openSkillMenu(folder, skill, e)}
        />
      </div>
    )
  }

  return (
    <SessionGroup
      label={t('sidebar.skillsGroup')}
      variant="skills"
      collapsed={collapsed}
      onToggle={toggle}
      active={isNoteActive}
      dim={dim && !isNoteActive}
      onMenu={openGroupMenu}
    >
      {scanned !== null &&
        // 空态 = 连一个可画的目录行都没有，且默认目录也没有技能（外部目录哪怕是空的也占一行）
        (scanned.every((f) => f.isDefault && f.skills.length === 0) ? (
          <div className="px-3 py-2 text-xs text-text-tertiary">{t('settings.skillEmpty')}</div>
        ) : (
          <>
            {/* 目录（内置置顶 → 外部），顺序由宿主给 */}
            {scanned
              // 空目录也画行：移除入口只长在文件夹行的菜单上，把空目录藏起来就等于
              // 「加错了一个目录，从此只能手改 .config.json」。一个技能都没有的目录展开是空的，
              // 那正是它的实情（内置那组由宿主在空时整个不给，不会走到这里）
              .filter((f) => !f.isDefault)
              .map((folder) => {
                const open = openDirs.has(folder.dirName)
                return (
                  <div key={folder.dirName}>
                    <div
                      data-skill-folder={folder.dirName}
                      {...(folder.isEnabled ? {} : { 'data-skill-off': '' })}
                      onClick={() => toggleDir(folder.dirName)}
                      onContextMenu={(e) => openFolderMenu(folder, e)}
                      title={folder.dirPath}
                      className={rowClass(false, false)}
                    >
                      <span
                        className={`flex-shrink-0 text-text-tertiary ${folder.isEnabled ? '' : 'opacity-40'}`}
                      >
                        {open ? <FolderOpen size={11} /> : <FolderClosed size={11} />}
                      </span>
                      <span
                        className={`flex-1 min-w-0 text-[13px] truncate group-hover:pr-5 ${folder.isEnabled ? '' : 'line-through opacity-60'}`}
                      >
                        {folder.isBuiltin ? t('settings.skillDirBuiltin') : folder.dirName}
                      </span>
                      {folder.isBuiltin && (
                        // 与知识库内置库（ShuviX 系统说明）同一副锁：小号、淡、悬停不隐去
                        <span
                          title={t('tool.subAgentBuiltin')}
                          aria-label={t('tool.subAgentBuiltin')}
                          className="flex shrink-0 pr-1"
                        >
                          <Lock size={9} className="text-text-tertiary/50" />
                        </span>
                      )}
                      <RowMenuButton
                        className="absolute right-1.5 opacity-0 group-hover:opacity-100"
                        onOpen={(e) => openFolderMenu(folder, e)}
                      />
                    </div>
                    <AnimatedCollapse open={open}>
                      <div>{folder.skills.map((skill) => skillRow(folder, skill))}</div>
                    </AnimatedCollapse>
                  </div>
                )
              })}
            {/* 默认目录：不画文件夹行，技能平铺在最后（同智能体那组的用户档案） */}
            {scanned
              .filter((f) => f.isDefault)
              .flatMap((folder) => folder.skills.map((skill) => skillRow(folder, skill)))}
          </>
        ))}
    </SessionGroup>
  )
}
