/**
 * web_search 的搜索方式（设置 → LLM 工具 → web_search 子页，经 BuiltinToolsView 的 renderToolExtra 挂在工具卡片下面）。
 *
 * 三行单选：内置浏览器（缺省）、Tavily、Exa。用户裁定（2026-11-16）：选哪个就用哪个，API 失败就报失败，不自动换方式 ——
 * 所以没有密钥的那家也选得上，行下面说一句「搜索会失败」。
 *
 * 密钥只进不出：只在选中的那一行里填，存下之后界面拿到的只有「存没存」和末四位（主进程 webSearch:*）；要换就删掉重填。
 * 「测试」用存着的密钥真的搜一次，结果写在同一行下面，不弹框。
 */
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, ExternalLink, Trash2 } from 'lucide-react'
import {
  WEB_SEARCH_API_PROVIDER_IDS,
  WEB_SEARCH_API_PROVIDERS,
  WEB_SEARCH_PROVIDER_SETTING,
  type WebSearchApiProviderId,
  type WebSearchConfig,
  type WebSearchProviderId,
  type WebSearchTestResult
} from '../../../../shared/webSearchProviders'
import { SettingsSection } from './SettingsPrimitives'

const SMALL_BUTTON =
  'shrink-0 px-2.5 py-1 rounded-md text-[11px] text-text-secondary border border-border-secondary/60 hover:bg-bg-hover transition-colors disabled:opacity-50 disabled:cursor-default'

type TestState = { running: true } | { running: false; result: WebSearchTestResult }

export function WebSearchSettings(): React.JSX.Element | null {
  const { t } = useTranslation()
  const [config, setConfig] = useState<WebSearchConfig | null>(null)
  const [draft, setDraft] = useState('')
  const [saveError, setSaveError] = useState('')
  const [tests, setTests] = useState<Partial<Record<WebSearchApiProviderId, TestState>>>({})

  const reload = useCallback(() => {
    void window.api.webSearch
      .config()
      .then(setConfig)
      .catch(() => {
        /* 保持现状 */
      })
  }, [])
  useEffect(reload, [reload])

  if (!config) return null

  const choose = (provider: WebSearchProviderId): void => {
    const previous = config.provider
    if (provider === previous) return
    setConfig({ ...config, provider })
    setDraft('')
    setSaveError('')
    void window.api.settings
      .set({ key: WEB_SEARCH_PROVIDER_SETTING, value: provider })
      .catch((error: unknown) => {
        // 没写进去：界面退回原来那一项，别让人以为已经换了
        setConfig((current) => (current ? { ...current, provider: previous } : current))
        setSaveError(error instanceof Error ? error.message : String(error))
      })
  }

  const save = (provider: WebSearchApiProviderId): void => {
    const apiKey = draft.trim()
    if (!apiKey) return
    void window.api.webSearch
      .setKey({ provider, apiKey })
      .then((next) => {
        setConfig(next)
        setDraft('')
        setSaveError('')
        setTests((all) => ({ ...all, [provider]: undefined }))
      })
      .catch((error: unknown) =>
        setSaveError(error instanceof Error ? error.message : String(error))
      )
  }

  const remove = (provider: WebSearchApiProviderId): void => {
    void window.api.webSearch
      .deleteKey(provider)
      .then((next) => {
        setConfig(next)
        setSaveError('')
        setTests((all) => ({ ...all, [provider]: undefined }))
      })
      .catch((error: unknown) =>
        setSaveError(error instanceof Error ? error.message : String(error))
      )
  }

  const test = (provider: WebSearchApiProviderId): void => {
    setTests((all) => ({ ...all, [provider]: { running: true } }))
    void window.api.webSearch
      .test(provider)
      .catch(
        (error: unknown): WebSearchTestResult => ({
          ok: false,
          error: error instanceof Error ? error.message : String(error)
        })
      )
      .then((result) => setTests((all) => ({ ...all, [provider]: { running: false, result } })))
  }

  const radio = (on: boolean): React.JSX.Element => (
    <span
      aria-hidden="true"
      className={`flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full border ${
        on ? 'border-accent' : 'border-text-tertiary/60'
      }`}
    >
      {on && <span className="h-2 w-2 rounded-full bg-accent" />}
    </span>
  )

  const rowClass = 'flex min-h-10 w-full items-center gap-2.5 px-3 py-2 text-left text-xs'

  return (
    <div className="px-5 pb-5" data-web-search-settings>
      <SettingsSection title={t('settings.webSearchProvider')}>
        <div
          role="radiogroup"
          aria-label={t('settings.webSearchProvider')}
          className="overflow-hidden rounded-lg border border-border-secondary/60 divide-y divide-border-secondary/60"
        >
          <div className={rowClass} data-web-search-option="browser">
            <button
              type="button"
              role="radio"
              aria-checked={config.provider === 'browser'}
              onClick={() => choose('browser')}
              className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
            >
              {radio(config.provider === 'browser')}
              <span className="w-20 shrink-0 text-text-primary">
                {t('settings.webSearchBrowser')}
              </span>
              <span className="min-w-0 flex-1 truncate text-[11px] text-text-tertiary">
                {t('settings.webSearchBrowserHint', { engine: config.browserEngine })}
              </span>
            </button>
            {config.provider === 'browser' && (
              <button
                type="button"
                onClick={() => void window.api.browserView.openSettings()}
                className="flex shrink-0 items-center gap-1 text-[11px] text-accent hover:underline"
              >
                <ExternalLink size={11} />
                {t('settings.webSearchBrowserSettings')}
              </button>
            )}
          </div>

          {WEB_SEARCH_API_PROVIDER_IDS.map((id) => {
            const { name } = WEB_SEARCH_API_PROVIDERS[id]
            const key = config.keys[id]
            const selected = config.provider === id
            const state = tests[id]
            return (
              <div key={id} data-web-search-option={id} data-selected={selected ? '' : undefined}>
                <div className={rowClass}>
                  <button
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    onClick={() => choose(id)}
                    className={`flex items-center gap-2.5 text-left ${selected ? 'shrink-0' : 'min-w-0 flex-1'}`}
                  >
                    {radio(selected)}
                    <span className="w-20 shrink-0 text-text-primary">{name}</span>
                    {!selected && (
                      <span
                        className="min-w-0 flex-1 truncate text-[11px] text-text-tertiary"
                        data-web-search-key-state
                      >
                        {key.saved
                          ? t('settings.webSearchKeySaved', { last4: key.last4 })
                          : t('settings.webSearchNoKey')}
                      </span>
                    )}
                  </button>
                  {selected && key.saved && (
                    <>
                      <span
                        className="min-w-0 flex-1 truncate rounded-md border border-border-secondary/60 px-2 py-1 font-mono text-[11px] text-text-secondary"
                        data-web-search-key-state
                      >
                        {`••••••••${key.last4}`}
                      </span>
                      <button
                        type="button"
                        className={SMALL_BUTTON}
                        disabled={state?.running === true}
                        onClick={() => test(id)}
                        data-web-search-test
                      >
                        {state?.running
                          ? t('settings.webSearchTesting')
                          : t('settings.webSearchTest')}
                      </button>
                      <button
                        type="button"
                        className={SMALL_BUTTON}
                        onClick={() => remove(id)}
                        title={t('settings.webSearchDeleteKey')}
                        aria-label={t('settings.webSearchDeleteKey')}
                        data-web-search-delete-key
                      >
                        <Trash2 size={12} />
                      </button>
                    </>
                  )}
                  {selected && !key.saved && (
                    <>
                      <input
                        type="password"
                        autoComplete="off"
                        spellCheck={false}
                        value={draft}
                        onChange={(event) => setDraft(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') save(id)
                        }}
                        placeholder={t('settings.webSearchKeyPlaceholder', { name })}
                        aria-label={t('settings.webSearchKeyPlaceholder', { name })}
                        className="min-w-0 flex-1 rounded-md border border-border-secondary/60 bg-bg-primary px-2 py-1 font-mono text-[11px] text-text-primary outline-none focus:border-accent"
                        data-web-search-key-input
                      />
                      <button
                        type="button"
                        className={SMALL_BUTTON}
                        disabled={draft.trim() === ''}
                        onClick={() => save(id)}
                        data-web-search-save-key
                      >
                        {t('settings.webSearchSave')}
                      </button>
                    </>
                  )}
                </div>
                {selected && (!key.saved || saveError || (state && !state.running)) && (
                  <div className="-mt-1 pb-2 pl-[8.25rem] pr-3 text-[11px]" data-web-search-status>
                    {saveError ? (
                      <span className="text-error">{saveError}</span>
                    ) : !key.saved ? (
                      <span className="text-warning">{t('settings.webSearchMissingKey')}</span>
                    ) : state && !state.running && state.result.ok ? (
                      <span className="inline-flex items-center gap-1 text-success">
                        <Check size={11} />
                        {t('settings.webSearchTestOk', {
                          count: state.result.count,
                          seconds: (state.result.ms / 1000).toFixed(1)
                        })}
                      </span>
                    ) : state && !state.running && !state.result.ok ? (
                      <span className="text-error">{state.result.error}</span>
                    ) : null}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </SettingsSection>
    </div>
  )
}
