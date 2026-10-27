import { getSessionChannelApi } from '@shuvix/chat-ui'
import { useRef, useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { Server, BookOpen, Library, WifiOff, Loader2, Package, Puzzle } from 'lucide-react'
import { isToolSelected, setToolSelected } from '@shuvix/chat-protocol/toolSelection'
import {
  builtinKnowledgeCopy,
  builtinMcpCopy,
  builtinSkillCopy,
  sameAsIdentifier,
  type BuiltinExtensionCopy
} from '@shuvix/chat-protocol/builtinExtensionCopy'
import { useChatStore, selectMcpConnecting } from '../../stores/chatStore'
import { useClickOutside } from '../../hooks/useClickOutside'
import { useSessionTools } from '../../hooks/useSessionTools'
import { useSessionKnowledgeBases } from '../../hooks/useSessionKnowledgeBases'
import type { ToolItem } from '../common/ToolSelectList'
import { TouchSheet } from '../common/TouchSheet'
import { useChatDensity } from '../../host/chatHostContext'

const SKILLS_GROUP = '__skills__'

/** 欢迎页直接发送新建的是无项目会话，根档案由形态推导为基座 chat（见 sessionService） */
const WELCOME_PROFILE = 'chat'

/** 提取 MCP 服务器短名（mcp:context7 → context7） */
function mcpShortName(name: string): string {
  return name.startsWith('mcp:') ? name.slice(4) : name
}

/** 提取 Skill 短名（skill:pdf → pdf） */
function skillShortName(name: string): string {
  return name.startsWith('skill:') ? name.slice(6) : name
}

/** 解析 skill 显示信息：内置 skill 去掉 builtin: 前缀并标记为内置 */
function parseSkillDisplay(name: string): { label: string; builtin: boolean } {
  const short = skillShortName(name)
  if (short.startsWith('builtin:')) {
    return { label: short.slice('builtin:'.length), builtin: true }
  }
  return { label: short, builtin: false }
}

/**
 * 内置项的记号：一个琥珀色的小包裹图标（随应用一起来的），悬停与读屏说「内置」。不用侧栏内置档案那把锁 ——
 * 在这里锁的意思是「智能体已创建，改不了」，内置项本身照样能勾。
 */
function BuiltinMark({ size = 11 }: { size?: number }): React.JSX.Element {
  const { t } = useTranslation()
  const label = t('input.skillBuiltinBadge')
  return (
    <span
      data-builtin-badge
      role="img"
      aria-label={label}
      title={label}
      className="flex flex-shrink-0 text-amber-500"
    >
      <Package size={size} aria-hidden />
    </span>
  )
}

/**
 * 面板里一行的名字。内置项（有界面文案）与设置 → MCP、侧栏技能行同一个画法：界面语言的名字为主；
 * 别的项就是等宽的标识名。名字先占宽度，太长才截断。
 */
function ItemName({
  identifier,
  label,
  colorCls,
  touch = false
}: {
  identifier: string
  label?: string
  colorCls: string
  touch?: boolean
}): React.JSX.Element {
  return (
    <span
      data-chip-name
      className={`${touch ? 'text-[15px]' : 'text-[11px]'} ${label ? '' : 'font-mono '}${colorCls} truncate min-w-0`}
    >
      {label ?? identifier}
    </span>
  )
}

/**
 * 名字后面那一段淡色小字：内置项的标识名（档案与勾选里写的那个，只差大小写时不重复）打头，再接一行说明。
 * 两者连成一段一起截断 —— 面板只有 240px，分成两格时窄的那格会被挤成一条切开的字。
 */
function ItemDetail({
  identifier,
  label,
  hint,
  touch = false
}: {
  identifier: string
  label?: string
  hint?: string
  touch?: boolean
}): React.JSX.Element | null {
  const showIdentifier = !!label && !sameAsIdentifier(label, identifier)
  // 自定义 MCP 的「说明」常常就是它的名字（tavily · tavily）：与名字相同就不再写一遍
  const shownHint = hint && !sameAsIdentifier(hint, label ?? identifier) ? hint : undefined
  if (!showIdentifier && !shownHint) return null
  return (
    <span
      className={`${touch ? 'block text-[13px]' : 'text-[10px] flex-1'} text-text-tertiary truncate min-w-0`}
    >
      {showIdentifier && (
        <span data-chip-identifier className="font-mono mr-1.5">
          {identifier}
        </span>
      )}
      {shownHint && <span data-chip-hint>{shownHint}</span>}
    </span>
  )
}

/**
 * 工具选择器 — 会话的扩展能力勾选（MCP / Skill / 知识库），与会话设置里的扩展能力卡是同一份数据、
 * 同样三组。
 *
 * 内置的 MCP / 技能 / 知识库以界面语言的名字为主，后面淡色小字是标识名与界面语言的一行说明
 * （ItemName / ItemDetail）；
 * 悬浮摘要里也写界面语言的名字。
 * 内置工具与 SubAgent 始终启用，不在此处控制。会话的 agent 档案声明的 mcp:/skill: 项（`declaredBy`）
 * 缺省勾上，悬停说是哪个档案带的；取消它写的是勾选里的取消记号（chat-protocol `toolSelection`），
 * 只作用于这条会话 —— 例如改用别的作图技能时取消内置的那份。
 * 会话已有运行时也能改 MCP / Skill（2026-10-26）：后端当场重配那个 agent，会打穿提示词缓存的改动先问一句
 * （useSessionTools → confirmAgentChange）。知识库一组本来就随时可改（useSessionKnowledgeBases）：它是
 * `knowledge` 工具每次调用时现查的。
 * 还没有会话（欢迎页）时勾的是草稿（useSessionTools / useSessionKnowledgeBases），直接发送新建会话时
 * 写进那条会话；声明项按那条会话将会用的档案画 —— 欢迎页新建的是无项目会话，基座 chat。
 *
 * 触屏密度（`density: 'touch'`，手机布局）：入口是「[拼图] 扩展 N」的胶囊（N = 三组开着的项数之和；桌面那三个
 * 图标加数字靠悬停提示才读得懂，手机上没有悬停），面板换成底部抽屉，每项两行（名字 / 标识名与说明）、48px 左右高。
 */
export function ToolPicker(): React.JSX.Element | null {
  const { t } = useTranslation()
  const activeSessionId = useChatStore((s) => s.activeSessionId)
  const { enabledTools, setEnabledTools } = useSessionTools(activeSessionId)
  const knowledge = useSessionKnowledgeBases(activeSessionId)
  const mcpConnecting = useChatStore(selectMcpConnecting)

  const touch = useChatDensity() === 'touch'
  const toolsRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [allTools, setAllTools] = useState<ToolItem[]>([])

  const close = useCallback(() => setOpen(false), [])
  // 抽屉挂在 body 上、点遮罩自己关：这里只管下拉面板
  useClickOutside(toolsRef, close, open && !touch)

  const fetchTools = useCallback(() => {
    const sid = useChatStore.getState().activeSessionId
    const api = getSessionChannelApi()
    void (sid ? api.tools.list(sid) : api.tools.list(undefined, { profile: WELCOME_PROFILE })).then(
      (tools) => {
        // 慢请求回来时会话可能已经换了：只收当前会话的那份
        if (useChatStore.getState().activeSessionId === sid) setAllTools(tools)
      }
    )
  }, [])

  // 可选项随会话变（项目级 skills 跟着工作目录走）
  useEffect(() => {
    fetchTools()
  }, [fetchTools, activeSessionId])

  // 打开面板时再拉一次：MCP 的连接状态可能刚变
  useEffect(() => {
    if (open) fetchTools()
  }, [open, fetchTools])

  const mcpTools = allTools.filter((t) => t.group?.startsWith('mcp:'))
  const skillTools = allTools.filter((t) => t.group === SKILLS_GROUP)

  const bases = knowledge.options
  if (mcpTools.length === 0 && skillTools.length === 0 && bases.length === 0) return null

  // 档案声明的项缺省开着、被取消才关；其余项勾了才开（记号见 chat-protocol toolSelection）
  const isOn = (tool: ToolItem): boolean =>
    isToolSelected(enabledTools, tool.name, !!tool.declaredBy)
  const enabledMcpTools = mcpTools.filter(isOn)
  const enabledSkillTools = skillTools.filter(isOn)
  // 只数候选里真有的：选择里可能还留着已经删掉的库名
  const enabledBases = bases.filter((base) => knowledge.selected.includes(base.name))
  const anyEnabled =
    enabledMcpTools.length > 0 || enabledSkillTools.length > 0 || enabledBases.length > 0
  // 内置项的界面文案（名字 + 说明）；自定义 MCP / 别的技能 / 用户库没有
  const mcpCopy = (tool: ToolItem): BuiltinExtensionCopy | undefined =>
    tool.isBuiltin ? builtinMcpCopy(tool.name, t) : undefined
  const skillCopy = (tool: ToolItem): BuiltinExtensionCopy | undefined =>
    builtinSkillCopy(tool.name, t)
  const baseCopy = (name: string): BuiltinExtensionCopy | undefined => builtinKnowledgeCopy(name, t)

  const toggle = (tool: ToolItem): void => {
    void setEnabledTools(setToolSelected(enabledTools, tool.name, !!tool.declaredBy, !isOn(tool)))
  }

  const rowCls = touch
    ? 'flex items-center gap-3 w-full min-h-12 px-4 py-1.5 transition-colors active:bg-bg-hover cursor-pointer'
    : 'flex items-center gap-1.5 w-full px-2 py-0.5 transition-colors hover:bg-bg-hover cursor-pointer'
  const checkboxCls = `rounded border-border-primary accent-accent flex-shrink-0 ${touch ? 'w-5 h-5' : 'w-3.5 h-3.5'}`
  const groupTitleCls = touch
    ? 'px-4 pt-2 pb-1 text-[12px] font-medium text-text-tertiary uppercase'
    : 'px-2 py-1 text-[10px] font-medium text-text-tertiary'
  const enabledCount = enabledMcpTools.length + enabledSkillTools.length + enabledBases.length
  /** 名字 + 说明：下拉面板里排成一行；抽屉里名字一行、说明一行 */
  const itemText = (name: React.ReactNode, detail: React.ReactNode): React.ReactNode =>
    touch ? (
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex min-w-0 items-center gap-1.5">{name}</span>
        {detail}
      </span>
    ) : (
      <>
        {name}
        {detail}
      </>
    )
  const rowHint = (tool: ToolItem): string | undefined =>
    tool.declaredBy ? t('sessionConfig.extensionDeclared', { profile: tool.declaredBy }) : undefined

  // ── 入口 ──
  const trigger = touch ? (
    <button
      type="button"
      onClick={() => setOpen(!open)}
      aria-label={t('input.extensions')}
      className="inline-flex h-9 flex-shrink-0 items-center gap-1.5 rounded-full border border-border-secondary/60 px-2.5 text-[13px] text-text-secondary transition-colors active:bg-bg-hover"
    >
      {/* 创建运行时期间正在连 MCP：图标换成转圈 */}
      {mcpConnecting.length > 0 ? (
        <Loader2 size={15} data-mcp-connecting className="animate-spin" />
      ) : (
        <Puzzle size={15} />
      )}
      {/* 字让给模型名：手机上工具行只有 22–25rem，模型名比这两个字要紧；更宽的时候（矮屏横放）才带字。
          工具行是容器查询的容器 */}
      <span className="hidden @[28rem]:inline">{t('input.extensions')}</span>
      <span data-extension-count className="tabular-nums text-text-tertiary">
        {enabledCount}
      </span>
    </button>
  ) : (
    <button
      onClick={() => setOpen(!open)}
      className="inline-flex items-center gap-1.5 text-[11px] text-text-tertiary hover:text-text-secondary transition-colors border border-transparent hover:border-border-secondary rounded px-1.5 py-0.5"
    >
      {mcpTools.length > 0 && (
        <span className="inline-flex items-center gap-0.5">
          {/* 创建运行时期间正在连 MCP：计数旁转个圈 */}
          {mcpConnecting.length > 0 ? (
            <Loader2 size={10} data-mcp-connecting className="animate-spin" />
          ) : (
            <Server size={10} />
          )}
          <span>{enabledMcpTools.length}</span>
        </span>
      )}
      {skillTools.length > 0 && (
        <span className="inline-flex items-center gap-0.5">
          <BookOpen size={10} />
          <span>{enabledSkillTools.length}</span>
        </span>
      )}
      {bases.length > 0 && (
        <span data-knowledge-count className="inline-flex items-center gap-0.5">
          <Library size={10} />
          <span>{enabledBases.length}</span>
        </span>
      )}
    </button>
  )

  // ── 面板内容（下拉面板与抽屉共用） ──
  const markSize = touch ? 14 : 11
  const panelBody = (
    <>
      {mcpTools.length > 0 && (
        <div className="py-0.5">
          <div className={groupTitleCls}>MCP</div>
          {mcpTools.map((tool) => {
            // 惰性启动下「没连上」是常态（用到才连），只有连接失败才值得标红
            const failed = tool.serverStatus === 'error'
            const copy = mcpCopy(tool)
            return (
              <label
                key={tool.name}
                data-tool-item={tool.name}
                data-offline={failed || undefined}
                data-declared={tool.declaredBy ? true : undefined}
                title={rowHint(tool)}
                className={`${rowCls} ${failed ? 'opacity-50' : ''}`}
              >
                <input
                  type="checkbox"
                  checked={isOn(tool)}
                  onChange={() => toggle(tool)}
                  className={checkboxCls}
                />
                {itemText(
                  <>
                    {tool.isBuiltin && <BuiltinMark size={markSize} />}
                    <ItemName
                      identifier={mcpShortName(tool.name)}
                      label={copy?.label}
                      colorCls={failed ? 'text-red-300/60' : 'text-purple-300'}
                      touch={touch}
                    />
                    {failed && (
                      <span
                        className="flex items-center gap-0.5 text-[10px] text-red-400"
                        title={t('settings.mcpStatusError')}
                      >
                        <WifiOff size={touch ? 13 : 10} />
                      </span>
                    )}
                  </>,
                  // 自定义 server 的 label 只是它的名字；内置的有一行本地化说明
                  <ItemDetail
                    identifier={mcpShortName(tool.name)}
                    label={copy?.label}
                    hint={copy?.hint || tool.label}
                    touch={touch}
                  />
                )}
              </label>
            )
          })}
        </div>
      )}
      {mcpTools.length > 0 && skillTools.length > 0 && (
        <div className="border-t border-border-secondary my-0.5" />
      )}
      {skillTools.length > 0 && (
        <div className="py-0.5">
          <div className={groupTitleCls}>SKILL</div>
          {skillTools.map((tool) => {
            const { label, builtin } = parseSkillDisplay(tool.name)
            const copy = skillCopy(tool)
            return (
              <label
                key={tool.name}
                data-tool-item={tool.name}
                data-declared={tool.declaredBy ? true : undefined}
                title={rowHint(tool)}
                className={rowCls}
              >
                <input
                  type="checkbox"
                  checked={isOn(tool)}
                  onChange={() => toggle(tool)}
                  className={checkboxCls}
                />
                {itemText(
                  <>
                    {builtin && <BuiltinMark size={markSize} />}
                    <ItemName
                      identifier={label}
                      label={copy?.label}
                      colorCls="text-emerald-300"
                      touch={touch}
                    />
                  </>,
                  <ItemDetail
                    identifier={label}
                    label={copy?.label}
                    hint={copy?.hint ?? tool.label}
                    touch={touch}
                  />
                )}
              </label>
            )
          })}
        </div>
      )}
      {(mcpTools.length > 0 || skillTools.length > 0) && bases.length > 0 && (
        <div className="border-t border-border-secondary my-0.5" />
      )}
      {bases.length > 0 && (
        <div className="py-0.5">
          {/* 组名大写与 MCP / SKILL 同形（中日文不受影响） */}
          <div className={`${groupTitleCls} uppercase`}>{t('sessionConfig.knowledgeGroup')}</div>
          {bases.map((base) => {
            // 内置库与内置 MCP / 技能同一个画法：内置记号 + 界面语言的名字 + 标识名与一行说明
            const copy = baseCopy(base.name)
            return (
              // 不随运行时上锁：没有只读态、没有锁的悬停原因
              <label key={base.name} data-knowledge-base={base.name} className={rowCls}>
                <input
                  type="checkbox"
                  checked={knowledge.selected.includes(base.name)}
                  onChange={() => knowledge.toggle(base.name)}
                  className={checkboxCls}
                />
                {itemText(
                  <>
                    {copy && <BuiltinMark size={markSize} />}
                    <ItemName
                      identifier={base.name}
                      label={copy?.label}
                      colorCls="text-sky-300"
                      touch={touch}
                    />
                  </>,
                  <ItemDetail
                    identifier={base.name}
                    label={copy?.label}
                    hint={copy?.hint}
                    touch={touch}
                  />
                )}
              </label>
            )
          })}
        </div>
      )}
    </>
  )

  return (
    <div ref={toolsRef} data-tool-picker className="relative flex-shrink-0 flex items-center group">
      {trigger}

      {/* 悬浮 tooltip：已启用的工具列表（触屏没有悬停） */}
      {!touch && !open && anyEnabled && (
        <div className="pointer-events-none absolute left-0 bottom-6 z-20 hidden min-w-[200px] max-w-[280px] rounded-md border border-border-primary bg-bg-secondary px-2 py-1.5 shadow-xl group-hover:block">
          <div className="text-[10px] text-text-tertiary mb-1">{t('input.tools')}</div>
          <div className="space-y-1 max-h-40 overflow-y-auto">
            {enabledMcpTools.length > 0 && (
              <div className="flex items-center gap-1.5">
                <span className="text-[10px] text-text-secondary">[MCP]</span>
                <span className="text-[11px] text-text-primary truncate">
                  {enabledMcpTools
                    .map((tool) => mcpCopy(tool)?.label ?? mcpShortName(tool.name))
                    .join(', ')}
                </span>
              </div>
            )}
            {enabledSkillTools.length > 0 && (
              <div className="flex items-center gap-1.5">
                <span className="text-[10px] text-text-secondary">[Skills]</span>
                <span className="text-[11px] text-text-primary truncate">
                  {enabledSkillTools
                    .map((tool) => skillCopy(tool)?.label ?? parseSkillDisplay(tool.name).label)
                    .join(', ')}
                </span>
              </div>
            )}
            {enabledBases.length > 0 && (
              <div className="flex items-center gap-1.5">
                <span className="text-[10px] text-text-secondary whitespace-nowrap">
                  [{t('sessionConfig.knowledgeGroup')}]
                </span>
                <span className="text-[11px] text-text-primary truncate">
                  {enabledBases.map((base) => baseCopy(base.name)?.label ?? base.name).join(', ')}
                </span>
              </div>
            )}
          </div>
        </div>
      )}

      {open && touch && (
        <TouchSheet name="extensions" onClose={close} title={t('input.extensions')}>
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain pb-2">{panelBody}</div>
        </TouchSheet>
      )}
      {open && !touch && (
        <div className="picker-panel absolute left-0 bottom-8 z-30 w-[240px] rounded-lg border border-border-primary bg-bg-secondary shadow-2xl overflow-hidden">
          <div className="py-1 max-h-[60vh] overflow-y-auto">{panelBody}</div>
        </div>
      )}
    </div>
  )
}
