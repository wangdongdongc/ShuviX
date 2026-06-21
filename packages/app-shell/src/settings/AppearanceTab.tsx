/**
 * AppearanceTab —— 共享外观设置（语言 + 主题/字号/缩放/专注模式），prop 驱动 + 能力开关。
 *
 * 从桌面 GeneralSettings 的「语言 + 外观」两节抽出。值与持久化由宿主拥有：
 * 桌面绑定 settingsStore + window.api.settings.set；扩展绑定 chrome.storage。
 * 桌面专属项（notebookTheme / uiZoom）通过 caps 开关控制是否显示。
 */
import { useTranslation } from 'react-i18next'
import {
  SettingsSection,
  SettingsRow,
  InlineSelect,
  SegmentedControl,
  InlineSlider,
  Toggle
} from './SettingsPrimitives'

export type ThemeMode = 'dark' | 'light' | 'system'

/** 内置主题清单（id 与 themes.css / settingsStore 对齐） */
export const DARK_THEMES: { id: string; labelKey: string }[] = [
  { id: 'github-dark', labelKey: 'settings.themeGitHubDark' },
  { id: 'dracula', labelKey: 'settings.themeDracula' },
  { id: 'one-dark', labelKey: 'settings.themeOneDark' },
  { id: 'catppuccin-mocha', labelKey: 'settings.themeCatppuccinMocha' },
  { id: 'gruvbox-dark', labelKey: 'settings.themeGruvboxDark' },
  { id: 'nord', labelKey: 'settings.themeNord' },
  { id: 'tokyo-night', labelKey: 'settings.themeTokyoNight' }
]

export const LIGHT_THEMES: { id: string; labelKey: string }[] = [
  { id: 'github-light', labelKey: 'settings.themeGitHubLight' },
  { id: 'one-light', labelKey: 'settings.themeOneLight' },
  { id: 'catppuccin-latte', labelKey: 'settings.themeCatppuccinLatte' },
  { id: 'solarized-light', labelKey: 'settings.themeSolarizedLight' }
]

export interface AppearanceTabProps {
  theme: ThemeMode
  darkTheme: string
  lightTheme: string
  fontSize: number
  focusMode: boolean
  /** 桌面专属（caps.showNotebookTheme 控制显示） */
  notebookTheme?: string
  /** 桌面专属（caps.showUiZoom 控制显示） */
  uiZoom?: number
  /** 当前界面语言（'zh'|'en'|'ja'） */
  language?: string

  onThemeChange: (mode: ThemeMode) => void
  onDarkThemeChange: (id: string) => void
  onLightThemeChange: (id: string) => void
  onFontSizeChange: (size: number) => void
  onFocusModeToggle: () => void
  onNotebookThemeChange?: (id: string) => void
  onUiZoomChange?: (zoom: number) => void
  onLanguageChange?: (lng: string) => void

  caps?: {
    showLanguage?: boolean
    showNotebookTheme?: boolean
    showUiZoom?: boolean
  }
}

export function AppearanceTab(props: AppearanceTabProps): React.JSX.Element {
  const { t } = useTranslation()
  const caps = props.caps ?? {}

  return (
    <div className="flex-1 px-5 py-5 space-y-5">
      {caps.showLanguage && props.language && props.onLanguageChange && (
        <SettingsSection title={t('settings.languageGroup')}>
          <SettingsRow
            title={t('settings.language')}
            control={
              <SegmentedControl<string>
                value={props.language}
                onChange={props.onLanguageChange}
                options={[
                  { value: 'zh', label: '中文' },
                  { value: 'en', label: 'English' },
                  { value: 'ja', label: '日本語' }
                ]}
              />
            }
          />
        </SettingsSection>
      )}

      <SettingsSection title={t('settings.appearanceGroup')}>
        <SettingsRow
          title={t('settings.themeMode')}
          control={
            <SegmentedControl<ThemeMode>
              value={props.theme}
              onChange={props.onThemeChange}
              options={[
                { value: 'light', label: t('settings.themeLight') },
                { value: 'dark', label: t('settings.themeDark') },
                { value: 'system', label: t('settings.themeSystem') }
              ]}
            />
          }
        />
        <SettingsRow
          title={t('settings.darkThemeVariant')}
          control={
            <InlineSelect value={props.darkTheme} onChange={props.onDarkThemeChange}>
              {DARK_THEMES.map((th) => (
                <option key={th.id} value={th.id}>
                  {t(th.labelKey)}
                </option>
              ))}
            </InlineSelect>
          }
        />
        <SettingsRow
          title={t('settings.lightThemeVariant')}
          control={
            <InlineSelect value={props.lightTheme} onChange={props.onLightThemeChange}>
              {LIGHT_THEMES.map((th) => (
                <option key={th.id} value={th.id}>
                  {t(th.labelKey)}
                </option>
              ))}
            </InlineSelect>
          }
        />
        {caps.showNotebookTheme && props.notebookTheme && props.onNotebookThemeChange && (
          <SettingsRow
            title={t('settings.notebookTheme')}
            control={
              <InlineSelect value={props.notebookTheme} onChange={props.onNotebookThemeChange}>
                <option value="default">{t('settings.notebookThemeDefault')}</option>
                <option value="things">Things</option>
              </InlineSelect>
            }
          />
        )}
        <SettingsRow
          title={t('settings.fontSize')}
          control={
            <InlineSlider
              value={props.fontSize}
              min={12}
              max={20}
              step={1}
              onChange={props.onFontSizeChange}
              suffix="px"
            />
          }
        />
        {caps.showUiZoom && props.uiZoom != null && props.onUiZoomChange && (
          <SettingsRow
            title={t('settings.uiZoom')}
            control={
              <InlineSlider
                value={props.uiZoom}
                min={80}
                max={150}
                step={10}
                onChange={props.onUiZoomChange}
                suffix="%"
              />
            }
          />
        )}
        <SettingsRow
          title={t('settings.focusMode')}
          description={t('settings.focusModeDesc')}
          control={<Toggle on={props.focusMode} onClick={props.onFocusModeToggle} />}
        />
      </SettingsSection>
    </div>
  )
}
