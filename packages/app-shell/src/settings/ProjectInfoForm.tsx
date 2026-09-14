/**
 * ProjectInfoForm —— 项目「基本信息」表单（共享）。名称 + 项目文件夹 + 项目提示词合并在同一张卡里。
 * 传 onSelectFolder 则文件夹行可更换/选择（桌面）；否则只读展示（扩展只有文件夹名）。
 * 传 onSystemPromptChange 才渲染项目提示词（桌面）；扩展没有提示词编辑，不传。
 * 平台无关；桌面可在 children 里追加扩展能力/环境变量等段落。
 */
import { useTranslation } from 'react-i18next'
import { FolderOpen, Plus } from 'lucide-react'
import { SettingsSection, SettingsRow, SettingsBlock, InlineInput } from './SettingsPrimitives'

export interface ProjectInfoFormProps {
  name: string
  onNameChange: (v: string) => void
  /** 项目路径/文件夹（桌面是绝对路径，扩展是文件夹名；行内只显示末段，完整值挂 title） */
  path?: string
  /** 传入则文件夹可更换；缺省为只读展示 */
  onSelectFolder?: () => void
  /** 项目提示词（纯文本；经 shuvix-project-awareness 开关注入会话上下文） */
  systemPrompt?: string
  /** 传入则卡片末尾渲染提示词输入；缺省不渲染 */
  onSystemPromptChange?: (v: string) => void
  /** 宿主追加的额外段（桌面：扩展能力/环境变量；扩展：无） */
  children?: React.ReactNode
}

export function ProjectInfoForm({
  name,
  onNameChange,
  path,
  onSelectFolder,
  systemPrompt = '',
  onSystemPromptChange,
  children
}: ProjectInfoFormProps): React.JSX.Element {
  const { t } = useTranslation()
  const folderName = path ? (path.split(/[\\/]/).filter(Boolean).pop() ?? path) : ''
  const showFolderRow = path !== undefined || onSelectFolder !== undefined

  return (
    <>
      <SettingsSection title={t('projectForm.basicInfoTitle')}>
        <SettingsRow
          title={t('projectForm.name')}
          control={
            <InlineInput
              value={name}
              onChange={onNameChange}
              placeholder={t('projectForm.namePlaceholder')}
              width={260}
            />
          }
        />
        {showFolderRow && (
          <SettingsRow
            title={t('projectForm.folder')}
            control={
              <div className="flex items-center gap-2 min-w-0">
                {path ? (
                  <>
                    <FolderOpen size={11} className="text-text-tertiary shrink-0" />
                    <span
                      className="text-[12px] font-mono text-text-tertiary truncate max-w-[260px]"
                      title={path}
                    >
                      {folderName}
                    </span>
                    {onSelectFolder && (
                      <button
                        onClick={onSelectFolder}
                        className="text-[11px] text-text-tertiary hover:text-accent transition-colors shrink-0"
                      >
                        {t('projectForm.changeFolder')}
                      </button>
                    )}
                  </>
                ) : (
                  onSelectFolder && (
                    <button
                      onClick={onSelectFolder}
                      className="inline-flex items-center gap-1 text-[11px] text-accent hover:bg-accent/10 transition-colors px-2 py-1 rounded"
                    >
                      <Plus size={11} />
                      {t('projectForm.selectFolder')}
                    </button>
                  )
                )}
              </div>
            }
          />
        )}
        {onSystemPromptChange && (
          <SettingsBlock label={t('projectForm.systemPrompt')}>
            {/* 多行输入放不进右侧控件位：标签在上、输入框占满整行，边框与名称输入框同款 */}
            <textarea
              value={systemPrompt}
              onChange={(e) => onSystemPromptChange(e.target.value)}
              placeholder={t('projectForm.systemPromptPlaceholder')}
              rows={3}
              spellCheck={false}
              className="block w-full px-2.5 py-2 rounded-md text-xs leading-relaxed bg-bg-primary text-text-primary border border-border-secondary/50 placeholder:text-text-tertiary transition-colors hover:border-border-secondary focus:outline-none focus:border-accent/60 resize-none [field-sizing:content] min-h-[72px]"
            />
          </SettingsBlock>
        )}
      </SettingsSection>
      {children}
    </>
  )
}
