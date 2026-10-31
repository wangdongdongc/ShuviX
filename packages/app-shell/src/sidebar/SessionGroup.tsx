/**
 * SessionGroup —— 共享会话分组，从桌面 Sidebar.renderGroupedSessions 抽出。
 *
 * 一个分组 = 标题行（可选图标 + 标签 + 悬停浮现的 ⋮）+ 正文（通常为 SessionItem 列表）。排版是 Finder 侧栏的
 * 那一套（base.css 的 .sb-row / .sb-section）：可折叠的组是一行着色图标的「位置」，摊开的是小号灰字的分节标题。
 * 六种形态：
 *   - `project`（项目，文件夹图标，可折叠）
 *   - `knowledge`（知识库置顶特殊分组，Library 图标，可折叠，正文为作用域目录树 + 条目行）
 *   - `bots`（Bots 置顶特殊分组，Users 图标，可折叠，正文为 bot 档案列表 —— 与知识库同一副
 *     排版，只换图标；不用 Bot 图标是因为它已经是聊天会话行的身份图标）
 *   - `agents`（智能体档案置顶特殊分组，Bot 图标，可折叠，正文为 agent 档案列表）—— 这里用
 *     Bot 图标正是因为它指的就是「档案」，而 Bots 那组指的是一个个有人格的对话方
 *   - `policies`（安全策略置顶特殊分组，Shield 图标 —— 与设置页那个 tab 同一个图标，可折叠，
 *     正文为策略列表：内置置顶、用户随后、解析不过的缀末尾）
 *   - `hooks`（Hook 置顶特殊分组，Webhook 图标 —— 与设置页那个 tab 同一个图标，可折叠，
 *     正文与策略同构：内置置顶、用户随后、解析不过的缀末尾）
 *   - `skills`（技能置顶特殊分组，BookOpen 图标 —— 与设置页那个 tab 同一个图标，可折叠，
 *     正文是「目录行 + 默认目录的技能平铺」两层）
 *   - `temp`（临时对话，**摊开的纯分节**：无图标、无折叠）—— 它是侧栏最常用的落点，收在
 *     一层折叠后面只是每次多一次点击，而临时会话本来就没有「这个组是什么」要交代，图标与
 *     折叠箭头都只是噪音。
 *   - `section`（分节标题，如「项目」「Bots」）—— 与 `temp` 同一副排版，差别只在正文是**别的分组**
 *     而不是会话行（见下面 bodyShift）。侧栏顶栏留给产品名之后，「项目」就是靠它与「临时
 *     对话」长成一对并列的分节。
 *   - `bot`（「Bots」分节里的一个 bot，可折叠，正文是它的会话 —— 与项目组同形，图标是 bot 的头像，
 *     由容器经 `icon` 交进来）
 * 桌面与扩展共用——扩展只用单个 temp 分组，桌面对每个项目组 + 临时组 + 知识库组各渲染一个。
 *
 * 组头**没有一排小图标**：新建对话 / 新建 Bot 会话 / 项目配置 / 知识库刷新全部收进 `onMenu`
 * 那一份菜单（右键组头与点 ⋮ 同一个入口，见 RowMenuButton）。菜单由容器组装 ——
 * 各形态能做什么本就是容器（ProjectSessionGroups / KnowledgeGroup）才知道的事。
 */
import {
  Bot,
  BookOpen,
  FolderClosed,
  FolderOpen,
  Library,
  ListChecks,
  Plus,
  Shield,
  Users,
  Webhook
} from 'lucide-react'
import type { ExperimentalFeature } from '@shuvix/chat-protocol/experimentalFeatures'
import { AnimatedCollapse } from '../common/AnimatedCollapse'
import { ExperimentalTag } from '../common/ExperimentalTag'
import { RowMenuButton } from './RowMenuButton'

export interface SessionGroupProps {
  label: string
  variant:
    | 'temp'
    | 'project'
    | 'knowledge'
    | 'bots'
    | 'agents'
    | 'policies'
    | 'hooks'
    | 'skills'
    | 'tracking'
    | 'section'
    | 'bot'
  /** 组头图标（只有 `bot` 形态用：bot 的头像）；缺省按形态取 */
  icon?: React.ReactNode
  /** 组头悬停时 ⋮ 旁边多一颗「+」（`bot` 形态：新对话）；缺省没有 */
  onAdd?: (e: React.MouseEvent) => void
  /** 「+」的悬停提示 / 无障碍名 */
  addLabel?: string
  /** 整组淡显（找不到 bot 文件的那几组：会话还在，主人没了） */
  muted?: boolean
  /** 折叠态 + 切换；`temp` / `section` 形态是摊开的纯分节，两者都不传 */
  collapsed?: boolean
  onToggle?: () => void
  /** 活动组高亮（当前会话所属组） */
  active?: boolean
  /** 专注模式下整组淡化 */
  dim?: boolean
  /** 与上一节隔开（摊开的分节：上方多留一点白；不再画线） */
  showDividerAbove?: boolean
  /** 组头菜单（右键标题行 / 点 ⋮ 走同一个回调）；缺省即两者都无 */
  onMenu?: (e: React.MouseEvent) => void
  /** 实验功能：标签后缀一枚「实验」小标签（只在可折叠形态的组头上画） */
  experimental?: ExperimentalFeature
  /** 分组内的会话项（SessionItem 列表） */
  children: React.ReactNode
}

export function SessionGroup({
  label,
  variant,
  collapsed = false,
  onToggle,
  active = false,
  dim = false,
  showDividerAbove = false,
  onMenu,
  experimental,
  icon,
  onAdd,
  addLabel,
  muted = false,
  children
}: SessionGroupProps): React.JSX.Element {
  // temp / section 是摊开的纯分节：没有折叠，也就没有折叠图标（见文件头注释）
  const flat = variant === 'temp' || variant === 'section'
  const Icon =
    variant === 'knowledge'
      ? Library
      : variant === 'bots'
        ? Users
        : variant === 'agents'
          ? Bot
          : variant === 'policies'
            ? Shield
            : variant === 'hooks'
              ? Webhook
              : variant === 'skills'
                ? BookOpen
                : variant === 'tracking'
                  ? ListChecks
                  : collapsed
                    ? FolderClosed
                    : FolderOpen
  return (
    <div className={`transition-opacity duration-200 ${dim ? 'opacity-30 hover:opacity-100' : ''}`}>
      {/* 当前会话所在的组：整组垫一层很淡的底（桌面侧栏上看得出「我在哪个项目里」；手机侧栏底色就是 bg-primary，
          这一层自然看不见） */}
      <div
        className={`mb-px rounded-[var(--sb-radius)] ${flat && showDividerAbove ? 'mt-1' : ''} ${
          active && !flat ? 'bg-bg-primary/30' : ''
        }`}
      >
        {flat ? (
          /* 分节标题（Finder 侧栏的「个人收藏」「位置」）：小号粗体灰字、不大写，上方留白代替分隔线 ——
             「项目」与「临时对话」共用这一副排版，不可点、无图标 */
          <div
            data-group={variant}
            className="sb-section relative group/header"
            onContextMenu={onMenu}
          >
            <span className="flex-1 min-w-0 truncate group-hover/header:pr-6">
              {label}
              {experimental && <ExperimentalTag feature={experimental} />}
            </span>
            {onMenu && (
              <RowMenuButton
                className="absolute right-1.5 opacity-0 group-hover/header:opacity-100"
                onOpen={onMenu}
              />
            )}
          </div>
        ) : (
          /* 可折叠的组（项目、Bots、智能体…）是一行「位置」：着色的图标 + 正常字重的名字，与它里面的行同高 */
          <div
            data-group={variant}
            className={`sb-row group/header cursor-pointer ${
              active ? 'text-text-primary' : 'text-text-primary hover:bg-bg-hover/60'
            } ${muted ? 'opacity-50' : ''}`}
            onContextMenu={onMenu}
          >
            <button
              onClick={onToggle}
              data-has-add={onAdd ? '' : undefined}
              className={`flex items-center gap-[var(--sb-gap)] flex-1 min-w-0 self-stretch text-left ${
                onAdd ? 'group-hover/header:pr-12' : 'group-hover/header:pr-6'
              }`}
            >
              {icon ? (
                <span className="sb-icon">{icon}</span>
              ) : (
                <Icon className="sb-icon text-accent" />
              )}
              <span className={`truncate ${muted ? 'line-through' : ''}`}>{label}</span>
              {experimental && <ExperimentalTag feature={experimental} />}
            </button>
            {onAdd && (
              <button
                data-group-add=""
                onClick={(e) => {
                  e.stopPropagation()
                  onAdd(e)
                }}
                title={addLabel}
                aria-label={addLabel}
                className="absolute right-7 flex h-5 w-5 items-center justify-center rounded opacity-0 text-text-tertiary hover:bg-bg-active hover:text-text-primary group-hover/header:opacity-100"
              >
                <Plus size={13} />
              </button>
            )}
            {onMenu && (
              <RowMenuButton
                className="absolute right-1.5 opacity-0 group-hover/header:opacity-100"
                onOpen={onMenu}
              />
            )}
          </div>
        )}
        {flat ? (
          <div>{children}</div>
        ) : (
          <AnimatedCollapse open={!collapsed}>
            <div className="sb-body">{children}</div>
          </AnimatedCollapse>
        )}
      </div>
    </div>
  )
}
