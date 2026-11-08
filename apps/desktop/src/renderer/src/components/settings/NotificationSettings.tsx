/**
 * 系统通知开关（设置 → 通用）：一类通知一个开关，缺省开，主进程弹之前现读，所以改了立即生效。
 *
 * 只在桌面窗口里出现：通知弹在运行 ShuviX 的那台机器上，浏览器或手机里的这一页看起来却像在管
 * 那台设备自己的通知。
 */
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  AGENT_NOTIFICATION_KINDS,
  notificationSettingKey,
  type AgentNotificationKind
} from '@shuvix/chat-protocol/notification'
import { SettingsRow, SettingsSection, Toggle } from './SettingsPrimitives'

const ROW_TEXT: Record<AgentNotificationKind, { title: string; hint: string }> = {
  ask: { title: 'settings.notificationAsk', hint: 'settings.notificationAskHint' },
  done: { title: 'settings.notificationDone', hint: 'settings.notificationDoneHint' },
  failed: { title: 'settings.notificationFailed', hint: 'settings.notificationFailedHint' },
  goal: { title: 'settings.notificationGoal', hint: 'settings.notificationGoalHint' }
}

export function NotificationSettings(): React.JSX.Element | null {
  const { t } = useTranslation()
  // 读到之前不画：开关不能先显示「开」再跳成「关」
  const [off, setOff] = useState<ReadonlySet<AgentNotificationKind> | null>(null)

  useEffect(() => {
    let alive = true
    void Promise.all(
      AGENT_NOTIFICATION_KINDS.map((kind) => window.api.settings.get(notificationSettingKey(kind)))
    ).then((values) => {
      if (alive) setOff(new Set(AGENT_NOTIFICATION_KINDS.filter((_, i) => values[i] === 'false')))
    })
    return () => {
      alive = false
    }
  }, [])

  if (!off) return null

  const toggle = (kind: AgentNotificationKind): void => {
    const nextOn = off.has(kind)
    const next = new Set(off)
    if (nextOn) next.delete(kind)
    else next.add(kind)
    setOff(next)
    void window.api.settings.set({ key: notificationSettingKey(kind), value: String(nextOn) })
  }

  return (
    <div className="px-5 pb-5" data-notification-settings>
      <SettingsSection
        title={t('settings.notificationSection')}
        description={t('settings.notificationSectionHint')}
      >
        {AGENT_NOTIFICATION_KINDS.map((kind) => (
          <div key={kind} data-notification-kind={kind}>
            <SettingsRow
              title={t(ROW_TEXT[kind].title)}
              description={t(ROW_TEXT[kind].hint)}
              control={<Toggle on={!off.has(kind)} onClick={() => toggle(kind)} />}
            />
          </div>
        ))}
      </SettingsSection>
    </div>
  )
}
