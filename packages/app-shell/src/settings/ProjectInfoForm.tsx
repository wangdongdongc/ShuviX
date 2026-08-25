/**
 * ProjectInfoForm —— 项目「基本信息」表单（共享）。名称 + 项目文件夹合并在同一张卡里。
 * 传 onSelectFolder 则文件夹行可更换/选择（桌面）；否则只读展示（扩展只有文件夹名）。
 * 平台无关；桌面可在 children 里追加扩展能力/提示词等段落。
 */
import { useTranslation } from 'react-i18next'
import { FolderOpen, Plus } from 'lucide-react'
import { SettingsSection, SettingsRow, InlineInput } from './SettingsPrimitives'

export interface ProjectInfoFormProps {
  name: string
  onNameChange: (v: string) => void
  /** 项目路径/文件夹（桌面是绝对路径，扩展是文件夹名；行内只显示末段，完整值挂 title） */
  path?: string
  /** 传入则文件夹可更换；缺省为只读展示 */
  onSelectFolder?: () => void
  /** 宿主追加的额外段（桌面：扩展能力/提示词；扩展：无） */
  children?: React.ReactNode
}

export function ProjectInfoForm({
  name,
  onNameChange,
  path,
  onSelectFolder,
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
      </SettingsSection>
      {children}
    </>
  )
}
