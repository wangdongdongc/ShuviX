import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Plus, Trash2, Eye, EyeOff } from 'lucide-react'
import { SettingsSection } from '../settings/SettingsPrimitives'

// 扩展能力卡已移至 @shuvix/app-shell 的 ExtensionsSection（项目编辑页与会话设置共用）

// ─── 高级：环境变量 ────────────────────────────────────

export interface EnvVar {
  key: string
  value: string
  sensitive: boolean
}

interface ProjectEnvVarsSectionProps {
  envVars: EnvVar[]
  onChange: (envVars: EnvVar[]) => void
}

export function ProjectEnvVarsSection({
  envVars,
  onChange
}: ProjectEnvVarsSectionProps): React.JSX.Element {
  const { t } = useTranslation()
  const [visibility, setVisibility] = useState<Record<number, boolean>>({})
  const toggleVisibility = (i: number): void =>
    setVisibility((prev) => ({ ...prev, [i]: !prev[i] }))

  const update = (idx: number, patch: Partial<EnvVar>): void => {
    const next = [...envVars]
    next[idx] = { ...next[idx], ...patch }
    onChange(next)
  }

  const inputCls =
    'min-w-0 px-2 py-1 rounded-md text-[11px] bg-bg-primary border border-border-secondary/50 text-text-primary placeholder:text-text-tertiary outline-none transition-colors hover:border-border-secondary focus:border-accent/60'

  return (
    <SettingsSection
      title={t('projectForm.envVarsTitle')}
      footer={t('projectForm.envVarsDesc')}
      headerAction={
        <button
          onClick={() => onChange([...envVars, { key: '', value: '', sensitive: false }])}
          className="inline-flex items-center gap-1 text-[11px] text-accent hover:bg-accent/10 px-2 py-1 rounded transition-colors"
        >
          <Plus size={11} />
          {t('projectForm.envVarAdd')}
        </button>
      }
    >
      {envVars.length === 0 ? (
        <div className="px-4 py-4 text-center text-[11px] text-text-tertiary">—</div>
      ) : (
        envVars.map((v, i) => (
          <div key={i} className="flex items-center gap-1.5 px-4 py-2">
            <input
              value={v.key}
              onChange={(e) => update(i, { key: e.target.value })}
              placeholder={t('projectForm.envVarKey')}
              className={`${inputCls} font-mono flex-[2]`}
            />
            {v.sensitive ? (
              <div className="flex-[3] min-w-0 flex items-center gap-0">
                <input
                  value={v.value}
                  type={visibility[i] ? 'text' : 'password'}
                  onChange={(e) => update(i, { value: e.target.value })}
                  placeholder={t('projectForm.envVarValue')}
                  className={`${inputCls} font-mono flex-1 rounded-r-none border-r-0`}
                />
                <button
                  type="button"
                  onClick={() => toggleVisibility(i)}
                  className="px-1.5 self-stretch flex items-center border border-l-0 border-border-secondary/50 rounded-r-md text-text-tertiary hover:text-text-primary bg-bg-primary transition-colors"
                  title={visibility[i] ? 'Hide' : 'Show'}
                >
                  {visibility[i] ? <Eye size={11} /> : <EyeOff size={11} />}
                </button>
              </div>
            ) : (
              <input
                value={v.value}
                onChange={(e) => update(i, { value: e.target.value })}
                placeholder={t('projectForm.envVarValue')}
                className={`${inputCls} font-mono flex-[3]`}
              />
            )}
            <label className="flex items-center gap-1 cursor-pointer select-none shrink-0">
              <input
                type="checkbox"
                checked={v.sensitive}
                onChange={(e) => update(i, { sensitive: e.target.checked })}
                className="rounded border-border-primary accent-accent w-3 h-3"
              />
              <span className="text-[10px] text-text-tertiary">
                {t('projectForm.envVarSensitive')}
              </span>
            </label>
            <button
              onClick={() => onChange(envVars.filter((_, j) => j !== i))}
              className="p-1 rounded text-text-tertiary hover:text-error hover:bg-error/10 shrink-0 transition-colors"
            >
              <Trash2 size={11} />
            </button>
          </div>
        ))
      )}
    </SettingsSection>
  )
}
