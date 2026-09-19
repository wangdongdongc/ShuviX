/**
 * AgentGroup —— 侧栏的「智能体」分组（`~/.shuvix/agents/`）。它就是原先设置页那个「智能体」tab
 * 搬到前台的样子：一次同名裁决的全部份数一行一个 —— 内置置顶（**行首一把锁**，同名被压过时划线 +
 * 右侧「已覆盖」徽标），用户档案随后（行首留空，同名里没胜出的同样划线），解析不过的文件缀在末尾
 * 以琥珀行呈现（行首三角）。行首那一格宽度恒定：只有内置与非法行有字形，但三种行的标签落在同一
 * 条竖线上。
 *
 * 点任意一行 = 打开或复用那份 md 的**笔记本会话** —— 与 Bots、知识库条目同一条路：live-preview、
 * 外部改动自动重载，解析器的判定由属性卡实时显示。用户档案挂在隐藏项目 `__agents__` 下、可编辑
 * 且自动保存；**内置档案的 md 随包发布在应用包里**（运行时读的就是它），挂在只读载体
 * `__agents_builtin__` 下 —— 编辑器只渲染、没有输入卡片，要改就右键「创建覆盖副本」落一份
 * 同名用户文件再编辑那份。
 *
 * prop 驱动、不触宿主 API（同 BotGroup / KnowledgeGroup）：清单 / 打开 / 预览 / 新建 / 覆盖副本 /
 * 打开目录 / 删除由宿主注入。扫描是懒的：**首次展开才扫**，之后每次展开 + 窗口聚焦 +
 * `agent.changed` 事件（笔记本写入 / 新建 / 删除）重扫，stale-guard 防乱序回包；agent 自己用
 * `edit` 改 md、外部编辑器写入不广播，由聚焦重扫兜底。
 *
 * 动作全部收在菜单里（右键 / ⋮ 同一份，与会话行、Bots 行一致）—— 设置页头部那颗「创建覆盖副本」
 * 按钮在这里就是内置行右键菜单的第一项（已被覆盖时置灰：再落一份同名文件会被主进程拒绝）。
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, Lock } from 'lucide-react'
import { useAppEvent, useChatStore } from '@shuvix/chat-ui'
import { REGISTRY_NOTE_PROJECT_IDS } from '@shuvix/chat-protocol/registryNotes'
import type { ContextMenuItem } from '@shuvix/chat-protocol/types/contextMenu'
import { SessionGroup } from './SessionGroup'
import { RowMenuButton } from './RowMenuButton'
import { useFocusDim } from './useFocusDim'
import { useContextMenu } from '../contextmenu/ContextMenuProvider'

/** 分组里的一份档案（内置或用户）—— 宿主 `subAgent.list()` 的窄投影 */
export interface AgentGroupItem {
  /** frontmatter `name`：内置行的身份（它没有文件），也是按名删除 / 覆盖副本的入参 */
  name: string
  displayName: string
  description?: string
  source: 'builtin' | 'user'
  /**
   * 这份档案的 md 文件名：用户档案是 agents 目录下的文件名，内置档案是随包发布的那一份
   * （`work.zh.md` —— 由运行时那次语言回退挑中的，UI 不另挑）。
   */
  fileName: string
  /** 同名的另一份压过了它，当前不生效（只展示，不进任何运行时路径） */
  overridden?: boolean
  /** 压过它的那份用户文件的文件名 */
  overriddenBy?: string
}

/** 目录里无法解析的文件（身份是文件名 —— 它解析不出 name） */
export interface AgentGroupInvalidFile {
  fileName: string
  /** 解析器的人读拒绝理由（行的 title 提示） */
  error: string
}

/** 宿主注入的档案注册表能力（桌面：window.api.subAgent 的窄投影） */
export interface AgentGroupAdapter {
  /** 拉取注册表：一次同名裁决的全部份数 + 无法解析的文件（须为稳定引用，避免重复扫描） */
  list: () => Promise<{ agents: AgentGroupItem[]; invalid: AgentGroupInvalidFile[] }>
  /** 打开 / 复用这份用户文件的笔记本会话；title 只在新建会话时用 */
  open: (fileName: string, title?: string) => void | Promise<void>
  /** 打开 / 复用一份内置档案 md 的**只读**笔记本会话（随包发布的那一份） */
  openBuiltin: (agent: AgentGroupItem) => void | Promise<void>
  /** 按模板新建一份用户档案并打开它的笔记本 */
  create: () => void | Promise<void>
  /** 按内置档案的等价 md 落一份同名用户文件并打开它 —— 设置页那颗「创建覆盖副本」 */
  createOverride: (agent: AgentGroupItem) => void | Promise<void>
  /** 打开 agents 目录（OS 文件管理器） */
  openFolder: () => void | Promise<unknown>
  /** 删除生效的那份用户档案（宿主自带确认对话框；删掉后经 `agent.changed` 重扫） */
  delete: (agent: AgentGroupItem) => void
  /** 按文件名删除：解析不过的、以及同名里被遮蔽的那几份（按名删会删到生效的那份） */
  deleteFile: (fileName: string) => void
}

export interface AgentGroupProps {
  adapter: AgentGroupAdapter
}

/** 展示顺序：内置始终置顶（同设置页），组内保持后端的排序 —— 同名的几份本就挨着 */
function orderAgents(list: AgentGroupItem[]): AgentGroupItem[] {
  return [...list.filter((a) => a.source === 'builtin'), ...list.filter((a) => a.source === 'user')]
}

export function AgentGroup({ adapter }: AgentGroupProps): React.JSX.Element {
  const { t } = useTranslation()
  const { dim } = useFocusDim()
  const showContextMenu = useContextMenu()
  // 活动会话是不是某份档案 md 的笔记本（分组头高亮 + 命中行选中态）。两个载体项目：用户档案
  // 在 `__agents__`、内置档案在只读的 `__agents_builtin__` —— 合成一个字符串键，免得选择器
  // 每次返回新对象（useChatStore 按 Object.is 比较，返回对象会每渲染都判「变了」）
  const activeNote = useChatStore((s) => {
    const active = s.sessions.find((x) => x.id === s.activeSessionId)
    const pid = active?.projectId
    if (pid !== REGISTRY_NOTE_PROJECT_IDS.agent && pid !== REGISTRY_NOTE_PROJECT_IDS.agentBuiltin) {
      return null
    }
    const file = active?.settings.notebookPath
    return file ? `${pid}:${file}` : null
  })
  const isNoteActive = activeNote !== null
  /** 这一行是不是当前活动的那份笔记（按载体项目 + 文件名认） */
  const isActiveNote = (builtin: boolean, fileName: string): boolean =>
    activeNote ===
    `${builtin ? REGISTRY_NOTE_PROJECT_IDS.agentBuiltin : REGISTRY_NOTE_PROJECT_IDS.agent}:${fileName}`

  const [collapsed, setCollapsed] = useState(true)
  const [scanned, setScanned] = useState<{
    agents: AgentGroupItem[]
    invalid: AgentGroupInvalidFile[]
  } | null>(null)
  // 是否扫过（聚焦 / 事件重扫只在首次展开后生效）
  const scannedOnce = useRef(false)
  // 递增序号丢弃过期回包（聚焦 / 事件 / 手动刷新并发时只认最后一次）
  const scanSeq = useRef(0)

  const scan = useCallback(async (): Promise<void> => {
    scannedOnce.current = true
    const seq = ++scanSeq.current
    try {
      const r = await adapter.list()
      if (seq === scanSeq.current) setScanned(r)
    } catch {
      if (seq === scanSeq.current) setScanned({ agents: [], invalid: [] })
    }
  }, [adapter])

  useEffect(() => {
    const onFocus = (): void => {
      if (scannedOnce.current) void scan()
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [scan])

  // 宿主观察到的变更（笔记本写入 / 新建 / 覆盖副本 / 删除）—— 改名就发生在同一个窗口的笔记本里，
  // 等不到「切窗口」这一下；没展开过就不扫，下次展开自然会扫
  useAppEvent('agent.changed', () => {
    if (scannedOnce.current) void scan()
  })

  const toggle = (): void => {
    const next = !collapsed
    setCollapsed(next)
    if (!next) void scan()
  }

  /** 打开一份用户档案 / 非法文件的笔记（已经是活动的那份就别重复开） */
  const openFile = (fileName: string, title?: string): void => {
    if (isActiveNote(false, fileName)) return
    void adapter.open(fileName, title)
  }

  const openGroupMenu = (e: React.MouseEvent): void => {
    const items: ContextMenuItem[] = [
      { id: 'new-agent', label: t('sidebar.newAgent') },
      { id: 'open-folder', label: t('tool.subAgentOpenFolder') },
      { type: 'separator' },
      { id: 'refresh', label: t('panel.filesRefresh') }
    ]
    void showContextMenu(e, items, (action) => {
      if (action === 'new-agent') void adapter.create()
      if (action === 'open-folder') void adapter.openFolder()
      if (action === 'refresh') void scan()
    })
  }

  /** 内置行：设置页头部那颗按钮的新家。已被同名用户档案覆盖时置灰 —— 再落一份会被主进程拒绝 */
  const openBuiltinMenu = (agent: AgentGroupItem, e: React.MouseEvent): void => {
    const items: ContextMenuItem[] = [
      {
        id: 'create-override',
        label: t('tool.subAgentCreateOverride'),
        enabled: !agent.overridden
      }
    ]
    void showContextMenu(e, items, (action) => {
      if (action === 'create-override') void adapter.createOverride(agent)
    })
  }

  /** 生效的那份用户档案：按名删（删掉后同名内置自动恢复生效） */
  const openUserMenu = (agent: AgentGroupItem, e: React.MouseEvent): void => {
    void showContextMenu(e, [{ id: 'delete-agent', label: t('sidebar.deleteAgent') }], (action) => {
      if (action === 'delete-agent') adapter.delete(agent)
    })
  }

  /** 非法行与同名里被遮蔽的行共用：它们都只能按文件名删 */
  const openFileMenu = (fileName: string, e: React.MouseEvent): void => {
    void showContextMenu(e, [{ id: 'delete-agent-file', label: t('common.delete') }], (action) => {
      if (action === 'delete-agent-file') adapter.deleteFile(fileName)
    })
  }

  // 行的通用外壳：与 Bots / 知识库条目行同一副排版（10px 基准内缩、13px、选中态 bg-bg-active）。
  // 标签直接是行的子节点而不包一层 div —— 侧栏 e2e 按「div > span.truncate」认会话行，别撞上
  const rowClass = (active: boolean): string =>
    `group relative flex items-center gap-1.5 pl-2.5 pr-1.5 py-0.5 cursor-pointer transition-opacity duration-200 ${
      active
        ? 'bg-bg-active/80 text-text-primary'
        : `text-text-secondary hover:bg-bg-hover/50 hover:text-text-primary ${
            dim && isNoteActive ? 'opacity-30 hover:opacity-100' : ''
          }`
    }`

  return (
    <SessionGroup
      label={t('sidebar.agentsGroup')}
      variant="agents"
      collapsed={collapsed}
      onToggle={toggle}
      active={isNoteActive}
      dim={dim && !isNoteActive}
      onMenu={openGroupMenu}
    >
      {scanned !== null && (
        <>
          {orderAgents(scanned.agents).map((a) => {
            const builtin = a.source === 'builtin'
            const menu = builtin
              ? openBuiltinMenu.bind(null, a)
              : a.overridden
                ? openFileMenu.bind(null, a.fileName)
                : openUserMenu.bind(null, a)
            return (
              <div
                key={builtin ? `builtin:${a.name}` : `file:${a.fileName}`}
                {...(builtin
                  ? { 'data-agent-builtin-row': a.name }
                  : { 'data-agent-row': a.fileName })}
                {...(a.overridden ? { 'data-agent-overridden': '' } : {})}
                onClick={() =>
                  builtin
                    ? isActiveNote(true, a.fileName) || void adapter.openBuiltin(a)
                    : openFile(a.fileName, a.displayName)
                }
                onContextMenu={menu}
                title={
                  a.overridden
                    ? builtin
                      ? t('tool.subAgentOverriddenHint')
                      : t('settings.shadowedByFileHint', { file: a.overriddenBy })
                    : a.description
                }
                className={rowClass(isActiveNote(builtin, a.fileName))}
              >
                {/* 行首那一格：内置挂锁（= 这行只能看，要改先建覆盖副本），用户档案留空 ——
                    宽度照挂，好让两种行的标签落在同一条竖线上 */}
                <span
                  title={builtin ? t('tool.subAgentBuiltin') : undefined}
                  className={`flex-shrink-0 w-3 flex items-center justify-center text-text-tertiary ${
                    a.overridden ? 'opacity-50' : ''
                  }`}
                >
                  {builtin && <Lock size={10} />}
                </span>
                <span
                  className={`flex-1 min-w-0 text-[13px] truncate group-hover:pr-5 ${
                    a.overridden ? 'line-through opacity-60' : ''
                  }`}
                >
                  {a.displayName}
                </span>
                {a.overridden && (
                  <span className="flex-shrink-0 px-1 rounded text-[9px] bg-bg-secondary text-text-tertiary group-hover:invisible">
                    {t('tool.subAgentOverridden')}
                  </span>
                )}
                <RowMenuButton
                  className="absolute right-1.5 opacity-0 group-hover:opacity-100"
                  onOpen={menu}
                />
              </div>
            )
          })}
          {/* 无法解析的文件：不可用也不遮蔽内置，但必须可见 —— 否则写坏的档案就这么消失了 */}
          {scanned.invalid.map((f) => (
            <div
              key={f.fileName}
              data-agent-invalid-row={f.fileName}
              onClick={() => openFile(f.fileName)}
              onContextMenu={(e) => openFileMenu(f.fileName, e)}
              title={f.error}
              className={rowClass(isActiveNote(false, f.fileName))}
            >
              <span className="flex-shrink-0 w-3 flex items-center justify-center">
                <AlertTriangle size={11} className="text-amber-500" />
              </span>
              <span className="flex-1 min-w-0 text-[12px] font-mono truncate group-hover:pr-5">
                {f.fileName}
              </span>
              <RowMenuButton
                className="absolute right-1.5 opacity-0 group-hover:opacity-100"
                onOpen={(e) => openFileMenu(f.fileName, e)}
              />
            </div>
          ))}
        </>
      )}
    </SessionGroup>
  )
}
