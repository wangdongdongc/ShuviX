/**
 * BuiltinToolsView —— 「LLM 工具」设置页（宿主无关，各端共享）。
 *
 * 每个内置工具一个子页，子页顶部展示该工具「发给 LLM」的 metadata 卡片（name / description / 参数）。
 * 数据通过注入的 loadDefinitions 读取（桌面 window.api.tools.definitions / 扩展 getChatApi().tools.definitions），
 * 工具特有配置（如桌面的 SSH/DB 凭据、子代理管理）经 renderToolExtra 注入在卡片下方，
 * 无对应 LLM 工具的宿主功能页（如桌面 Browser 数据/证书设置）经 extraTabs 追加在列表末尾。
 */
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Terminal,
  FileText,
  FileOutput,
  FilePen,
  MessageCircleQuestion,
  FolderTree,
  FileSearch2,
  Search,
  Database,
  Bot,
  Globe,
  Wrench,
  type LucideIcon
} from 'lucide-react'
import type { BuiltinToolDefinition } from '@shuvix/chat-protocol/chatApi'
import { SettingsSection } from './SettingsPrimitives'

/** 列表末尾追加的宿主特有子页（无对应 LLM 工具，如桌面 Browser 数据/证书设置） */
export interface BuiltinToolsExtraTab {
  id: string
  label: string
  icon?: React.ReactNode
  content: React.ReactNode
}

export interface BuiltinToolsViewProps {
  /** 读取内置工具定义（各端注入自身后端入口） */
  loadDefinitions: () => Promise<BuiltinToolDefinition[]>
  /** 在某工具 metadata 卡片下方注入宿主特有配置；返回 null 表示该工具无额外配置 */
  renderToolExtra?: (toolName: string) => React.ReactNode
  /** 追加在工具列表末尾的宿主功能页 */
  extraTabs?: BuiltinToolsExtraTab[]
}

/** lucide 图标名 → 组件映射（内置工具 presentation.icon 用到的子集；缺省 Wrench） */
const TOOL_ICON_MAP: Record<string, LucideIcon> = {
  Terminal,
  FileText,
  FileOutput,
  FilePen,
  MessageCircleQuestion,
  FolderTree,
  FileSearch2,
  Search,
  Database,
  Bot,
  Globe
}

function ToolTabIcon({ name }: { name?: string }): React.JSX.Element {
  const Icon = (name && TOOL_ICON_MAP[name]) || Wrench
  return <Icon size={14} className="shrink-0 text-text-tertiary" />
}

/** 子分类导航按钮（与 ProviderSettings / SkillSettings 保持视觉一致） */
function SubTabButton({
  icon,
  label,
  active,
  onClick
}: {
  icon: React.ReactNode
  label: string
  active: boolean
  onClick: () => void
}): React.JSX.Element {
  return (
    <button
      onClick={onClick}
      className={`group w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-left transition-colors ${
        active
          ? 'bg-accent/10 text-accent'
          : 'text-text-secondary hover:bg-bg-hover hover:text-text-primary'
      }`}
    >
      {/* 18px 高度槽位 — 与 Provider/Skill 行末 Toggle 同高，保证内容行高一致 */}
      <span className="shrink-0 inline-flex items-center h-[18px]">{icon}</span>
      <div className="min-w-0 flex-1">
        <div className="text-xs font-medium truncate">{label}</div>
      </div>
    </button>
  )
}

/** 工具参数展开后的行模型（object / object[] 递归展开内部字段） */
interface ToolParamRow {
  name: string
  type: string
  required: boolean
  description?: string
  /** 对象 / 对象数组的内部字段（无则 undefined） */
  children?: ToolParamRow[]
}

/** 展开一个「对象 schema」的 properties 为参数行（含其 required + 递归内部字段） */
function expandObjectProps(schema: Record<string, unknown> | undefined): ToolParamRow[] {
  const props = schema?.properties as Record<string, Record<string, unknown>> | undefined
  if (!props) return []
  const required = new Set((schema?.required as string[] | undefined) ?? [])
  return Object.entries(props).map(([name, s]) => ({
    name,
    type: schemaTypeLabel(s),
    required: required.has(name),
    description: typeof s?.description === 'string' ? s.description : undefined,
    children: nestedFields(s)
  }))
}

/** 取 object（直接 properties）/ object[]（items.properties）的内部字段；其余类型返回 undefined */
function nestedFields(schema: Record<string, unknown> | undefined): ToolParamRow[] | undefined {
  if (!schema) return undefined
  if (schema.properties && typeof schema.properties === 'object') {
    const rows = expandObjectProps(schema)
    return rows.length ? rows : undefined
  }
  if (schema.type === 'array' && schema.items && typeof schema.items === 'object') {
    const items = schema.items as Record<string, unknown>
    if (items.properties && typeof items.properties === 'object') {
      const rows = expandObjectProps(items)
      return rows.length ? rows : undefined
    }
  }
  return undefined
}

/** 将工具 parameters（JSON Schema 对象）展开为参数行；非对象 schema 返回空数组 */
function expandParams(parameters: BuiltinToolDefinition['parameters']): ToolParamRow[] {
  return expandObjectProps(parameters as Record<string, unknown>)
}

/** 从单个参数 schema 推导可读类型标签（覆盖常见的 string/number/boolean/枚举/数组） */
function schemaTypeLabel(schema: Record<string, unknown> | undefined): string {
  if (!schema) return 'any'
  // TypeBox 联合字面量（如 ssh.action）→ anyOf:[{const,type},...]
  const anyOf = schema.anyOf
  if (Array.isArray(anyOf)) {
    const parts = anyOf
      .map((m) => {
        if (m && typeof m === 'object' && 'const' in m) {
          return JSON.stringify((m as { const: unknown }).const)
        }
        if (m && typeof m === 'object' && 'type' in m) {
          return String((m as { type: unknown }).type)
        }
        return ''
      })
      .filter(Boolean)
    if (parts.length) return parts.join(' | ')
  }
  if (Array.isArray(schema.enum)) {
    return schema.enum.map((v) => JSON.stringify(v)).join(' | ')
  }
  const type = typeof schema.type === 'string' ? schema.type : undefined
  if (type === 'array') {
    const items = schema.items
    const itemType =
      items && typeof items === 'object' && typeof (items as { type?: unknown }).type === 'string'
        ? (items as { type: string }).type
        : 'any'
    return `${itemType}[]`
  }
  return type ?? 'any'
}

/** 单个参数行（object / object[] 递归展示内部字段，左侧缩进竖线区分层级） */
function ParamItem({ row }: { row: ToolParamRow }): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <div className="rounded-md border border-border-secondary/60 px-3 py-2">
      <div className="flex items-center gap-2 flex-wrap">
        <code className="text-[12px] font-mono text-text-primary">{row.name}</code>
        <span className="text-[10px] font-mono text-accent">{row.type}</span>
        <span className={`text-[10px] ${row.required ? 'text-warning' : 'text-text-tertiary'}`}>
          {row.required ? t('settings.toolMetaRequired') : t('settings.toolMetaOptional')}
        </span>
      </div>
      {row.description && (
        <p className="text-[11px] text-text-secondary mt-1 whitespace-pre-wrap">
          {row.description}
        </p>
      )}
      {row.children && row.children.length > 0 && (
        <div className="mt-2 pl-3 border-l border-border-secondary/60 space-y-2">
          {row.children.map((c) => (
            <ParamItem key={c.name} row={c} />
          ))}
        </div>
      )}
    </div>
  )
}

/** 工具 metadata 卡片：name + group + 发给 LLM 的 description + 参数表 */
function ToolMetaCard({ def }: { def: BuiltinToolDefinition }): React.JSX.Element {
  const { t } = useTranslation()
  const params = expandParams(def.parameters)

  return (
    <div className="px-5 py-5">
      <SettingsSection title={t('settings.toolMetaTitle')}>
        <div className="px-4 py-3 space-y-3">
          {/* 名称 + 标签 + 分组 */}
          <div className="flex items-center gap-2 flex-wrap">
            <code className="text-[13px] font-mono font-semibold text-text-primary">
              {def.name}
            </code>
            {def.label && def.label !== def.name && (
              <span className="text-[11px] text-text-tertiary">{def.label}</span>
            )}
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-bg-tertiary text-text-tertiary">
              {def.group}
            </span>
          </div>

          {/* 描述（与发给 LLM 一致） */}
          <p className="text-[12px] leading-relaxed text-text-secondary whitespace-pre-wrap">
            {def.description}
          </p>

          {/* 参数 */}
          <div>
            <div className="text-[11px] font-medium text-text-tertiary mb-1.5">
              {t('settings.toolMetaParams')}
            </div>
            {params.length === 0 ? (
              <p className="text-[11px] text-text-tertiary">{t('settings.toolMetaNoParams')}</p>
            ) : (
              <div className="space-y-2">
                {params.map((p) => (
                  <ParamItem key={p.name} row={p} />
                ))}
              </div>
            )}
          </div>
        </div>
      </SettingsSection>
    </div>
  )
}

/** 「LLM 工具」设置页：每工具一个子页，顶部 metadata 卡片 + 宿主特有配置 */
export function BuiltinToolsView({
  loadDefinitions,
  renderToolExtra,
  extraTabs = []
}: BuiltinToolsViewProps): React.JSX.Element {
  const [defs, setDefs] = useState<BuiltinToolDefinition[]>([])
  const [subTab, setSubTab] = useState<string>('')

  // 仅在挂载时拉取一次：用 ref 捕获首次传入的 loadDefinitions，避免把它放进 effect 依赖
  const loadRef = useRef(loadDefinitions)
  useEffect(() => {
    loadRef.current().then((list) => {
      setDefs(list)
      setSubTab((cur) => cur || list[0]?.name || '')
    })
  }, [])

  const activeExtra = extraTabs.find((tab) => tab.id === subTab)
  const activeDef = defs.find((d) => d.name === subTab)

  return (
    <div className="flex flex-1 min-h-0 h-full">
      {/* 左侧工具导航：每个内置工具一项，末尾追加宿主功能页 */}
      <div className="w-[220px] flex-shrink-0 border-r border-border-secondary flex flex-col">
        <div className="flex-1 overflow-y-auto py-2 px-2 space-y-0.5">
          {defs.map((d) => (
            <SubTabButton
              key={d.name}
              icon={<ToolTabIcon name={d.icon} />}
              label={d.label || d.name}
              active={subTab === d.name}
              onClick={() => setSubTab(d.name)}
            />
          ))}
          {extraTabs.map((tab) => (
            <SubTabButton
              key={tab.id}
              icon={tab.icon ?? <Wrench size={14} className="shrink-0 text-text-tertiary" />}
              label={tab.label}
              active={subTab === tab.id}
              onClick={() => setSubTab(tab.id)}
            />
          ))}
        </div>
      </div>

      {/* 右侧内容区 */}
      <div className="flex-1 min-w-0 overflow-y-auto">
        {activeExtra ? (
          activeExtra.content
        ) : activeDef ? (
          <div>
            <ToolMetaCard def={activeDef} />
            {renderToolExtra?.(activeDef.name)}
          </div>
        ) : null}
      </div>
    </div>
  )
}
