/**
 * Chrome 扩展 —— 挂在 MCP 设置里内置 `chrome` 那一行的展开区。
 *
 * `chrome` 不是会话能勾选的能力：它只由 Chrome 标签页会话（ShuviX 扩展的侧边栏）的基座档案声明。
 * 所以这一行的展开区讲的是那条路本身：哪些浏览器连着、扩展怎么装、本地组件（原生消息宿主）
 * 装好了没有 —— 以及一个「修复本地组件」按钮（app 挪了位置、换了浏览器之后用）。
 */
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { CircleCheck, Globe, Loader2, TriangleAlert, Wrench } from 'lucide-react'
import { useAppEvent } from '@shuvix/chat-ui'
import type { ChromeExtensionStatus } from '@shuvix/chat-protocol/chromeBridge'
import { SettingsSection, SettingsRow } from './SettingsPrimitives'

const RELEASES_URL = 'https://github.com/wangdongdongc/ShuviX/releases'

export function ChromeExtensionSettings(): React.JSX.Element {
  const { t } = useTranslation()
  const [status, setStatus] = useState<ChromeExtensionStatus | null>(null)
  const [repairing, setRepairing] = useState(false)

  const load = useCallback(() => {
    void window.api.chromeExtension.status().then(setStatus)
  }, [])

  useEffect(load, [load])
  useAppEvent('chromeExtension.changed', load)

  const repair = async (): Promise<void> => {
    setRepairing(true)
    try {
      setStatus(await window.api.chromeExtension.repair())
    } finally {
      setRepairing(false)
    }
  }

  const install = status?.install
  const browsers = status?.browsers ?? []

  return (
    <div className="flex-1 px-5 py-5 space-y-5" data-chrome-extension-settings>
      <SettingsSection
        title={t('settings.chromeExtConnectedTitle')}
        description={t('settings.chromeExtConnectedDesc')}
      >
        {!status ? (
          <div className="flex items-center gap-2 px-4 py-4 text-text-tertiary">
            <Loader2 size={12} className="animate-spin" />
            <span className="text-[11px]">{t('common.loading')}</span>
          </div>
        ) : browsers.length === 0 ? (
          <div className="px-4 py-5 text-center">
            <p className="text-[11px] text-text-tertiary">{t('settings.chromeExtNoBrowser')}</p>
          </div>
        ) : (
          browsers.map((b) => (
            <SettingsRow
              key={b.installId}
              icon={<Globe size={11} className="text-text-tertiary shrink-0" />}
              title={b.browser}
              subtitle={t('settings.chromeExtVersion', { version: b.extensionVersion })}
              control={
                b.state === 'ready' ? (
                  <span className="inline-flex items-center gap-1 text-[11px] text-success">
                    <CircleCheck size={11} />
                    {t('settings.chromeExtConnected')}
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 text-[11px] text-warning">
                    <TriangleAlert size={11} />
                    {t('settings.chromeExtMismatch')}
                  </span>
                )
              }
            />
          ))
        )}
      </SettingsSection>

      <SettingsSection
        title={t('settings.chromeExtSetupTitle')}
        description={t('settings.chromeExtSetupDesc')}
      >
        <ol className="list-decimal space-y-1.5 px-4 py-3 pl-8 text-[11px] leading-relaxed text-text-secondary">
          <li>
            {t('settings.chromeExtStepDownload')}{' '}
            <button
              type="button"
              onClick={() => void window.api.app.openExternal(RELEASES_URL)}
              className="text-accent hover:underline"
            >
              {t('settings.chromeExtReleases')}
            </button>
          </li>
          <li>{t('settings.chromeExtStepLoad')}</li>
          <li>{t('settings.chromeExtStepOpen')}</li>
        </ol>
      </SettingsSection>

      <SettingsSection
        title={t('settings.chromeExtHostTitle')}
        description={t('settings.chromeExtHostDesc')}
        headerAction={
          <button
            type="button"
            onClick={() => void repair()}
            disabled={repairing}
            className="inline-flex items-center gap-1 text-[11px] text-text-tertiary hover:text-text-secondary disabled:opacity-50"
          >
            {repairing ? <Loader2 size={11} className="animate-spin" /> : <Wrench size={11} />}
            {t('settings.chromeExtRepair')}
          </button>
        }
      >
        {!install ? (
          <div className="px-4 py-4 text-[11px] text-text-tertiary">
            {t('settings.chromeExtHostPending')}
          </div>
        ) : (
          <>
            <SettingsRow
              title={t('settings.chromeExtHostInstalled')}
              subtitle={
                install.installed.length > 0
                  ? install.installed.join(', ')
                  : t('settings.chromeExtHostNoBrowser')
              }
            />
            {install.failed.map((f) => (
              <div key={f.browser} className="flex items-start gap-2 px-4 py-3 bg-amber-500/5">
                <TriangleAlert size={12} className="text-amber-500 shrink-0 mt-0.5" />
                <p className="text-[11px] text-text-secondary leading-relaxed">
                  {f.browser === '*' ? f.error : `${f.browser}: ${f.error}`}
                </p>
              </div>
            ))}
          </>
        )}
      </SettingsSection>
    </div>
  )
}
