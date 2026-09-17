import { getSessionChannelApi } from '@shuvix/chat-ui'
import { useRef, useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { Server, BookOpen, WifiOff, Lock, Loader2 } from 'lucide-react'
import { useChatStore, selectMcpConnecting } from '../../stores/chatStore'
import { useClickOutside } from '../../hooks/useClickOutside'
import { useSessionTools } from '../../hooks/useSessionTools'
import type { ToolItem } from '../common/ToolSelectList'

const SKILLS_GROUP = '__skills__'

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
 * 工具选择器 — 会话的扩展能力勾选（MCP / Skill），与会话设置里的扩展能力是同一份数据。
 *
 * 内置工具与 SubAgent 始终启用，不在此处控制。勾选只在创建 Agent 时读一次：会话已有运行时
 * 就只读（面板照常能打开看：整排条目按禁用态画、触发钮挂锁，原因只在悬停时说）。
 * 还没有会话（欢迎页）时不显示 ——
 * 没有可写的地方，而直接发送新建出来的聊天会话本就一个都不勾。
 */
export function ToolPicker(): React.JSX.Element | null {
  const { t } = useTranslation()
  const activeSessionId = useChatStore((s) => s.activeSessionId)
  const { enabledTools, locked, setEnabledTools } = useSessionTools(activeSessionId)
  const mcpConnecting = useChatStore(selectMcpConnecting)

  const toolsRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [allTools, setAllTools] = useState<ToolItem[]>([])

  const close = useCallback(() => setOpen(false), [])
  useClickOutside(toolsRef, close, open)

  const fetchTools = useCallback(() => {
    const sid = useChatStore.getState().activeSessionId
    if (!sid) return
    void getSessionChannelApi()
      .tools.list(sid)
      .then((tools) => setAllTools(tools))
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

  if (!activeSessionId || (mcpTools.length === 0 && skillTools.length === 0)) return null

  const enabledMcpTools = mcpTools.filter((t) => enabledTools.includes(t.name))
  const enabledSkillTools = skillTools.filter((t) => enabledTools.includes(t.name))

  const toggle = (name: string): void => {
    if (locked) return
    const next = enabledTools.includes(name)
      ? enabledTools.filter((n) => n !== name)
      : [...enabledTools, name]
    void setEnabledTools(next)
  }

  // 只读时整排按禁用态画（压暗 + 禁用光标），不响应悬停：一眼看出改不了；原因放在悬停提示里
  const rowCls = `flex items-center gap-1.5 w-full px-2 py-0.5 transition-colors ${
    locked ? 'cursor-not-allowed opacity-40' : 'hover:bg-bg-hover cursor-pointer'
  }`
  const lockedHint = locked ? t('sessionConfig.extensionsLocked') : undefined

  return (
    <div
      ref={toolsRef}
      data-tool-picker
      data-locked={locked || undefined}
      className="relative flex items-center group"
    >
      <button
        onClick={() => setOpen(!open)}
        title={lockedHint}
        className="inline-flex items-center gap-1.5 text-[11px] text-text-tertiary hover:text-text-secondary transition-colors border border-transparent hover:border-border-secondary rounded px-1.5 py-0.5"
      >
        {/* 只读态把锁挂在触发钮上：不用展开面板就知道这条会话的扩展能力已经定了 */}
        {locked && <Lock size={10} data-tool-lock className="flex-shrink-0" />}
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
      </button>

      {/* 悬浮 tooltip：已启用的工具列表 */}
      {!open && (enabledMcpTools.length > 0 || enabledSkillTools.length > 0) && (
        <div className="pointer-events-none absolute left-0 bottom-6 z-20 hidden min-w-[200px] max-w-[280px] rounded-md border border-border-primary bg-bg-secondary px-2 py-1.5 shadow-xl group-hover:block">
          <div className="text-[10px] text-text-tertiary mb-1">{t('input.tools')}</div>
          <div className="space-y-1 max-h-40 overflow-y-auto">
            {enabledMcpTools.length > 0 && (
              <div className="flex items-center gap-1.5">
                <span className="text-[10px] text-text-secondary">[MCP]</span>
                <span className="text-[11px] text-text-primary truncate">
                  {enabledMcpTools.map((t) => mcpShortName(t.name)).join(', ')}
                </span>
              </div>
            )}
            {enabledSkillTools.length > 0 && (
              <div className="flex items-center gap-1.5">
                <span className="text-[10px] text-text-secondary">[Skills]</span>
                <span className="text-[11px] text-text-primary truncate">
                  {enabledSkillTools.map((t) => parseSkillDisplay(t.name).label).join(', ')}
                </span>
              </div>
            )}
          </div>
        </div>
      )}

      {open && (
        <div className="picker-panel absolute left-0 bottom-8 z-30 w-[240px] rounded-lg border border-border-primary bg-bg-secondary shadow-2xl overflow-hidden">
          <div className="py-1 max-h-[60vh] overflow-y-auto">
            {mcpTools.length > 0 && (
              <div className="py-0.5">
                <div className="px-2 py-1 text-[10px] font-medium text-text-tertiary">MCP</div>
                {mcpTools.map((tool) => {
                  // 惰性启动下「没连上」是常态（用到才连），只有连接失败才值得标红
                  const failed = tool.serverStatus === 'error'
                  return (
                    <label
                      key={tool.name}
                      data-tool-item={tool.name}
                      data-offline={failed || undefined}
                      aria-disabled={locked || undefined}
                      title={lockedHint}
                      className={`${rowCls} ${failed && !locked ? 'opacity-50' : ''}`}
                    >
                      <input
                        type="checkbox"
                        checked={enabledTools.includes(tool.name)}
                        disabled={locked}
                        onChange={() => toggle(tool.name)}
                        className="rounded border-border-primary accent-accent w-3.5 h-3.5 flex-shrink-0"
                      />
                      {tool.isBuiltin && (
                        <span className="px-1 py-px rounded text-[9px] font-medium text-amber-500 bg-amber-500/10 whitespace-nowrap flex-shrink-0">
                          {t('input.skillBuiltinBadge')}
                        </span>
                      )}
                      <span
                        className={`text-[11px] font-mono whitespace-nowrap flex-shrink-0 ${failed ? 'text-red-300/60' : 'text-purple-300'}`}
                      >
                        {mcpShortName(tool.name)}
                      </span>
                      {failed && (
                        <span
                          className="flex items-center gap-0.5 text-[10px] text-red-400"
                          title={t('settings.mcpStatusError')}
                        >
                          <WifiOff size={10} />
                        </span>
                      )}
                      <span className="text-[10px] text-text-tertiary truncate flex-1 min-w-0">
                        {tool.label}
                      </span>
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
                <div className="px-2 py-1 text-[10px] font-medium text-text-tertiary">SKILL</div>
                {skillTools.map((tool) => {
                  const { label, builtin } = parseSkillDisplay(tool.name)
                  return (
                    <label
                      key={tool.name}
                      data-tool-item={tool.name}
                      aria-disabled={locked || undefined}
                      title={lockedHint}
                      className={rowCls}
                    >
                      <input
                        type="checkbox"
                        checked={enabledTools.includes(tool.name)}
                        disabled={locked}
                        onChange={() => toggle(tool.name)}
                        className="rounded border-border-primary accent-accent w-3.5 h-3.5 flex-shrink-0"
                      />
                      {builtin && (
                        <span className="px-1 py-px rounded text-[9px] font-medium text-amber-500 bg-amber-500/10 whitespace-nowrap flex-shrink-0">
                          {t('input.skillBuiltinBadge')}
                        </span>
                      )}
                      <span className="text-[11px] font-mono text-emerald-300 whitespace-nowrap flex-shrink-0">
                        {label}
                      </span>
                      <span className="text-[10px] text-text-tertiary truncate flex-1 min-w-0">
                        {tool.label}
                      </span>
                    </label>
                  )
                })}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
