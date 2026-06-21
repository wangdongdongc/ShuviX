/**
 * ProjectInfoForm —— 项目「项目信息」表单（共享）。名称可编辑 + 路径只读展示。
 * 平台无关；桌面可在 children 里追加文件系统/提示词等扩展段，扩展只用 name + path。
 */
import { useTranslation } from 'react-i18next'
import { SettingsSection, SettingsRow, InlineInput } from './SettingsPrimitives'

export interface ProjectInfoFormProps {
  name: string
  onNameChange: (v: string) => void
  /** 项目路径/文件夹（只读展示；桌面是绝对路径，扩展是文件夹名） */
  path?: string
  /** 宿主追加的额外段（桌面：文件系统/提示词；扩展：无） */
  children?: React.ReactNode
}

export function ProjectInfoForm({
  name,
  onNameChange,
  path,
  children
}: ProjectInfoFormProps): React.JSX.Element {
  const { t } = useTranslation()
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
        {path !== undefined && (
          <SettingsRow
            title={t('projectForm.path')}
            control={
              <span className="text-[12px] font-mono text-text-tertiary truncate" title={path}>
                {path}
              </span>
            }
          />
        )}
      </SettingsSection>
      {children}
    </>
  )
}
