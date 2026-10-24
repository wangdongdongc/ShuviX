/**
 * 扩展能力卡：MCP / Skills / 知识库合在一张卡里，每组一行，条目是会换行的勾选标签。
 *
 * 两处共用：项目编辑页（项目的扩展能力 —— 新建会话从这里继承）与会话设置（这条会话自己的
 * 勾选 —— MCP / Skills 在 Agent 创建之后只读）。本组件只管展示与回调，数据与持久化都在调用方。
 * 输入框的工具选择器（chat-ui ToolPicker）列的是同样三组。
 *
 * 展示规矩：
 *  - agent 档案声明的项（`declaredBy`）缺省勾上，悬停说是哪个档案带的；取消它在勾选里写一个取消记号
 *    （`-<name>`，chat-protocol `toolSelection`），只作用于这条会话 / 这个项目的新会话。
 *    读写都经 `isToolSelected` / `setToolSelected`，调用方拿到的 `onChange` 是整份新勾选。
 *  - 每组里 ShuviX 自带的项（内置 MCP / 内置技能）排在最前，其余保持后端给的顺序。内置项（含内置知识库
 *    `shuvix`）与设置 → MCP、侧栏技能行同一个画法：内置记号（琥珀色小包裹图标）+ 界面语言的名字，标识名（档案与勾选里写
 *    的那个）用小号等宽字并排留着、只差大小写时不重复，悬停给界面语言的一行说明（chat-protocol
 *    builtinExtensionCopy）。别的项就是标识名。
 *  - 知识库一行**语义刻意不同**：它不进 Agent 的工具表，是 `knowledge` 工具每次调用时由宿主现查的，
 *    运行时存在期间照样能改、改完下一次调用就作数 —— 所以 `readonly` 只锁 MCP / Skills 两行。
 *    项目自己的库不在候选项里：会话属于项目它就恒启用（宿主隐式加上），用不着勾。内置库照宿主给的顺序
 *    垫底（它是说明书，不是用户的内容），不往前提。
 *    一个候选库都没有时这一行不显示（扩展端落在这里：它没有知识库）。
 *  - 三行的组名列按最宽的那个对齐（subgrid）：「スキル」「Knowledge bases」长短不一，标签列照样齐。
 */
import { useTranslation } from 'react-i18next'
import { Puzzle, BookOpen, Library, WifiOff, Lock, Package } from 'lucide-react'
import { isToolSelected, setToolSelected } from '@shuvix/chat-protocol/toolSelection'
import {
  builtinKnowledgeCopy,
  builtinMcpCopy,
  builtinSkillCopy,
  sameAsIdentifier
} from '@shuvix/chat-protocol/builtinExtensionCopy'
import type { ToolItem } from '../common/ToolSelectList'
import { SettingsSection } from './SettingsPrimitives'

interface ExtItem {
  /** 勾选用的工具名（mcp:xxx / skill:xxx） */
  key: string
  /** 标识名（已去掉前缀） */
  display: string
  /** 内置项的界面语言名字：有它就以它为主，标识名降成并排的小字 */
  label?: string
  /** 悬停提示（skill 的描述；内置 MCP / 技能的本地化说明） */
  desc?: string
  builtin?: boolean
  offline?: boolean
  /** 会话的 agent 档案声明了它（值为档案显示名）：缺省勾上，取消写取消记号 */
  declaredBy?: string
}

/** 内置项排前、其余保序（Array.prototype.sort 是稳定排序） */
const builtinFirst = (a: ExtItem, b: ExtItem): number => Number(!!b.builtin) - Number(!!a.builtin)

/** 组配色（MCP 紫 / Skills 绿 / 知识库蓝）—— 写成完整类名，Tailwind 才扫得到 */
const EXT_TONES = {
  purple: { title: 'text-purple-400', checked: 'border-purple-400/40 bg-purple-400/10' },
  emerald: { title: 'text-emerald-400', checked: 'border-emerald-400/40 bg-emerald-400/10' },
  sky: { title: 'text-sky-400', checked: 'border-sky-400/40 bg-sky-400/10' }
} as const

type ExtTone = keyof typeof EXT_TONES

/** 一组一行：左组名，右条目。行是外层两列网格的 subgrid，组名列因此三行等宽 */
function ExtGroupRow({
  title,
  icon,
  tone,
  locked,
  children
}: {
  title: string
  icon: React.ReactNode
  tone: ExtTone
  /** 组名旁挂把锁：整排压暗之外再给一个明确的「锁住了」信号 */
  locked: boolean
  children?: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="col-span-2 grid grid-cols-subgrid items-start px-3.5 py-2.5">
      {/* h-6 与标签同高 */}
      <div
        className={`flex items-center gap-1.5 h-6 whitespace-nowrap text-[12px] font-medium ${EXT_TONES[tone].title}`}
      >
        {icon}
        {title}
        {locked && <Lock size={10} data-ext-lock className="text-text-tertiary" />}
      </div>
      {children && <div className="flex flex-wrap gap-1.5 min-w-0">{children}</div>}
    </div>
  )
}

/** 一个勾选标签。`attrs` 是给 e2e 与调用方认条目的 data-* 锚点（扩展能力与知识库各用各的） */
function ExtChip({
  tone,
  checked,
  readonly,
  title,
  onToggle,
  display,
  label,
  builtin,
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
  offline?: boolean
  attrs: Record<`data-${string}`, string | boolean | undefined>
}): React.JSX.Element {
  const { t } = useTranslation()
  // 只读时整排按禁用态画（压暗 + 禁用光标）：勾选的还看得出是勾选的（描边留着），
  // 但一眼就知道改不了；原因放在悬停提示里，不另起一行文字
  const stateCls = checked
    ? EXT_TONES[tone].checked
    : `border-border-secondary/60${readonly ? '' : ' hover:bg-bg-hover/60'}`
  return (
    <label
      {...attrs}
      aria-disabled={readonly || undefined}
      title={title}
      className={`inline-flex items-center gap-1.5 h-6 max-w-full px-2 rounded-md border transition-colors ${
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
        className="rounded border-border-primary accent-accent w-3 h-3 shrink-0"
      />
      {/* 内置记号：琥珀色小包裹（随应用一起来的），悬停与读屏说「内置」—— 不用锁，锁在这张卡上是只读的意思 */}
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
        className={`text-[11px] ${label ? '' : 'font-mono '}truncate ${
          offline ? 'text-error' : checked ? 'text-text-primary' : 'text-text-secondary'
        }`}
      >
        {label ?? display}
      </span>
      {label && !sameAsIdentifier(label, display) && (
        <span data-chip-identifier className="text-[10px] font-mono text-text-tertiary shrink-0">
          {display}
        </span>
      )}
      {offline && (
        <WifiOff
          size={10}
          className="text-error shrink-0"
          aria-label={t('settings.mcpStatusDisconnected')}
        />
      )}
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
  /** 分组标题（项目编辑页与会话设置各用各的文案） */
  title: React.ReactNode
  /** 卡片的说明（MCP / Skills 的勾选何时作数） */
  footer?: React.ReactNode
  mcpTools: ToolItem[]
  skillTools: ToolItem[]
  enabledTools: string[]
  /** 勾选改了：交回整份新勾选（含取消档案声明项的记号），由调用方落库 */
  onChange: (next: string[]) => void
  /** 只读：MCP / Skills 两行按禁用态画、勾选框禁用、点击无效（会话已有 Agent 运行时）；知识库一行不受影响 */
  readonly?: boolean
  /** 只读的原因，作为条目的悬停提示 —— 界面上不另起一行文字说 */
  readonlyHint?: string
  /** 知识库一行；不给或没有候选库时不显示 */
  knowledge?: ExtensionsKnowledge
}

export function ExtensionsSection({
  title,
  footer,
  mcpTools,
  skillTools,
  enabledTools,
  onChange,
  readonly = false,
  readonlyHint,
  knowledge
}: ExtensionsSectionProps): React.JSX.Element {
  const { t } = useTranslation()
  // MCP 的 label 就是 server 名，和展示名重复，不当描述用；内置 server 有本地化的名字与一行说明
  const mcpItems: ExtItem[] = mcpTools
    .map((tool) => {
      const copy = tool.isBuiltin ? builtinMcpCopy(tool.name, t) : undefined
      return {
        key: tool.name,
        display: tool.name.startsWith('mcp:') ? tool.name.slice(4) : tool.name,
        label: copy?.label,
        desc: copy?.hint,
        builtin: tool.isBuiltin,
        // 惰性启动下「没连上」是常态（用到才连），只有连接失败才标成离线
        offline: tool.serverStatus === 'error',
        declaredBy: tool.declaredBy
      }
    })
    .sort(builtinFirst)
  const skillItems: ExtItem[] = skillTools
    .map((tool) => {
      const short = tool.name.startsWith('skill:') ? tool.name.slice(6) : tool.name
      const builtin = short.startsWith('builtin:')
      const copy = builtinSkillCopy(tool.name, t)
      return {
        key: tool.name,
        display: builtin ? short.slice('builtin:'.length) : short,
        label: copy?.label,
        // 内置技能用界面文案，别的技能只有 frontmatter 那段描述（宿主截过的）
        desc: copy?.hint ?? tool.label,
        builtin,
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

  return (
    // 卡片说明与知识库那一段叠成气泡里的两段（SettingsSection 把 description 与 footer 按先后叠起来）；
    // 知识库那段带锚点，e2e 按它单独读「还没选过 / 已明确设过」是哪一句
    <SettingsSection
      title={title}
      description={footer}
      footer={
        kbOptions.length > 0 && knowledge?.hint ? (
          <span data-knowledge-hint>{knowledge.hint}</span>
        ) : undefined
      }
    >
      <div className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 divide-y divide-border-secondary/40">
        <ExtGroupRow title="MCP" icon={<Puzzle size={12} />} tone="purple" locked={readonly}>
          {extChips(mcpItems, 'purple')}
        </ExtGroupRow>
        <ExtGroupRow
          title={t('projectForm.skillsGroup')}
          icon={<BookOpen size={12} />}
          tone="emerald"
          locked={readonly}
        >
          {extChips(skillItems, 'emerald')}
        </ExtGroupRow>
        {knowledge && kbOptions.length > 0 && (
          <ExtGroupRow
            title={t('sessionConfig.knowledgeGroup')}
            icon={<Library size={12} />}
            tone="sky"
            locked={false}
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
          </ExtGroupRow>
        )}
      </div>
    </SettingsSection>
  )
}
