/**
 * 设置 → 触发源（实验）。触发源产生全局埋点事件，bot 在自己的 md 里用 `shuvix-bot-on` 订阅。今天只有一个内置
 * timer：开箱即开、每分钟触发一次 `timer.fired`，订阅它的 bot 在 CEL `when` 里比较时间。这里能做的只有开关它，
 * 外加看一眼它上一次什么时候触发、哪些 bot 订阅了它。
 *
 * 开关是设置项 `triggers.timer.enabled`（主进程每次触发现读）；状态半分钟刷新一次 —— 订阅者随 bot 文件变，
 * 上次触发每分钟变。
 */
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { TriggerSourceStatus } from '@shuvix/chat-protocol/triggerSources'
import { SettingsRow, SettingsSection, Toggle } from './SettingsPrimitives'

const TIMER_ENABLED_KEY = 'triggers.timer.enabled'
const REFRESH_MS = 30_000

function formatTime(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleString(undefined, {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit'
      })
}

export function TriggerSettings(): React.JSX.Element {
  const { t } = useTranslation()
  const [sources, setSources] = useState<TriggerSourceStatus[] | null>(null)

  useEffect(() => {
    let alive = true
    const load = (): void => {
      window.api.trigger.status().then(
        (next) => {
          if (alive) setSources(next)
        },
        () => {
          if (alive) setSources([])
        }
      )
    }
    load()
    const timer = setInterval(load, REFRESH_MS)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [])

  const toggle = (source: TriggerSourceStatus): void => {
    const next = !source.enabled
    setSources((prev) =>
      prev ? prev.map((s) => (s.id === source.id ? { ...s, enabled: next } : s)) : prev
    )
    void window.api.settings.set({ key: TIMER_ENABLED_KEY, value: String(next) })
  }

  return (
    <div className="flex-1 px-5 py-5 space-y-5" data-trigger-settings>
      <SettingsSection
        title={t('settings.triggersSection')}
        description={t('settings.triggersSectionHint')}
      >
        {(sources ?? []).map((source) => (
          <div key={source.id} data-trigger-source={source.id}>
            <SettingsRow
              title={t('settings.triggersTimerEnabled')}
              description={t('settings.triggersTimerHint')}
              subtitle={
                source.lastFiredAt
                  ? t('settings.triggersLastFired', { time: formatTime(source.lastFiredAt) })
                  : t('settings.triggersNotFiredYet')
              }
              control={<Toggle on={source.enabled} onClick={() => toggle(source)} />}
            />
            <div className="px-3 pb-3 text-[12px] text-text-secondary" data-trigger-subscribers>
              <div className="mb-1 font-medium">{t('settings.triggersSubscribers')}</div>
              {source.subscribers.length === 0 ? (
                <div className="text-text-tertiary">{t('settings.triggersNoSubscribers')}</div>
              ) : (
                <ul className="space-y-1">
                  {source.subscribers.map((sub, i) => (
                    <li key={`${sub.bot}#${i}`} className="flex flex-wrap items-baseline gap-2">
                      <span className="text-text-primary">{sub.displayName}</span>
                      <code className="font-mono text-[11px] text-text-tertiary break-all">
                        {sub.when ?? t('settings.triggersEveryTime')}
                      </code>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        ))}
      </SettingsSection>
    </div>
  )
}
