/**
 * 目标的缺省上限（设置 → 通用 → 目标；目标模式，docs/goal-mode-design.md §6）。
 *
 * 两个设置键，主进程设目标时现读（goalService.defaultLimits），所以改了只影响之后设的目标；已有的目标在目标栏里单独改：
 *  - `goal.defaultMaxTurns`：宿主替目标续跑的轮数上限，缺省 50；
 *  - `goal.stallTurns`：连续几轮无进展就暂停，缺省 3。
 *
 * 失焦时才写（同 InlineInput 的惯例）；不合法的值不写，输入框退回上一次的值。按裁决，设置页的上限不带「实验」标签。
 * 读到之前不画：数字不能先显示缺省再跳成别的。
 */
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { InlineInput, SettingsRow, SettingsSection } from './SettingsPrimitives'
import {
  GOAL_SETTING_KEYS,
  goalDefaultsOf,
  goalSettingValue,
  type GoalDefaults
} from './goalSettingsValues'

export function GoalSettings(): React.JSX.Element | null {
  const { t } = useTranslation()
  // saved = 设置里现在的值（不合法的输入退回它）；draft = 输入框里的字
  const [saved, setSaved] = useState<GoalDefaults | null>(null)
  const [draft, setDraft] = useState<GoalDefaults | null>(null)

  useEffect(() => {
    let alive = true
    void Promise.all([
      window.api.settings.get(GOAL_SETTING_KEYS.turns),
      window.api.settings.get(GOAL_SETTING_KEYS.stall)
    ]).then(([turns, stall]) => {
      if (!alive) return
      const values = goalDefaultsOf({ turns, stall })
      setSaved(values)
      setDraft(values)
    })
    return () => {
      alive = false
    }
  }, [])

  if (!saved || !draft) return null

  const commit = (field: keyof GoalDefaults): void => {
    const value = goalSettingValue(draft[field])
    if (value === null) {
      setDraft({ ...draft, [field]: saved[field] })
      return
    }
    setSaved({ ...saved, [field]: value })
    setDraft({ ...draft, [field]: value })
    void window.api.settings.set({ key: GOAL_SETTING_KEYS[field], value })
  }
  const field = (name: keyof GoalDefaults, title: string, hint: string): React.JSX.Element => (
    <div data-goal-setting={name}>
      <SettingsRow
        title={title}
        description={hint}
        control={
          <InlineInput
            type="number"
            min={1}
            width={110}
            value={draft[name]}
            onChange={(value) => setDraft({ ...draft, [name]: value })}
            onBlur={() => commit(name)}
          />
        }
      />
    </div>
  )

  return (
    <div className="px-5 pb-5" data-goal-settings>
      <SettingsSection
        title={t('settings.goalSection')}
        description={t('settings.goalSectionHint')}
      >
        {field('turns', t('settings.goalDefaultTurns'), t('settings.goalDefaultTurnsHint'))}
        {field('stall', t('settings.goalStallTurns'), t('settings.goalStallTurnsHint'))}
      </SettingsSection>
    </div>
  )
}
