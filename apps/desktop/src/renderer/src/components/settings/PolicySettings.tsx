import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Lock,
  Shield,
  Loader2,
  RefreshCw,
  FolderOpen,
  FileText,
  Terminal,
  GitBranch,
  Database,
  Wrench,
  Plus,
  Copy,
  Trash2,
  AlertTriangle,
  type LucideIcon
} from 'lucide-react'
import { POLICY_EFFECT_CLASS } from '@shuvix/app-shell'
import { ConfirmDialog } from '../common/ConfirmDialog'
import { BuiltinSourceView, RegistryNoteView } from './RegistryNoteView'
import { fileNameOf, uniqueName } from './registryFiles'

/**
 * 设置页顶层「安全策略」tab —— 与智能体 tab 同形：左侧每个策略一个子项（内置与
 * 用户合并为同一列表、内置置顶），右侧为详情。
 *
 * 策略是纯 md 驱动（内置随包发布只读；用户策略放 ~/.shuvix/policies/<name>.md 即生效，
 * 同名覆盖内置）。**用户策略的详情就是它的笔记本会话**（RegistryNoteView —— 与笔记本、知识库
 * 条目同一条路：live-preview、自动保存、外部改动重载）：rules/lets/scope 是嵌套结构，做成表单
 * 成本远高于收益，frontmatter 属性卡本就给结构化摘要 + 解析器实时校验徽章。写到一半的非法文件
 * 与外部编辑器写坏的一样对待：不生效、不遮蔽内置，列进「无法解析」分组，点开照样接着改 ——
 * 一份存在但非法的策略被静默跳过，正是这一页要让人看得见的失败模式。
 */

/** 新建策略的初值（YAML 注释原样保留 —— 原文编辑模型的直接体现） */
function newPolicyTemplate(t: (key: string) => string, name: string): string {
  return [
    '---',
    'shuvix: policy v1',
    `name: ${name}`,
    `description: ${t('settings.policyTemplateDesc')}`,
    `# ${t('settings.policyTemplateHint')}`,
    'shuvix-policy-rules:',
    '  - effect: ask',
    '    subject.kind: [agent]',
    '    object.type: [command]',
    '---',
    '',
    t('settings.policyTemplateBody'),
    ''
  ].join('\n')
}

/**
 * object.type → 图标。object 是开放属性文档（`{type: string} & attrs`），新增
 * 类型无需改引擎，因此这里只覆盖内置 PEP 目前会产出的类型，未知类型退回 Shield。
 */
const OBJECT_TYPE_ICON: Record<string, LucideIcon> = {
  path: FileText,
  command: Terminal,
  gitTool: GitBranch,
  database: Database,
  invocation: Wrench
}

/**
 * 一个策略触达的 object.type 集合 = 策略级 scope ∪ 每条规则的结构化条件
 * （scope 是 AND 进每条规则的共同条件，两处都可能声明）。`'*'` 与未声明一样
 * 视为「不限」——不参与集合。
 */
function objectTypesOf(policy: PolicyInfo): string[] {
  const types = new Set<string>()
  const collect = (c?: PolicyConditionsInfo): void => {
    for (const v of c?.['object.type'] ?? []) if (v !== '*') types.add(v)
  }
  collect(policy.scope)
  for (const rule of policy.rules) collect(rule.conditions)
  return [...types]
}

/** 单一 object.type 才给专属图标；混合类型/不限/未知类型都退回通用 Shield */
function policyIcon(policy: PolicyInfo): { Icon: LucideIcon; objectType: string | null } {
  const types = objectTypesOf(policy)
  const only = types.length === 1 ? types[0] : null
  return { Icon: (only && OBJECT_TYPE_ICON[only]) || Shield, objectType: only }
}

/** 用户文件的选中键（合法与解析不过的共用一个键空间，见 keyOf） */
function fileKey(fileName: string): string {
  return `file:${fileName}`
}

/**
 * 列表选中键。内置按名（它没有文件）；用户策略按**文件名** —— 自动保存下名字随时在变、
 * 合法性随时在翻，文件名不变，选中项与开着的笔记本才不会跟着跳。
 */
function keyOf(p: PolicyInfo): string {
  return p.source === 'builtin' ? `builtin:${p.name}` : fileKey(fileNameOf(p.basePath))
}

/** 展示顺序：内置置顶（含被遮蔽的），组内保持后端的字母序 */
function orderPolicies(list: PolicyInfo[]): PolicyInfo[] {
  return [...list.filter((p) => p.source === 'builtin'), ...list.filter((p) => p.source === 'user')]
}

export function PolicySettings(): React.JSX.Element {
  const { t } = useTranslation()

  const [policies, setPolicies] = useState<PolicyInfo[]>([])
  const [invalid, setInvalid] = useState<InvalidPolicyFile[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  /** 新建 / 覆盖副本 / 删除 / 读原文失败的原因 —— 不静默吞掉，显示在详情区顶部 */
  const [error, setError] = useState<string | null>(null)
  /** 选中内置策略的等价 md（只读查看 + 覆盖副本初值）；用户策略的详情是笔记本，自己读盘 */
  const [source, setSource] = useState<{ name: string; text: string } | null>(null)
  /**
   * 删除确认：生效的用户文件按名删；无法解析的、或同名里被遮蔽的按文件名删（按名删会删到生效的那份）。
   * 被遮蔽的顺带记下胜出的那份（then），删完停在它上面
   */
  const [confirmingDelete, setConfirmingDelete] = useState<
    { name: string } | { fileName: string; then?: string } | null
  >(null)

  const load = useCallback(async (): Promise<{
    list: PolicyInfo[]
    bad: InvalidPolicyFile[]
  }> => {
    const [list, bad] = await Promise.all([
      window.api.policy.list(),
      window.api.policy.listInvalid()
    ])
    setPolicies(list)
    setInvalid(bad)
    setLoading(false)
    return { list, bad }
  }, [])

  useEffect(() => {
    load().then(({ list }) => {
      const first = orderPolicies(list)[0]
      setSelectedKey((cur) => cur ?? (first ? keyOf(first) : null))
    })
  }, [load])

  const select = (key: string): void => {
    setError(null)
    setSelectedKey(key)
  }

  const handleRefresh = async (): Promise<void> => {
    setRefreshing(true)
    try {
      const { list, bad } = await load()
      setSelectedKey((cur) => {
        if (list.some((p) => keyOf(p) === cur) || bad.some((f) => fileKey(f.fileName) === cur)) {
          return cur
        }
        const first = orderPolicies(list)[0]
        return first ? keyOf(first) : null
      })
    } finally {
      setRefreshing(false)
    }
  }

  const selected = policies.find((p) => keyOf(p) === selectedKey) ?? null
  // 用户文件的选中与它此刻合不合法无关：翻面的一瞬（或两次列表请求之间）两边都查不到，
  // 开着的笔记本也不该因此卸载
  const selectedFile = selectedKey?.startsWith('file:') ? selectedKey.slice('file:'.length) : null

  // 选中内置 → 拉等价 md
  const builtinName = selected?.source === 'builtin' ? selected.name : null
  useEffect(() => {
    if (!builtinName) {
      setSource(null)
      return undefined
    }
    let alive = true
    void window.api.policy.getSource({ name: builtinName, source: 'builtin' }).then((r) => {
      if (!alive) return
      if ('error' in r) {
        setSource(null)
        setError(r.error)
        return
      }
      setSource({ name: builtinName, text: r.text })
    })
    return () => {
      alive = false
    }
  }, [builtinName])

  /** 新建与覆盖副本共用：落一份新文件，重扫并选中它 —— 它的详情就是刚建好的笔记本 */
  const createAndSelect = async (text: string): Promise<void> => {
    setError(null)
    const r = await window.api.policy.create({ text })
    if (!r.success) {
      setError(r.error || t('settings.policySaveFailed'))
      return
    }
    const { list } = await load()
    const hit = list.find((p) => p.source === 'user' && p.name === r.name)
    if (hit) setSelectedKey(keyOf(hit))
  }

  const handleDelete = async (
    target: { name: string } | { fileName: string; then?: string }
  ): Promise<void> => {
    setConfirmingDelete(null)
    const r =
      'name' in target
        ? await window.api.policy.delete({ name: target.name })
        : await window.api.policy.deleteByFile({ fileName: target.fileName })
    if (!r.success) {
      setError(r.error ?? 'Delete failed')
      return
    }
    const { list } = await load()
    // 按名删的是生效的那份：落到同名里接着生效的那份（另一份用户文件，或恢复生效的内置）；
    // 删掉被遮蔽的那份，胜出的那份还在、停在它上面；都没有就退回首项
    const restored =
      'name' in target
        ? list.find((p) => p.name === target.name && !p.overridden)
        : target.then
          ? list.find((p) => p.source === 'user' && fileNameOf(p.basePath) === target.then)
          : undefined
    const next = restored ?? orderPolicies(list)[0]
    setSelectedKey(next ? keyOf(next) : null)
  }

  return (
    <div className="flex flex-1 min-h-0 h-full">
      {/* 左侧：策略列表 */}
      <div className="w-[220px] flex-shrink-0 border-r border-border-secondary flex flex-col">
        <div className="flex-1 overflow-y-auto py-2 px-2 space-y-0.5">
          {loading ? (
            <div className="flex items-center gap-2 text-text-tertiary py-2 px-1">
              <Loader2 size={14} className="animate-spin" />
              <span className="text-[11px]">{t('common.loading') || 'Loading...'}</span>
            </div>
          ) : (
            <>
              {orderPolicies(policies).map((policy) => (
                <PolicyRow
                  key={keyOf(policy)}
                  policy={policy}
                  selected={selectedKey === keyOf(policy)}
                  onSelect={() => select(keyOf(policy))}
                />
              ))}
              {/* 无法解析的文件：不生效也不遮蔽内置，但必须可见 —— 否则用户无从发现更无从修复 */}
              {invalid.length > 0 && (
                <div className="pt-2">
                  <div className="px-2 py-1 text-[10px] uppercase tracking-wide text-amber-500/80">
                    {t('settings.policyInvalidGroup', { count: invalid.length })}
                  </div>
                  {invalid.map((f) => (
                    <button
                      key={f.fileName}
                      onClick={() => select(fileKey(f.fileName))}
                      title={f.error}
                      className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-left transition-colors ${
                        selectedKey === fileKey(f.fileName)
                          ? 'bg-amber-500/10 text-amber-500'
                          : 'text-text-secondary hover:bg-bg-hover hover:text-text-primary'
                      }`}
                    >
                      <AlertTriangle size={14} className="shrink-0 text-amber-500" />
                      <span className="min-w-0 flex-1 text-xs font-mono truncate">
                        {f.fileName}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </>
          )}
        </div>

        <EffectLadder />

        {/* 底部操作：新建 / 打开用户策略目录 / 重扫描 */}
        <div className="border-t border-border-secondary p-2 flex items-center gap-1.5">
          <button
            onClick={() =>
              void createAndSelect(
                newPolicyTemplate(
                  t,
                  uniqueName(
                    'my-policy',
                    policies.map((p) => p.name)
                  )
                )
              )
            }
            title={t('settings.policyNew')}
            className="flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-lg border border-dashed border-border-secondary text-[11px] text-text-secondary hover:text-text-primary hover:border-accent/40 hover:bg-accent/5 transition-colors"
          >
            <Plus size={12} />
            {t('settings.policyNew')}
          </button>
          <button
            onClick={() => void window.api.policy.openFolder()}
            title={t('settings.policyFsHint')}
            className="flex-1 flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-lg border border-dashed border-border-secondary text-[11px] text-text-secondary hover:text-text-primary hover:border-accent/40 hover:bg-accent/5 transition-colors"
          >
            <FolderOpen size={12} />
            {t('settings.policyOpenFolder')}
          </button>
          <button
            onClick={handleRefresh}
            disabled={refreshing}
            title={t('settings.policyRefresh')}
            className="px-2 py-1.5 rounded-lg border border-dashed border-border-secondary text-text-secondary hover:text-text-primary hover:border-accent/40 hover:bg-accent/5 transition-colors disabled:opacity-50"
          >
            <RefreshCw size={12} className={refreshing ? 'animate-spin' : ''} />
          </button>
        </div>
      </div>

      {/* 右侧：详情 —— 内置是等价 md 的只读查看，用户文件是它的笔记本 */}
      <div className="flex-1 min-w-0 flex flex-col min-h-0 overflow-y-auto">
        {error && (
          <div className="mx-4 mt-4 px-3 py-2 rounded-lg bg-red-500/10 text-red-500 text-[11px] whitespace-pre-wrap break-words">
            {error}
          </div>
        )}
        {selected?.source === 'builtin' ? (
          <>
            <PolicyHeader
              policy={selected}
              onCreateOverride={
                !selected.overridden && source?.name === selected.name
                  ? () => void createAndSelect(source.text)
                  : undefined
              }
            />
            {source?.name === selected.name && (
              <BuiltinSourceView
                key={selected.name}
                documentId={`${selected.name}.md`}
                text={source.text}
              />
            )}
          </>
        ) : (
          selectedFile && (
            <>
              <PolicyHeader
                policy={selected}
                fileName={selectedFile}
                onDelete={() =>
                  setConfirmingDelete(
                    selected && !selected.overridden
                      ? { name: selected.name }
                      : { fileName: selectedFile, then: selected?.overriddenBy }
                  )
                }
              />
              <RegistryNoteView
                key={selectedFile}
                kind="policy"
                fileName={selectedFile}
                onFileChanged={load}
              />
            </>
          )
        )}
      </div>

      {confirmingDelete && (
        <ConfirmDialog
          title={t('settings.policyDeleteConfirmTitle')}
          description={
            'name' in confirmingDelete
              ? t('settings.policyDeleteConfirmDesc', { name: confirmingDelete.name })
              : t('settings.policyDeleteFileConfirmDesc', { name: confirmingDelete.fileName })
          }
          confirmText={t('common.delete')}
          cancelText={t('common.cancel')}
          onConfirm={() => void handleDelete(confirmingDelete)}
          onCancel={() => setConfirmingDelete(null)}
        />
      )}
    </div>
  )
}

/**
 * 详情头部：名称 + 来源徽标 + 路径 / 提示 + 动作。`policy` 为 null 表示选中的用户文件此刻
 * 解析不过 —— 标题退回文件名，提示它被跳过的后果。
 */
function PolicyHeader({
  policy,
  fileName,
  onCreateOverride,
  onDelete
}: {
  policy: PolicyInfo | null
  fileName?: string
  onCreateOverride?: () => void
  onDelete?: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const builtin = policy?.source === 'builtin'
  return (
    <div className="flex items-center gap-2 px-4 py-3 border-b border-border-secondary">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap">
          {policy ? (
            <>
              <span className="text-sm font-semibold text-text-primary truncate">
                {policy.displayName}
              </span>
              <span
                className={`shrink-0 flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[9px] ${
                  builtin ? 'bg-bg-secondary text-text-tertiary' : 'bg-accent/10 text-accent'
                }`}
              >
                {builtin && <Lock size={9} />}
                {builtin ? t('settings.policySourceBuiltin') : t('settings.policySourceUser')}
              </span>
              {policy.overridden && (
                <span className="px-1.5 py-0.5 rounded-md text-[9px] shrink-0 bg-orange-500/10 text-orange-500">
                  {t('settings.policyOverridden')}
                </span>
              )}
            </>
          ) : (
            <>
              <AlertTriangle size={14} className="shrink-0 text-amber-500" />
              <span className="text-sm font-semibold text-text-primary font-mono truncate">
                {fileName}
              </span>
            </>
          )}
        </div>
        {policy?.basePath ? (
          <div className="font-mono text-[10px] text-text-tertiary truncate mt-0.5">
            {policy.basePath}
          </div>
        ) : (
          <div
            className={`text-[10px] mt-0.5 ${policy ? 'text-text-tertiary' : 'text-amber-500/90'}`}
          >
            {!policy
              ? t('settings.policyInvalidHint')
              : policy.overridden
                ? t('settings.policyOverriddenHint')
                : t('settings.policyFsHint')}
          </div>
        )}
        {policy?.source === 'user' && policy.overridden && (
          // 同名的几份里没胜出：路径照常给，再说清是谁压过了它
          <div className="text-[10px] mt-0.5 text-orange-500/90">
            {t('settings.shadowedByFileHint', { file: policy.overriddenBy })}
          </div>
        )}
      </div>
      {onCreateOverride && (
        <button
          onClick={onCreateOverride}
          className="flex items-center gap-1 px-2 py-1 rounded text-[10px] border border-dashed border-border-secondary text-text-secondary hover:text-text-primary hover:border-accent/40 hover:bg-accent/5 transition-colors"
        >
          <Copy size={10} />
          {t('tool.subAgentCreateOverride')}
        </button>
      )}
      {onDelete && (
        <button
          onClick={onDelete}
          title={t('settings.policyDeleteConfirmTitle')}
          className="p-1.5 rounded-lg text-text-tertiary hover:text-red-500 hover:bg-red-500/10 transition-colors"
        >
          <Trash2 size={14} />
        </button>
      )}
    </div>
  )
}

/**
 * 结算梯子图例 —— 五个 effect 按强弱从左到右排开。
 *
 * 名字里的 `force-` 前缀负责「看到时不误解」，这条图例负责「想不起来时能查」：
 * 用户真正需要确认谁压过谁的时刻，就是他在这一页写规则的时候。
 * 顺序与配色都取自 POLICY_EFFECT_CLASS（属性卡同一份），不在这里另立一套。
 */
function EffectLadder(): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <div className="border-t border-border-secondary px-2 py-1.5">
      <div className="text-[10px] text-text-tertiary mb-1">{t('settings.policyEffectLadder')}</div>
      {/* 220px 的列放不下一行五个徽章，必然换行 —— 因此不用 `›` 分隔：
          换行后第二行会以分隔符开头，看着像笔误。顺序 + 配色足够表达强弱 */}
      <div className="flex flex-wrap items-center gap-1">
        {Object.keys(POLICY_EFFECT_CLASS).map((effect) => (
          <span
            key={effect}
            className={`px-1.5 py-0.5 rounded font-semibold uppercase text-[9px] tracking-wide ${POLICY_EFFECT_CLASS[effect]}`}
          >
            {effect}
          </span>
        ))}
      </div>
    </div>
  )
}

function PolicyRow({
  policy,
  selected,
  onSelect
}: {
  policy: PolicyInfo
  selected: boolean
  onSelect: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const { Icon, objectType } = policyIcon(policy)
  return (
    <button
      onClick={onSelect}
      title={objectType ? `object.type: ${objectType}` : undefined}
      className={`group w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-left transition-colors ${
        selected
          ? 'bg-accent/10 text-accent'
          : 'text-text-secondary hover:bg-bg-hover hover:text-text-primary'
      } ${policy.overridden ? 'opacity-60' : ''}`}
    >
      <Icon size={14} className="shrink-0" />
      <div className="min-w-0 flex-1">
        <div
          className={`text-xs font-medium truncate ${policy.overridden ? 'line-through text-text-tertiary' : ''}`}
        >
          {policy.displayName}
        </div>
      </div>
      {policy.overridden && (
        /* 被同名用户策略覆盖的内置：仅展示,不生效 */
        <span className="shrink-0 px-1.5 py-0.5 rounded text-[9px] bg-bg-secondary text-text-tertiary">
          {t('settings.policyOverridden')}
        </span>
      )}
      {policy.source === 'builtin' && (
        /* 内置随包发布、不可直接编辑 —— 锁即「这行只能建覆盖副本」 */
        <span title={t('settings.policySourceBuiltin')} className="shrink-0 text-text-tertiary">
          <Lock size={11} />
        </span>
      )}
    </button>
  )
}
