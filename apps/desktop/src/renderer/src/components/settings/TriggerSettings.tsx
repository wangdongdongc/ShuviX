/**
 * 设置 → 触发源（实验）。触发源产生全局埋点事件；今天只有一个内置 timer：开箱即开、每分钟触发一次 `timer.fired`。
 *
 * **触发源与 bot 解绑**（用户 2026-10-24）：这一页不列「谁订阅了它」—— 命不命中由各 bot 在事件到来时用自己绑定里的
 * CEL `when` 决定，从条件反推订阅者靠不住。这里给两样东西：
 *  - 触发源自身：开关、上一次触发的时刻，以及**上一次的原始事件**（就是 `when` 里看到的 `event`，看懂条件怎么写）；
 *  - **触发日志**：某个事件真正命中某个 bot 的绑定时记的一条（开出的运行会话、跑完的结局、因上一次还没跑完而跳过、
 *    条件求值出错），点开看命中时的事件与条件，运行会话可以直接打开。
 *
 * 开关是设置项 `triggers.timer.enabled`（主进程每次触发现读）。触发源状态半分钟刷新一次（上次触发每分钟变）；日志随
 * `trigger.logged` 事件刷新。
 */
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown, ChevronRight, ExternalLink, Trash2 } from 'lucide-react'
import { useAppEvent } from '@shuvix/chat-ui'
import type {
  TriggerLogEntry,
  TriggerLogOutcome,
  TriggerSourceStatus
} from '@shuvix/chat-protocol/triggerSources'
import { SettingsRow, SettingsSection, Toggle } from './SettingsPrimitives'
import { ConfirmDialog } from '../common/ConfirmDialog'

const TIMER_ENABLED_KEY = 'triggers.timer.enabled'
const REFRESH_MS = 30_000

function formatTime(at: string | number): string {
  const d = new Date(at)
  return Number.isNaN(d.getTime())
    ? String(at)
    : d.toLocaleString(undefined, {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit'
      })
}

/** 结果的配色（文字色）：跑着的强调色、完成绿、失败与条件出错红、跳过灰 */
const OUTCOME_CLASS: Record<TriggerLogOutcome, string> = {
  started: 'text-accent',
  completed: 'text-green-600 dark:text-green-400',
  failed: 'text-red-600 dark:text-red-400',
  skipped: 'text-text-tertiary',
  'condition-error': 'text-red-600 dark:text-red-400'
}

const OUTCOME_KEY: Record<TriggerLogOutcome, string> = {
  started: 'settings.triggerLogStarted',
  completed: 'settings.triggerLogCompleted',
  failed: 'settings.triggerLogFailed',
  skipped: 'settings.triggerLogSkipped',
  'condition-error': 'settings.triggerLogConditionError'
}

function EventBlock({ event }: { event: Record<string, unknown> }): React.JSX.Element {
  return (
    <pre className="m-0 px-3 py-2 rounded bg-bg-secondary font-mono text-[11px] leading-snug text-text-secondary whitespace-pre-wrap break-all">
      {JSON.stringify(event, null, 2)}
    </pre>
  )
}

export function TriggerSettings(): React.JSX.Element {
  const { t } = useTranslation()
  const [sources, setSources] = useState<TriggerSourceStatus[] | null>(null)
  const [logs, setLogs] = useState<TriggerLogEntry[] | null>(null)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [confirmClear, setConfirmClear] = useState(false)

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

  const loadLogs = useCallback((): void => {
    window.api.trigger.logs().then(setLogs, () => setLogs([]))
  }, [])
  useEffect(() => loadLogs(), [loadLogs])
  useAppEvent('trigger.logged', loadLogs)

  const toggle = (source: TriggerSourceStatus): void => {
    const next = !source.enabled
    setSources((prev) =>
      prev ? prev.map((s) => (s.id === source.id ? { ...s, enabled: next } : s)) : prev
    )
    void window.api.settings.set({ key: TIMER_ENABLED_KEY, value: String(next) })
  }

  const clearLogs = async (): Promise<void> => {
    setConfirmClear(false)
    try {
      await window.api.trigger.clearLogs()
    } catch {
      // 清不掉就照旧列着 —— 下面重拉一次，界面与库里一致
    }
    loadLogs()
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
            {source.lastEvent && (
              <details className="px-3 pb-3 text-[12px]" data-trigger-last-event>
                <summary className="cursor-pointer select-none text-text-secondary">
                  {t('settings.triggersLastEvent')}
                </summary>
                <div className="mt-1.5 space-y-1.5">
                  <div className="text-[11px] text-text-tertiary">
                    {t('settings.triggersLastEventHint')}
                  </div>
                  <EventBlock event={source.lastEvent} />
                </div>
              </details>
            )}
          </div>
        ))}
      </SettingsSection>

      <SettingsSection
        title={t('settings.triggerLogSection')}
        description={t('settings.triggerLogSectionHint')}
        headerAction={
          logs && logs.length > 0 ? (
            <button
              type="button"
              onClick={() => setConfirmClear(true)}
              className="inline-flex items-center gap-1 text-[11px] text-text-tertiary hover:text-text-secondary"
              data-trigger-log-clear
            >
              <Trash2 size={11} />
              {t('common.clear')}
            </button>
          ) : null
        }
      >
        <div data-trigger-log>
          {logs !== null && logs.length === 0 && (
            <div className="px-4 py-4 text-[12px] text-text-tertiary" data-trigger-log-empty>
              {t('settings.triggerLogEmpty')}
            </div>
          )}
          {(logs ?? []).map((entry) => {
            const open = expanded === entry.id
            return (
              <div
                key={entry.id}
                className="border-b border-border-primary/40 last:border-b-0"
                data-trigger-log-row={entry.id}
                data-outcome={entry.outcome}
              >
                <div className="flex items-center gap-2 px-3 py-2 text-[12px]">
                  <button
                    type="button"
                    onClick={() => setExpanded(open ? null : entry.id)}
                    className="flex flex-1 min-w-0 items-center gap-2 text-left"
                  >
                    {open ? (
                      <ChevronDown size={12} className="shrink-0 text-text-tertiary" />
                    ) : (
                      <ChevronRight size={12} className="shrink-0 text-text-tertiary" />
                    )}
                    <span className="shrink-0 tabular-nums text-text-tertiary">
                      {formatTime(entry.createdAt)}
                    </span>
                    <span className="truncate text-text-primary">{entry.botDisplayName}</span>
                    <span className={`shrink-0 ${OUTCOME_CLASS[entry.outcome] ?? ''}`}>
                      {t(OUTCOME_KEY[entry.outcome] ?? 'settings.triggerLogFailed')}
                    </span>
                  </button>
                  {entry.sessionId && (
                    <button
                      type="button"
                      onClick={() =>
                        void window.api.app.openSessionWithDraft({
                          sessionId: entry.sessionId,
                          draft: ''
                        })
                      }
                      className="inline-flex shrink-0 items-center gap-1 text-[11px] text-text-tertiary hover:text-text-secondary"
                      data-trigger-log-open
                    >
                      <ExternalLink size={11} />
                      {t('settings.triggerLogOpenSession')}
                    </button>
                  )}
                </div>
                {open && (
                  <div className="px-3 pb-3 pl-8 space-y-1.5 text-[11px] text-text-secondary">
                    <div>
                      {t('settings.triggerLogBinding', {
                        file: entry.botFile,
                        index: entry.bindingIndex + 1,
                        trigger: entry.trigger
                      })}
                    </div>
                    <code className="block font-mono break-all text-text-tertiary">
                      {entry.when || t('settings.triggerLogNoCondition')}
                    </code>
                    {entry.error && (
                      <div className="text-red-600 dark:text-red-400 break-words">
                        {entry.error}
                      </div>
                    )}
                    <EventBlock event={entry.event} />
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </SettingsSection>

      {confirmClear && (
        <ConfirmDialog
          title={t('settings.triggerLogClearConfirm')}
          confirmText={t('common.clear')}
          cancelText={t('common.cancel')}
          onConfirm={() => void clearLogs()}
          onCancel={() => setConfirmClear(false)}
        />
      )}
    </div>
  )
}
