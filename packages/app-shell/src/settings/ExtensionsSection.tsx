/**
 * 扩展能力卡：MCP / 知识库合在一张卡里，每组一行，条目是会换行的勾选标签。技能不在这里（2026-10-28）：
 * 侧栏里启用着的全部上 agent 的货架，没有按会话 / 按项目的勾选。
 *
 * 两处共用：项目编辑页（项目的扩展能力 —— 新建会话从这里继承）与会话设置（这条会话自己的
 * 勾选）。本组件只管展示与回调，数据与持久化都在调用方。
 * 输入框的工具选择器（chat-ui ToolPicker）列的是同样两组。
 *
 * 展示规矩：
 *  - agent 档案声明的项（`declaredBy`）缺省勾上，悬停说是哪个档案带的；取消它在勾选里写一个取消记号
 *    （`-<name>`，chat-protocol `toolSelection`），只作用于这条会话 / 这个项目的新会话。
 *    读写都经 `isToolSelected` / `setToolSelected`，调用方拿到的 `onChange` 是整份新勾选。
 *  - 每组里 ShuviX 自带的项（内置 MCP）排在最前，其余保持后端给的顺序。内置项（含内置知识库
 *    `shuvix`）与设置 → MCP、侧栏技能行同一个画法：内置记号（琥珀色小包裹图标）+ 界面语言的名字，标识名（档案与勾选里写
 *    的那个）用小号等宽字并排留着、只差大小写时不重复，悬停给界面语言的一行说明（chat-protocol
 *    builtinExtensionCopy）。别的项就是标识名。
 *  - 知识库一行**语义刻意不同**：它不进 Agent 的工具表，是 `knowledge` 工具每次调用时由宿主现查的，
 *    运行时存在期间照样能改、改完下一次调用就作数 —— 所以 `readonly` 只锁 MCP 一行。
 *    项目自己的库不在候选项里：会话属于项目它就恒启用（宿主隐式加上），用不着勾。内置库照宿主给的顺序
 *    垫底（它是说明书，不是用户的内容），不往前提。
 *    一个候选库都没有时这一行不显示（扩展端落在这里：它没有知识库）。
 *  - 两行的组名列按最宽的那个对齐（subgrid）：「MCP」「Knowledge bases」长短不一，标签列照样齐。
 */
import { useTranslation } from 'react-i18next'
import { Puzzle, Library, WifiOff, Lock, Package, Wrench } from 'lucide-react'
import { isToolSelected, setToolSelected } from '@shuvix/chat-protocol/toolSelection'
import {
  builtinKnowledgeCopy,
  builtinMcpCopy,
  sameAsIdentifier
} from '@shuvix/chat-protocol/builtinExtensionCopy'
import type { ToolItem } from '../common/ToolSelectList'
import { SettingsSection } from './SettingsPrimitives'

interface ExtItem {
  /** 勾选用的工具名（mcp:xxx） */
  key: string
  /** 标识名（已去掉前缀） */
  display: string
  /** 内置项的界面语言名字：有它就以它为主，标识名降成并排的小字 */
  label?: string
  /** 悬停提示（内置 MCP 的本地化说明） */
  desc?: string
  builtin?: boolean
  /** 这一项是组件 */
  widget?: boolean
  offline?: boolean
  /** 会话的 agent 档案声明了它（值为档案显示名）：缺省勾上，取消写取消记号 */
  declaredBy?: string
}

/** 内置项排前、其余保序（Array.prototype.sort 是稳定排序） */
const builtinFirst = (a: ExtItem, b: ExtItem): number => Number(!!b.builtin) - Number(!!a.builtin)

/** 组配色（MCP 紫 / 知识库蓝）—— 写成完整类名，Tailwind 才扫得到 */
const EXT_TONES = {
  purple: {
    title: 'text-purple-400',
    checked: 'border-purple-400/55 bg-purple-400/12',
    dot: 'bg-purple-400 shadow-[0_0_8px_rgba(192,132,252,0.55)]'
  },
  sky: {
    title: 'text-sky-400',
    checked: 'border-sky-400/55 bg-sky-400/12',
    dot: 'bg-sky-400 shadow-[0_0_8px_rgba(56,189,248,0.55)]'
  }
} as const

type ExtTone = keyof typeof EXT_TONES

/** 按来源分组的网格区块：顶部组名 + 计数，下方等宽网格卡片 */
function ExtGridGroup({
  groupKey,
  title,
  icon,
  tone,
  count,
  locked,
  colsClass,
  children
}: {
  groupKey: string
  title: string
  icon: React.ReactNode
  tone: ExtTone
  count: number
  /** 组名旁挂把锁：整排压暗之外再给一个明确的「锁住了」信号 */
  locked: boolean
  colsClass: string
  children?: React.ReactNode
}): React.JSX.Element {
  return (
    <div data-ext-group={groupKey} className="px-3.5 py-3 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <div
          className={`flex items-center gap-1.5 text-[11px] font-medium ${EXT_TONES[tone].title}`}
        >
          {icon}
          <span data-ext-group-title="">{title}</span>
          {locked && <Lock size={10} data-ext-lock className="text-text-tertiary" />}
        </div>
        <span className="text-[10px] text-text-tertiary tabular-nums">{count}</span>
      </div>
      {children && <div className={`grid ${colsClass} gap-1.5`}>{children}</div>}
    </div>
  )
}

/** 一个等宽网格勾选卡片。`attrs` 是给 e2e 与调用方认条目的 data-* 锚点（扩展能力与知识库各用各的） */
function ExtChip({
  tone,
  checked,
  readonly,
  title,
  onToggle,
  display,
  label,
  builtin,
  widget,
  offline,
  attrs
}: {
  tone: ExtTone
  checked: boolean
  readonly: boolean
  title?: string
  onToggle: () => void
  /** 标识名 */
  display: string
  /** 内置项的界面语言名字 */
  label?: string
  builtin?: boolean
  widget?: boolean
  offline?: boolean
  attrs: Record<`data-${string}`, string | boolean | undefined>
}): React.JSX.Element {
  const { t } = useTranslation()
  const showIdentifier = Boolean(label && !sameAsIdentifier(label, display))
  // 只读时整排按禁用态画（压暗 + 禁用光标）；正常态下未选中项呈专注模式半隐藏，悬停唤醒，选中项点亮状态灯
  const stateCls = checked
    ? EXT_TONES[tone].checked
    : readonly
      ? 'border-border-secondary/40 bg-transparent'
      : 'border-border-secondary/35 bg-transparent opacity-55 hover:opacity-100 hover:bg-bg-hover/50 hover:border-border-secondary/80'
  return (
    <label
      {...attrs}
      aria-disabled={readonly || undefined}
      title={title}
      className={`group flex items-center justify-between gap-2 w-full min-w-0 px-2.5 ${
        showIdentifier ? 'py-2' : 'py-1.5'
      } rounded-lg border transition-all has-[:focus-visible]:ring-1 has-[:focus-visible]:ring-accent/60 ${
        readonly ? 'cursor-not-allowed opacity-40' : 'cursor-pointer'
      } ${stateCls}`}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={readonly}
        onChange={() => {
          // 与工具选择器同一道闸：只读时一次点击也不交出去（不只靠 disabled）
          if (readonly) return
          onToggle()
        }}
        className="sr-only"
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 min-w-0">
          {/* 内置记号：琥珀色小包裹（随应用一起来的），悬停与读屏说「内置」—— 不用锁，锁在这张卡上是只读的意思 */}
          {widget && (
            <span
              data-widget-mark
              role="img"
              aria-label={t('input.extensionWidgetBadge')}
              title={t('input.extensionWidgetBadge')}
              className="flex shrink-0 text-amber-500"
            >
              <Wrench size={11} aria-hidden />
            </span>
          )}
          {builtin && (
            <span
              data-builtin-badge
              role="img"
              aria-label={t('input.skillBuiltinBadge')}
              title={t('input.skillBuiltinBadge')}
              className="flex shrink-0 text-amber-500"
            >
              <Package size={11} aria-hidden />
            </span>
          )}
          <span
            data-chip-name
            className={`text-[12px] leading-snug ${label ? '' : 'font-mono '}truncate ${
              offline
                ? 'text-error'
                : checked
                  ? 'text-text-primary font-medium'
                  : 'text-text-secondary'
            }`}
          >
            {label ?? display}
          </span>
          {offline && (
            <WifiOff
              size={10}
              className="text-error shrink-0"
              aria-label={t('settings.mcpStatusDisconnected')}
            />
          )}
        </div>
        {showIdentifier && (
          <div
            data-chip-identifier
            className="text-[10px] leading-tight font-mono text-text-tertiary truncate mt-0.5"
          >
            {display}
          </div>
        )}
      </div>
      {/* 右侧状态灯：选中时点亮主色圆点，未选中时仅淡描边（悬停微显） */}
      <span
        aria-hidden
        className={`w-2 h-2 rounded-full shrink-0 transition-all ${
          checked
            ? EXT_TONES[tone].dot
            : 'border border-border-secondary/70 opacity-45 group-hover:opacity-85'
        }`}
      />
    </label>
  )
}

export interface KnowledgeBaseChoice {
  /** 选择里存的名字：用户库的目录名，或保留名 `shuvix` */
  name: string
  /** 补充说明（悬停时显示）；没有就只显示名字 */
  label?: string
}

/** 知识库一行的数据与回调（不随 `readonly` 上锁，见文件头） */
export interface ExtensionsKnowledge {
  options: KnowledgeBaseChoice[]
  selected: string[]
  onToggle: (name: string) => void
  /** 知识库那一段说明 —— 与卡片说明叠进同一个问号气泡，排在后面 */
  hint?: React.ReactNode
}

export interface ExtensionsSectionProps {
  /** 分组标题（缺省时不画标题行，适合独立 Tab 页避免与 Tab 名重复） */
  title?: React.ReactNode
  /** 卡片的说明（MCP 的勾选何时作数） */
  footer?: React.ReactNode
  mcpTools: ToolItem[]
  enabledTools: string[]
  /** 勾选改了：交回整份新勾选（含取消档案声明项的记号），由调用方落库 */
  onChange: (next: string[]) => void
  /** 只读：MCP 一行按禁用态画、勾选框禁用、点击无效；知识库一行不受影响 */
  readonly?: boolean
  /** 只读的原因，作为条目的悬停提示 —— 界面上不另起一行文字说 */
  readonlyHint?: string
  /** 知识库一行；不给或没有候选库时不显示 */
  knowledge?: ExtensionsKnowledge
  /** 只画其中一行（手机布局的会话详情页一行一页）；缺省两行都画 */
  only?: 'mcp' | 'knowledge'
}

export function ExtensionsSection({
  title,
  footer,
  mcpTools,
  enabledTools,
  onChange,
  readonly = false,
  readonlyHint,
  knowledge,
  only
}: ExtensionsSectionProps): React.JSX.Element {
  const { t } = useTranslation()
  // MCP 的 label 就是 server 名，和展示名重复，不当描述用；内置 server 有本地化的名字与一行说明
  const mcpItems: ExtItem[] = mcpTools
    .map((tool) => {
      const copy = tool.isWidget
        ? { label: tool.label, hint: tool.hint }
        : tool.isBuiltin
          ? builtinMcpCopy(tool.name, t)
          : undefined
      return {
        key: tool.name,
        display: tool.name.startsWith('mcp:') ? tool.name.slice(4) : tool.name,
        label: copy?.label,
        desc: copy?.hint,
        builtin: tool.isBuiltin,
        widget: tool.isWidget,
        // 惰性启动下「没连上」是常态（用到才连），只有连接失败才标成离线
        offline: tool.serverStatus === 'error',
        declaredBy: tool.declaredBy
      }
    })
    .sort(builtinFirst)

  const extChips = (items: ExtItem[], tone: ExtTone): React.ReactNode =>
    items.length > 0 &&
    items.map((it) => {
      const declared = !!it.declaredBy
      const checked = isToolSelected(enabledTools, it.key, declared)
      return (
        <ExtChip
          key={it.key}
          tone={tone}
          checked={checked}
          readonly={readonly}
          title={
            readonly
              ? readonlyHint
              : declared
                ? t('sessionConfig.extensionDeclared', { profile: it.declaredBy })
                : it.offline
                  ? t('settings.mcpStatusError')
                  : it.desc
          }
          onToggle={() => onChange(setToolSelected(enabledTools, it.key, declared, !checked))}
          display={it.display}
          label={it.label}
          builtin={it.builtin}
          widget={it.widget}
          offline={it.offline}
          attrs={{
            'data-ext-item': it.key,
            'data-offline': it.offline || undefined,
            'data-declared': declared || undefined
          }}
        />
      )
    })

  const kbOptions = knowledge?.options ?? []

  // 按来源拆成三个自然分组（内置 / 外部 MCP / 小组件），各自保持输入顺序
  const builtinItems = mcpItems.filter((it) => it.builtin)
  const externalItems = mcpItems.filter((it) => !it.builtin && !it.widget)
  const widgetItems = mcpItems.filter((it) => !it.builtin && it.widget)

  const mcpGroups = [
    {
      key: 'builtin',
      title: t('sessionConfig.builtinGroup'),
      icon: <Package size={12} />,
      items: builtinItems,
      colsClass: 'grid-cols-2 sm:grid-cols-3'
    },
    {
      key: 'external',
      title: t('sessionConfig.mcpServersGroup'),
      icon: <Puzzle size={12} />,
      items: externalItems,
      colsClass: 'grid-cols-2 sm:grid-cols-3'
    },
    {
      key: 'widgets',
      title: t('sessionConfig.widgetsGroup'),
      icon: <Wrench size={12} />,
      items: widgetItems,
      colsClass: 'grid-cols-1 sm:grid-cols-2'
    }
  ].filter((g) => g.items.length > 0)

  return (
    // 卡片说明与知识库那一段叠成气泡里的两段（SettingsSection 把 description 与 footer 按先后叠起来）；
    // 知识库那段带锚点，e2e 按它单独读「还没选过 / 已明确设过」是哪一句
    <SettingsSection
      title={title}
      description={footer}
      footer={
        only !== 'mcp' && kbOptions.length > 0 && knowledge?.hint ? (
          <span data-knowledge-hint>{knowledge.hint}</span>
        ) : undefined
      }
    >
      <div className="divide-y divide-border-secondary/40">
        {only !== 'knowledge' &&
          (mcpGroups.length > 0 ? (
            mcpGroups.map((group, idx) => (
              <ExtGridGroup
                key={group.key}
                groupKey={group.key}
                title={group.title}
                icon={group.icon}
                tone="purple"
                count={group.items.length}
                // 只在首个 MCP 分组上挂一把只读锁（与既有一卡一锁的语义及测试保持一致）
                locked={readonly && idx === 0}
                colsClass={group.colsClass}
              >
                {extChips(group.items, 'purple')}
              </ExtGridGroup>
            ))
          ) : (
            <ExtGridGroup
              groupKey="external"
              title={t('sessionConfig.mcpServersGroup')}
              icon={<Puzzle size={12} />}
              tone="purple"
              count={0}
              locked={readonly}
              colsClass="grid-cols-2 sm:grid-cols-3"
            />
          ))}
        {only !== 'mcp' && knowledge && kbOptions.length > 0 && (
          <ExtGridGroup
            groupKey="knowledge"
            title={t('sessionConfig.knowledgeGroup')}
            icon={<Library size={12} />}
            tone="sky"
            count={kbOptions.length}
            locked={false}
            colsClass="grid-cols-2 sm:grid-cols-3"
          >
            {kbOptions.map((option) => {
              const copy = builtinKnowledgeCopy(option.name, t)
              return (
                <ExtChip
                  key={option.name}
                  tone="sky"
                  checked={knowledge.selected.includes(option.name)}
                  readonly={false}
                  title={copy?.hint ?? (option.label || undefined)}
                  onToggle={() => knowledge.onToggle(option.name)}
                  display={option.name}
                  label={copy?.label}
                  builtin={!!copy}
                  attrs={{ 'data-knowledge-base': option.name }}
                />
              )
            })}
          </ExtGridGroup>
        )}
      </div>
    </SettingsSection>
  )
}
