import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertCircle } from 'lucide-react'
import { SettingsSection, SettingsBlock } from './SettingsPrimitives'
import { PromptSectionsEditor } from '../sidebar/PromptSectionsEditor'
import { useSettingsStore } from '../../stores/settingsStore'
import type { ProjectPromptSection } from '../../../../shared/types/promptSection'

interface BuiltinSectionItem {
  id: string
  title: string
  content: string | null
  disabled: boolean
  dynamic: boolean
}

/**
 * 系统提示词设置 Tab
 *
 * - 全局自由文本（settings.systemPrompt 即 general.systemPrompt key）
 * - 内置卡片：仅可启用/禁用，内容由 i18n + main 端动态渲染
 * - 自定义卡片：复用项目级 PromptSectionsEditor（增删改 + 拖拽）
 */
export function SystemPromptSettings(): React.JSX.Element {
  const { t, i18n: i18nInstance } = useTranslation()
  const { systemPrompt, setSystemPrompt, systemPromptEnabled } = useSettingsStore()
  const [localSystemPrompt, setLocalSystemPrompt] = useState(systemPrompt)
  const [builtins, setBuiltins] = useState<BuiltinSectionItem[]>([])
  const [customSections, setCustomSections] = useState<ProjectPromptSection[]>([])
  const [previewOpen, setPreviewOpen] = useState<{ title: string; body: string } | null>(null)

  useEffect(() => {
    setLocalSystemPrompt(systemPrompt)
  }, [systemPrompt])

  const reloadBuiltins = useCallback(async () => {
    const list = await window.api.settings.listBuiltinSections()
    setBuiltins(list)
  }, [])

  useEffect(() => {
    reloadBuiltins()
    window.api.settings.getCustomSections().then((sections) => setCustomSections(sections ?? []))
  }, [reloadBuiltins, i18nInstance.language])

  const handleSystemPromptBlur = (): void => {
    if (localSystemPrompt !== systemPrompt) {
      setSystemPrompt(localSystemPrompt)
      window.api.settings.set({ key: 'general.systemPrompt', value: localSystemPrompt })
    }
  }

  const handleToggleBuiltin = async (id: string, currentDisabled: boolean): Promise<void> => {
    const nextDisabled = !currentDisabled
    setBuiltins((prev) =>
      prev.map((item) => (item.id === id ? { ...item, disabled: nextDisabled } : item))
    )
    const nextIds = builtins
      .map((item) => (item.id === id ? { ...item, disabled: nextDisabled } : item))
      .filter((item) => item.disabled)
      .map((item) => item.id)
    await window.api.settings.setBuiltinDisabled(nextIds)
  }

  const handleCustomChange = (sections: ProjectPromptSection[]): void => {
    setCustomSections(sections)
    window.api.settings.setCustomSections(sections)
  }

  const handlePreview = async (item: BuiltinSectionItem): Promise<void> => {
    try {
      const body = await window.api.settings.previewBuiltinSection({ id: item.id })
      setPreviewOpen({ title: item.title, body: body || t('systemPromptCards.envPreviewError') })
    } catch {
      setPreviewOpen({
        title: item.title,
        body: t('systemPromptCards.envPreviewError')
      })
    }
  }

  const disabled = !systemPromptEnabled

  return (
    <div className="flex-1 px-5 py-5 space-y-4">
      {/* 总开关关闭时的警告条（开关本身在二级 Tab 行末，由 ContextManagementSettings 渲染） */}
      {disabled && (
        <div className="flex items-start gap-2 px-3 py-2 rounded-lg border border-amber-500/30 bg-amber-500/5">
          <AlertCircle size={12} className="text-amber-500 shrink-0 mt-0.5" />
          <p className="text-[11px] text-amber-500 leading-relaxed">
            {t('settings.systemPromptDisabledWarning')}
          </p>
        </div>
      )}

      {/* 内部设置：总开关关闭时整体禁用编辑 */}
      <div
        className={disabled ? 'pointer-events-none opacity-60 select-none' : undefined}
        aria-disabled={disabled}
      >
        <SettingsSection title={t('systemPromptCards.tabTitle')}>
          {/* 全局自由文本 */}
          <SettingsBlock
            label={t('systemPromptCards.globalLabel')}
            description={t('systemPromptCards.globalDesc')}
          >
            <textarea
              value={localSystemPrompt}
              onChange={(e) => setLocalSystemPrompt(e.target.value)}
              onBlur={handleSystemPromptBlur}
              rows={4}
              disabled={disabled}
              className="zen-textarea leading-relaxed"
              placeholder={t('systemPromptCards.globalPlaceholder')}
            />
          </SettingsBlock>

          {/* 内置卡片子标题 */}
          <SubSectionHeader
            title={t('systemPromptCards.builtinSection')}
            description={t('systemPromptCards.builtinSectionDesc')}
          />
          {builtins.map((item) => (
            <BuiltinSectionRow
              key={item.id}
              item={item}
              disabled={disabled}
              onToggle={() => handleToggleBuiltin(item.id, item.disabled)}
              onPreview={() => handlePreview(item)}
            />
          ))}

          {/* 自定义卡片子标题 */}
          <SubSectionHeader
            title={t('systemPromptCards.customSection')}
            description={t('systemPromptCards.customSectionDesc')}
          />
          <PromptSectionsEditor sections={customSections} onChange={handleCustomChange} />
        </SettingsSection>
      </div>

      {/* environment 预览浮层 */}
      {previewOpen && (
        <div
          className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-6"
          onClick={() => setPreviewOpen(null)}
        >
          <div
            className="bg-bg-primary border border-border-secondary rounded-xl max-w-2xl w-full max-h-[70vh] flex flex-col shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-5 py-3 border-b border-border-secondary flex items-center justify-between">
              <div className="text-[13px] font-semibold text-text-primary">
                {t('systemPromptCards.envPreviewTitle')}: {previewOpen.title}
              </div>
              <button
                onClick={() => setPreviewOpen(null)}
                className="text-[11px] text-text-tertiary hover:text-text-primary px-2 py-0.5 rounded transition-colors"
              >
                {t('systemPromptCards.envPreviewClose')}
              </button>
            </div>
            <pre className="px-5 py-4 text-[12px] text-text-secondary whitespace-pre-wrap leading-relaxed overflow-y-auto font-mono">
              {previewOpen.body}
            </pre>
          </div>
        </div>
      )}
    </div>
  )
}

/** 同一 SettingsSection 卡片内部用于分隔 textarea / 内置 / 自定义 三段的子标题行 */
function SubSectionHeader({
  title,
  description
}: {
  title: string
  description?: string
}): React.JSX.Element {
  return (
    <div className="px-4 py-2.5 bg-bg-secondary/40">
      <div className="text-[11px] font-semibold text-text-secondary uppercase tracking-wide">
        {title}
      </div>
      {description && (
        <div className="text-[10px] text-text-tertiary mt-0.5 leading-relaxed">{description}</div>
      )}
    </div>
  )
}

function BuiltinSectionRow({
  item,
  disabled,
  onToggle,
  onPreview
}: {
  item: BuiltinSectionItem
  disabled?: boolean
  onToggle: () => void
  onPreview: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <div className="px-4 py-3">
      <div className="flex items-center justify-between gap-3">
        <div className="text-[13px] text-text-primary font-medium">{item.title}</div>
        <label className="inline-flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={!item.disabled}
            disabled={disabled}
            onChange={onToggle}
            className="rounded border-border-primary accent-accent w-3.5 h-3.5 disabled:opacity-60 disabled:cursor-not-allowed"
          />
        </label>
      </div>
      {item.dynamic ? (
        <button onClick={onPreview} className="mt-1.5 text-[11px] text-accent hover:underline">
          {t('systemPromptCards.envPreviewButton')}
        </button>
      ) : (
        item.content && (
          <div className="mt-1.5 text-[11px] text-text-tertiary leading-relaxed whitespace-pre-wrap">
            {item.content}
          </div>
        )
      )}
    </div>
  )
}
