/**
 * PolicyGroup —— 侧栏的「安全策略」分组（`~/.shuvix/policies/`）。它就是原先设置页那个「安全策略」
 * tab 搬到前台的样子，与 AgentGroup 同一副骨架：内置置顶（**行首一把锁**，同名被压过时划线 +
 * 右侧「已覆盖」徽标），用户策略随后（行首留空，同名里没胜出的同样划线），解析不过的文件缀在
 * 末尾以琥珀行呈现（行首三角，font-mono 文件名，title 是解析器的拒绝理由）。行首那一格宽度恒定：
 * 只有内置与非法行有字形，三种行的标签落在同一条竖线上。
 *
 * 点任意一行 = 打开或复用那份 md 的**笔记本会话** —— 与 Bots、智能体、知识库条目同一条路：
 * live-preview、自动保存、外部改动重载，解析器的判定由属性卡实时显示（规则摘要 / effect 徽章都在
 * 卡片上，评估跟着列表走）。用户策略挂在隐藏项目 `__policies__` 下、可编辑且自动保存；
 * **内置策略的 md 随包发布在应用包里**（`Resources/builtin-policies/`，运行时读的就是它），
 * 挂在只读载体 `__policies_builtin__` 下 —— 编辑器只渲染、没有输入卡片，要改就右键
 * 「创建覆盖副本」落一份同名用户文件再编辑那份（已被覆盖时该项置灰）。
 *
 * prop 驱动、不触宿主 API（同 AgentGroup / BotGroup）：清单 / 打开 / 新建 / 覆盖副本 / 打开目录 /
 * 删除由宿主注入。扫描是懒的：**首次展开才扫**，之后每次展开 + 窗口聚焦 + `policy.changed` 事件
 * （笔记本写入 / 新建 / 删除）重扫，stale-guard 防乱序回包；外部编辑器写入不广播，由聚焦重扫兜底。
 *
 * 动作全部收在菜单里（右键 / ⋮ 同一份，与会话行、智能体行一致）。删除的确认框在宿主：
 * 生效的用户策略按名删（删掉后同名内置自动恢复生效），被遮蔽的与非法行按文件名删
 * （按名删会删到生效的那份）。
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

/** 分组里的一份策略（内置或用户）—— 宿主 `policy.list()` 的窄投影 */
export interface PolicyGroupItem {
  /** frontmatter `name`：内置行按名寻址（覆盖副本的入参），也是同名裁决的身份 */
  name: string
  displayName: string
  description?: string
  source: 'builtin' | 'user'
  /**
   * 这份策略的 md 文件名：用户策略是 policies 目录下的文件名，内置策略是随包发布的那一份
   * （`ask-on-write.zh.md` —— 由运行时那次语言回退挑中的，UI 不另挑）。
   */
  fileName: string
  /** 同名的另一份压过了它，当前不生效（只展示，不进任何运行时路径） */
  overridden?: boolean
  /** 压过它的那份用户文件的文件名 */
  overriddenBy?: string
}

/** 目录里无法解析的文件（身份是文件名 —— 它解析不出 name；不生效也不遮蔽内置同名策略） */
export interface PolicyGroupInvalidFile {
  fileName: string
  /** 解析器的人读拒绝理由（行的 title 提示） */
  error: string
}

/** 宿主注入的策略注册表能力（桌面：window.api.policy 的窄投影） */
export interface PolicyGroupAdapter {
  /** 拉取注册表：一次同名裁决的全部份数 + 无法解析的文件（须为稳定引用，避免重复扫描） */
  list: () => Promise<{ policies: PolicyGroupItem[]; invalid: PolicyGroupInvalidFile[] }>
  /** 打开 / 复用这份用户文件的笔记本会话；title 只在新建会话时用 */
  open: (fileName: string, title?: string) => void | Promise<void>
  /** 打开 / 复用一份内置策略 md 的**只读**笔记本会话（随包发布的那一份） */
  openBuiltin: (policy: PolicyGroupItem) => void | Promise<void>
  /** 按模板新建一份用户策略并打开它的笔记本 */
  create: () => void | Promise<void>
  /** 按内置策略的等价 md 落一份同名用户文件并打开它 —— 设置页那颗「创建覆盖副本」 */
  createOverride: (policy: PolicyGroupItem) => void | Promise<void>
  /** 打开 policies 目录（OS 文件管理器） */
  openFolder: () => void | Promise<unknown>
  /** 删除生效的那份用户策略（宿主自带确认对话框；删掉后经 `policy.changed` 重扫） */
  delete: (policy: PolicyGroupItem) => void
  /** 按文件名删除：解析不过的、以及同名里被遮蔽的那几份（按名删会删到生效的那份） */
  deleteFile: (fileName: string) => void
}

export interface PolicyGroupProps {
  adapter: PolicyGroupAdapter
}

/** 展示顺序：内置始终置顶（同设置页），组内保持后端的排序 —— 同名的几份本就挨着 */
function orderPolicies(list: PolicyGroupItem[]): PolicyGroupItem[] {
  return [...list.filter((p) => p.source === 'builtin'), ...list.filter((p) => p.source === 'user')]
}

export function PolicyGroup({ adapter }: PolicyGroupProps): React.JSX.Element {
  const { t } = useTranslation()
  const { dim } = useFocusDim()
  const showContextMenu = useContextMenu()
  // 活动会话是不是某份策略 md 的笔记本（分组头高亮 + 命中行选中态）。两个载体项目：用户策略
  // 在 `__policies__`、内置策略在只读的 `__policies_builtin__` —— 合成一个字符串键，免得选择器
  // 每次返回新对象（useChatStore 按 Object.is 比较，返回对象会每渲染都判「变了」）
  const activeNote = useChatStore((s) => {
    const active = s.sessions.find((x) => x.id === s.activeSessionId)
    const pid = active?.projectId
    if (
      pid !== REGISTRY_NOTE_PROJECT_IDS.policy &&
      pid !== REGISTRY_NOTE_PROJECT_IDS.policyBuiltin
    ) {
      return null
    }
    const file = active?.settings.notebookPath
    return file ? `${pid}:${file}` : null
  })
  const isNoteActive = activeNote !== null
  /** 这一行是不是当前活动的那份笔记（按载体项目 + 文件名认） */
  const isActiveNote = (builtin: boolean, fileName: string): boolean =>
    activeNote ===
    `${builtin ? REGISTRY_NOTE_PROJECT_IDS.policyBuiltin : REGISTRY_NOTE_PROJECT_IDS.policy}:${fileName}`

  const [collapsed, setCollapsed] = useState(true)
  const [scanned, setScanned] = useState<{
    policies: PolicyGroupItem[]
    invalid: PolicyGroupInvalidFile[]
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
      if (seq === scanSeq.current) setScanned({ policies: [], invalid: [] })
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
  useAppEvent('policy.changed', () => {
    if (scannedOnce.current) void scan()
  })

  const toggle = (): void => {
    const next = !collapsed
    setCollapsed(next)
    if (!next) void scan()
  }

  /** 打开一份用户策略 / 非法文件的笔记（已经是活动的那份就别重复开） */
  const openFile = (fileName: string, title?: string): void => {
    if (isActiveNote(false, fileName)) return
    void adapter.open(fileName, title)
  }

  const openGroupMenu = (e: React.MouseEvent): void => {
    const items: ContextMenuItem[] = [
      { id: 'new-policy', label: t('sidebar.newPolicy') },
      { id: 'open-folder', label: t('settings.policyOpenFolder') },
      { type: 'separator' },
      { id: 'refresh', label: t('panel.filesRefresh') }
    ]
    void showContextMenu(e, items, (action) => {
      if (action === 'new-policy') void adapter.create()
      if (action === 'open-folder') void adapter.openFolder()
      if (action === 'refresh') void scan()
    })
  }

  /** 内置行：设置页头部那颗按钮的新家。已被同名用户策略覆盖时置灰 —— 再落一份会被主进程拒绝 */
  const openBuiltinMenu = (policy: PolicyGroupItem, e: React.MouseEvent): void => {
    const items: ContextMenuItem[] = [
      {
        id: 'create-override',
        label: t('tool.subAgentCreateOverride'),
        enabled: !policy.overridden
      }
    ]
    void showContextMenu(e, items, (action) => {
      if (action === 'create-override') void adapter.createOverride(policy)
    })
  }

  /** 生效的那份用户策略：按名删（删掉后同名内置自动恢复生效） */
  const openUserMenu = (policy: PolicyGroupItem, e: React.MouseEvent): void => {
    void showContextMenu(
      e,
      [{ id: 'delete-policy', label: t('sidebar.deletePolicy') }],
      (action) => {
        if (action === 'delete-policy') adapter.delete(policy)
      }
    )
  }

  /** 非法行与同名里被遮蔽的行共用：它们都只能按文件名删 */
  const openFileMenu = (fileName: string, e: React.MouseEvent): void => {
    void showContextMenu(e, [{ id: 'delete-policy-file', label: t('common.delete') }], (action) => {
      if (action === 'delete-policy-file') adapter.deleteFile(fileName)
    })
  }

  // 行的通用外壳：与 Bots / 智能体 / 知识库条目行同一副排版（10px 基准内缩、13px、选中态
  // bg-bg-active）。标签直接是行的子节点而不包一层 div —— 侧栏 e2e 按「div > span.truncate」
  // 认会话行，别撞上
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
      label={t('sidebar.policiesGroup')}
      variant="policies"
      collapsed={collapsed}
      onToggle={toggle}
      active={isNoteActive}
      dim={dim && !isNoteActive}
      onMenu={openGroupMenu}
    >
      {scanned !== null && (
        <>
          {orderPolicies(scanned.policies).map((p) => {
            const builtin = p.source === 'builtin'
            const menu = builtin
              ? openBuiltinMenu.bind(null, p)
              : p.overridden
                ? openFileMenu.bind(null, p.fileName)
                : openUserMenu.bind(null, p)
            return (
              <div
                key={builtin ? `builtin:${p.name}` : `file:${p.fileName}`}
                {...(builtin
                  ? { 'data-policy-builtin-row': p.name }
                  : { 'data-policy-row': p.fileName })}
                {...(p.overridden ? { 'data-policy-overridden': '' } : {})}
                onClick={() =>
                  builtin
                    ? isActiveNote(true, p.fileName) || void adapter.openBuiltin(p)
                    : openFile(p.fileName, p.displayName)
                }
                onContextMenu={menu}
                title={
                  p.overridden
                    ? builtin
                      ? t('settings.policyOverriddenHint')
                      : t('settings.shadowedByFileHint', { file: p.overriddenBy })
                    : p.description
                }
                className={rowClass(isActiveNote(builtin, p.fileName))}
              >
                {/* 行首那一格：内置挂锁（= 这行只能看，要改先建覆盖副本），用户策略留空 ——
                    宽度照挂，好让两种行的标签落在同一条竖线上 */}
                <span
                  title={builtin ? t('settings.policySourceBuiltin') : undefined}
                  className={`flex-shrink-0 w-3 flex items-center justify-center text-text-tertiary ${
                    p.overridden ? 'opacity-50' : ''
                  }`}
                >
                  {builtin && <Lock size={10} />}
                </span>
                <span
                  className={`flex-1 min-w-0 text-[13px] truncate group-hover:pr-5 ${
                    p.overridden ? 'line-through opacity-60' : ''
                  }`}
                >
                  {p.displayName}
                </span>
                {p.overridden && (
                  <span className="flex-shrink-0 px-1 rounded text-[9px] bg-bg-secondary text-text-tertiary group-hover:invisible">
                    {t('settings.policyOverridden')}
                  </span>
                )}
                <RowMenuButton
                  className="absolute right-1.5 opacity-0 group-hover:opacity-100"
                  onOpen={menu}
                />
              </div>
            )
          })}
          {/* 无法解析的文件：不生效也不遮蔽内置，但必须可见 —— 否则写坏的策略就这么消失了 */}
          {scanned.invalid.map((f) => (
            <div
              key={f.fileName}
              data-policy-invalid-row={f.fileName}
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
