/**
 * 属性卡里的「ShuviX 设置」条 —— md 扩展元数据（chat-protocol mdMeta.ts，设计 docs/md-metadata-design.md）。
 *
 * 只放**文件里根本没有对应键**的设置：内置安全策略与 hook 的停用开关（MD_DISABLEABLE_KINDS，存在 ShuviX 里，
 * 不写文件）。能补进 frontmatter 的键（agent 的模型、思考档位）不在这里 —— 它们就在卡片原本那一行上改
 * （FrontmatterFillField），一个键只有一处。这条对其余文件不出现。
 *
 * 停用开关不经写入队列：它只挂在内置 id 上（内置文件自带 id），写完重查即可。侧栏行菜单里有同一个开关。
 * 卡片是纯 DOM 的 CM6 widget，本组件由 LivePreviewEditor 挂进卡片给的槽位（独立 React root）。
 */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { getChatApi, useAppEvent } from '@shuvix/chat-ui'
import type { MdMetaNoteView } from '@shuvix/chat-protocol/mdMeta'
import { InfoHint } from '../settings/SettingsPrimitives'
import { useMdMetaView } from './useMdMetaView'

export interface FrontmatterMetaStripProps {
  /** 这份文件的笔记本会话 —— 主进程按它认文件 */
  sessionId: string
}

// 与 frontmatterCard.ts 的行样式同一套话（标签列宽、行高、弱色小字）—— 改那边要一起改
const ROW = 'flex items-start gap-3 px-1 py-px'
const LABEL = 'w-[140px] shrink-0 truncate text-[12px] leading-6 text-text-tertiary'

export function FrontmatterMetaStrip({
  sessionId
}: FrontmatterMetaStripProps): React.JSX.Element | null {
  const { t } = useTranslation()
  const { view, refresh } = useMdMetaView(sessionId)
  /**
   * 点下去之后先按将要的值画，直到重查回来一份**新的**视图为止（按视图对象认，而不是写完就撤）——
   * 写完立刻撤掉会先露一下旧视图里的旧值，开关就成了「关 → 开 → 关」地闪
   */
  const [optimistic, setOptimistic] = useState<{ value: boolean; base: MdMetaNoteView } | null>(
    null
  )
  const [error, setError] = useState<string | null>(null)
  // 侧栏行菜单里是同一个开关：那边一改，这边重查（两类事件都听，开销只是一次查询）
  useAppEvent('hook.changed', refresh)
  useAppEvent('policy.changed', refresh)

  // 还没问到 / 不是注册表笔记 / 这份文件没有停用开关：整条不出现
  if (!view || view.enabled === undefined || !view.objectId) return null
  const objectId = view.objectId
  const enabled = optimistic && optimistic.base === view ? optimistic.value : view.enabled

  const toggle = async (): Promise<void> => {
    const api = getChatApi().mdMeta
    if (!api) return
    const next = !enabled
    setOptimistic({ value: next, base: view })
    setError(null)
    try {
      const result = await api.setEnabled({ objectId, enabled: next })
      if (!result.success) {
        setError(
          t('notebook.frontmatter.metaWriteFailed', { reason: result.message ?? result.reason })
        )
      }
    } catch (e) {
      setError(
        t('notebook.frontmatter.metaWriteFailed', {
          reason: e instanceof Error ? e.message : String(e)
        })
      )
    }
    refresh()
  }

  return (
    <div className="cm-shuvix-fmcard-meta-strip mt-2 pt-1.5 border-t border-border-secondary/40">
      <div className="flex items-center gap-2 h-6 px-1">
        <span className="text-[11px] font-medium tracking-wide text-text-tertiary">
          {t('notebook.frontmatter.metaTitle')}
        </span>
        <InfoHint hint={t('notebook.frontmatter.metaHint')} />
      </div>
      <div className={`cm-shuvix-fmcard-meta-row ${ROW}`} data-key="enabled">
        <span className={LABEL}>{t('notebook.frontmatter.metaEnabled')}</span>
        <div className="min-w-0 flex-1 flex items-center gap-2 h-6">
          {/* 与卡片布尔行同一副开关（w-7 h-4 胶囊 + 12px 滑块） */}
          <button
            type="button"
            role="switch"
            aria-checked={enabled}
            data-state={enabled ? 'on' : 'off'}
            className={`cm-shuvix-fmcard-meta-toggle inline-flex items-center w-7 h-4 rounded-full px-[2px] transition-colors cursor-pointer ${
              enabled ? 'bg-accent' : 'bg-border-secondary'
            }`}
            onClick={() => void toggle()}
          >
            <span
              className={`block w-3 h-3 rounded-full bg-white shadow-sm transition-transform duration-150 ${
                enabled ? 'translate-x-3' : 'translate-x-0'
              }`}
            />
          </button>
          {!enabled && (
            <span className="cm-shuvix-fmcard-meta-disabled text-[12px] text-text-tertiary">
              {t(
                view.kind === 'hook'
                  ? 'notebook.frontmatter.metaHookDisabled'
                  : 'notebook.frontmatter.metaPolicyDisabled'
              )}
            </span>
          )}
        </div>
      </div>
      {[...view.warnings, ...(error ? [error] : [])].map((message) => (
        <div
          key={message}
          className="cm-shuvix-fmcard-meta-warning mx-1 mt-1 px-2.5 py-1.5 rounded-md text-[11px] leading-relaxed break-words bg-amber-500/10 text-amber-600 dark:text-amber-400"
        >
          {message}
        </div>
      ))}
    </div>
  )
}
