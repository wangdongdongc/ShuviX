/**
 * Hook 设置页 —— 参照 SubAgentPanel 的"内置 + 用户自定义"两段式布局。
 *
 * 内置 hook 默认展示（只读、不可禁用），用户自定义来自 `~/.shuvix/hooks.json`
 * （点按钮打开，不存在则自动创建空占位）。文件 watcher 自动 reload，UI 自动刷新。
 *
 * 只渲染全局配置 —— 设置窗是全局上下文，不绑定某个 project；
 * 项目级 hook 由 main 进程在 session 上下文中加载与触发，UI 不展示。
 *
 * 协议完整说明 + schema：见 src/main/services/hooks/types.ts 的 JSDoc。
 */

import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { FolderOpen, RefreshCw, AlertCircle } from 'lucide-react'
import { SettingsSection, SettingsRow } from './SettingsPrimitives'
import type { ResolvedHook, HookFileStatus } from '../../../../shared/types/hook'

export function HookSettings(): React.JSX.Element {
  const { t } = useTranslation()
  const [hooks, setHooks] = useState<ResolvedHook[]>([])
  const [globalStatus, setGlobalStatus] = useState<HookFileStatus | null>(null)
  const [reloading, setReloading] = useState(false)

  const load = useCallback(async () => {
    const [list, status] = await Promise.all([
      window.api.hook.list({ includeBuiltin: true }) as Promise<ResolvedHook[]>,
      window.api.hook.status() as Promise<{ global: HookFileStatus }>
    ])
    setHooks(list)
    setGlobalStatus(status.global)
  }, [])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial load
    void load()
  }, [load])

  const handleReload = async (): Promise<void> => {
    setReloading(true)
    try {
      await window.api.hook.reload()
      await load()
    } finally {
      setReloading(false)
    }
  }

  const handleOpenFile = async (): Promise<void> => {
    await window.api.hook.openConfigFile('global')
  }

  const builtins = hooks.filter((h) => h.source === 'builtin')
  // global + project 都归类为「用户自定义」（虽然当前设置页只有 global）
  const userHooks = hooks.filter((h) => h.source !== 'builtin')

  return (
    <div className="flex-1 px-5 py-5 space-y-5">
      {/* 顶部说明 */}
      <p className="text-[11px] text-text-tertiary leading-relaxed">
        {t('settings.hooksDescription')}
      </p>

      {/* 内置 */}
      {builtins.length > 0 && (
        <SettingsSection title={t('settings.hooksBuiltin')}>
          {builtins.map((h, idx) => (
            <HookRow key={`builtin:${idx}`} hook={h} />
          ))}
        </SettingsSection>
      )}

      {/* 用户自定义 */}
      <SettingsSection
        title={t('settings.hooksUser')}
        headerAction={
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={handleOpenFile}
              className="flex items-center gap-1.5 px-2.5 py-1.5 rounded text-[11px] text-accent hover:bg-accent/10 transition-colors"
            >
              <FolderOpen size={12} />
              {t('settings.hooksOpenFile')}
            </button>
            <button
              type="button"
              onClick={handleReload}
              disabled={reloading}
              className="flex items-center gap-1.5 px-2.5 py-1.5 rounded text-[11px] text-text-secondary hover:bg-bg-hover transition-colors disabled:opacity-50"
            >
              <RefreshCw size={12} className={reloading ? 'animate-spin' : ''} />
              {t('settings.hooksReload')}
            </button>
          </div>
        }
        preamble={globalStatus && !globalStatus.ok ? <StatusError status={globalStatus} /> : null}
      >
        {userHooks.length === 0 ? (
          <div className="px-4 py-6 text-center">
            <p className="text-[11px] text-text-tertiary">{t('settings.hooksUserEmpty')}</p>
            <p className="text-[10px] text-text-tertiary mt-1">
              <code className="font-mono">~/.shuvix/hooks.json</code>
            </p>
          </div>
        ) : (
          userHooks.map((h, idx) => <HookRow key={`user:${idx}`} hook={h} />)
        )}
      </SettingsSection>
    </div>
  )
}

function HookRow({ hook }: { hook: ResolvedHook }): React.JSX.Element {
  const { t } = useTranslation()
  // builtin：描述用 i18n 翻译，普通文本；user：描述 = command，等宽字体
  const description = hook.descriptionKey ? (
    <span>{t(hook.descriptionKey)}</span>
  ) : (
    <span className="font-mono break-all">{hook.description}</span>
  )
  return (
    <SettingsRow
      title={
        <div className="flex items-center gap-2 min-w-0">
          <span className="font-medium">{hook.event}</span>
          <code className="text-[9px] text-text-tertiary font-mono shrink-0">
            matcher: {hook.matcher}
          </code>
        </div>
      }
      description={description}
      control={<span className="text-[10px] text-text-tertiary font-mono">{hook.timeout}s</span>}
    />
  )
}

function StatusError({ status }: { status: HookFileStatus }): React.JSX.Element | null {
  const { t } = useTranslation()
  if (status.ok) return null
  const label =
    status.kind === 'parse'
      ? t('settings.hooksStatusParseError')
      : t('settings.hooksStatusSchemaError')
  return (
    <div className="border border-error/40 bg-error/5 rounded-md p-2.5">
      <div className="flex items-start gap-2 text-[11px]">
        <AlertCircle size={14} className="text-error shrink-0 mt-0.5" />
        <div className="flex-1 min-w-0">
          <div className="text-text-primary">
            <span className="font-medium">{label}: </span>
            <span className="text-text-secondary break-words">{status.message}</span>
          </div>
          {status.errors && status.errors.length > 0 && (
            <ul className="mt-1 ml-3 list-disc text-[10px] text-text-tertiary space-y-0.5">
              {status.errors.slice(0, 5).map((e, i) => (
                <li key={i}>{e}</li>
              ))}
              {status.errors.length > 5 && <li>… +{status.errors.length - 5} more</li>}
            </ul>
          )}
        </div>
      </div>
    </div>
  )
}
