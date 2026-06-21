/**
 * McpServerDialog —— MCP Server 添加/编辑弹窗（共享）。
 * `allowStdio=false`（扩展）时隐藏类型切换，强制 http（浏览器无法跑本地子进程）。
 */
import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Plus, X } from 'lucide-react'
import { useDialogClose } from '@shuvix/chat-ui'
import {
  SettingsSection,
  SettingsRow,
  SettingsBlock,
  SegmentedControl,
  InlineInput
} from './SettingsPrimitives'

export interface McpServerDialogInitial {
  id: string
  name: string
  type: 'stdio' | 'http'
  command: string
  /** 启动参数：每行一个 */
  argsText: string
  /** key/value 数组（已解析） */
  envPairs: Array<{ key: string; value: string }>
  url: string
  /** Key: Value 多行文本 */
  headersText: string
  isBuiltin: boolean
  isEnabled: boolean
}

export interface McpServerDialogData {
  name: string
  type: 'stdio' | 'http'
  command: string
  argsLines: string[]
  envObject: Record<string, string>
  url: string
  headersObject: Record<string, string>
  /** 内置服务、之前未启用、本次填齐 env 时为 true（用于自动启用） */
  autoEnableBuiltin: boolean
}

interface McpServerDialogProps {
  initial: McpServerDialogInitial | null
  onSave: (data: McpServerDialogData) => Promise<void>
  onClose: () => void
  /** 是否允许 stdio（本地进程）类型；扩展传 false（仅 http） */
  allowStdio?: boolean
}

/** 多行文本 → 数组（去空白行） */
function linesToArray(text: string): string[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
}

/** UI 行数组 → Record（忽略空 key） */
function pairsToObject(pairs: Array<{ key: string; value: string }>): Record<string, string> {
  const result: Record<string, string> = {}
  for (const { key, value } of pairs) {
    const k = key.trim()
    if (k) result[k] = value
  }
  return result
}

/** "Key: Value" 多行文本 → Record */
function linesToHeaders(text: string): Record<string, string> {
  const obj: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const idx = trimmed.indexOf(':')
    if (idx > 0) {
      obj[trimmed.slice(0, idx).trim()] = trimmed.slice(idx + 1).trim()
    }
  }
  return obj
}

export function McpServerDialog({
  initial,
  onSave,
  onClose,
  allowStdio = true
}: McpServerDialogProps): React.JSX.Element {
  const { t } = useTranslation()
  const { closing, handleClose } = useDialogClose(onClose)

  const isEdit = !!initial
  const isBuiltin = initial?.isBuiltin === true

  const [name, setName] = useState(initial?.name ?? '')
  const [type, setType] = useState<'stdio' | 'http'>(
    initial?.type ?? (allowStdio ? 'stdio' : 'http')
  )
  const [command, setCommand] = useState(initial?.command ?? '')
  const [argsText, setArgsText] = useState(initial?.argsText ?? '')
  const [envPairs, setEnvPairs] = useState<Array<{ key: string; value: string }>>(
    initial?.envPairs ?? []
  )
  const [url, setUrl] = useState(initial?.url ?? '')
  const [headersText, setHeadersText] = useState(initial?.headersText ?? '')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') handleClose()
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [handleClose])

  const updateEnvPair = (idx: number, field: 'key' | 'value', v: string): void => {
    setEnvPairs((prev) => prev.map((p, i) => (i === idx ? { ...p, [field]: v } : p)))
  }
  const addEnvPair = (): void => {
    setEnvPairs((prev) => [...prev, { key: '', value: '' }])
  }
  const removeEnvPair = (idx: number): void => {
    setEnvPairs((prev) => prev.filter((_, i) => i !== idx))
  }

  const valid = isBuiltin || (name.trim() && (type === 'stdio' ? command.trim() : url.trim()))

  const handleSave = async (): Promise<void> => {
    if (!valid) return
    setSaving(true)
    try {
      const envObject = pairsToObject(envPairs)
      const allEnvFilled =
        Object.keys(envObject).length > 0 &&
        Object.values(envObject).every((v) => v.trim().length > 0)
      await onSave({
        name: name.trim(),
        type,
        command: command.trim(),
        argsLines: linesToArray(argsText),
        envObject,
        url: url.trim(),
        headersObject: linesToHeaders(headersText),
        autoEnableBuiltin: isBuiltin && !initial?.isEnabled && allEnvFilled
      })
      handleClose()
    } finally {
      setSaving(false)
    }
  }

  return (
    <div
      onClick={handleClose}
      className={`fixed inset-0 z-50 flex items-center justify-center bg-black/40 titlebar-no-drag dialog-overlay${closing ? ' dialog-closing' : ''}`}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="bg-bg-primary border border-border-primary rounded-xl shadow-xl w-[560px] max-w-[92vw] max-h-[88vh] flex flex-col dialog-panel"
      >
        {/* 头部 */}
        <div className="px-5 py-3 border-b border-border-secondary shrink-0 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-text-primary">
            {isEdit ? t('settings.mcpEditTitle') : t('settings.mcpAddTitle')}
          </h3>
          <button
            onClick={handleClose}
            className="p-1 rounded-lg hover:bg-bg-hover text-text-tertiary hover:text-text-primary transition-colors"
          >
            <X size={14} />
          </button>
        </div>

        {/* 内容 */}
        <div className="px-5 py-5 overflow-y-auto flex-1 space-y-5">
          {/* 内置服务提示 */}
          {isBuiltin && (
            <div className="flex items-start gap-2 px-3 py-2 rounded-lg border border-amber-500/30 bg-amber-500/5">
              <p className="text-[11px] text-text-secondary leading-relaxed">
                {t('settings.mcpBuiltinReadonlyNotice')}
              </p>
            </div>
          )}

          {/* 基本信息 */}
          <SettingsSection title={t('settings.mcpBasicGroup')}>
            <SettingsRow
              title={t('settings.mcpName')}
              control={
                <InlineInput
                  value={name}
                  onChange={setName}
                  placeholder={t('settings.mcpNamePlaceholder')}
                  disabled={isBuiltin}
                  monospace
                  autoFocus={!isEdit}
                />
              }
            />
            {/* 类型切换：仅在允许 stdio 时显示（扩展仅 http，隐藏） */}
            {!isBuiltin && allowStdio && (
              <SettingsRow
                title={t('settings.mcpType')}
                control={
                  <SegmentedControl<'stdio' | 'http'>
                    value={type}
                    onChange={setType}
                    options={[
                      { value: 'stdio', label: t('settings.mcpTypeStdio') },
                      { value: 'http', label: t('settings.mcpTypeHttp') }
                    ]}
                  />
                }
              />
            )}
          </SettingsSection>

          {/* stdio 配置（仅自定义 + 允许 stdio） */}
          {!isBuiltin && allowStdio && type === 'stdio' && (
            <SettingsSection title={t('settings.mcpStdioGroup')}>
              <SettingsRow
                title={t('settings.mcpCommand')}
                control={
                  <InlineInput
                    value={command}
                    onChange={setCommand}
                    placeholder={t('settings.mcpCommandPlaceholder')}
                    monospace
                  />
                }
              />
              <SettingsBlock label={t('settings.mcpArgs')}>
                <textarea
                  value={argsText}
                  onChange={(e) => setArgsText(e.target.value)}
                  rows={3}
                  className="zen-textarea font-mono text-[11px]"
                  placeholder={t('settings.mcpArgsPlaceholder')}
                />
              </SettingsBlock>
            </SettingsSection>
          )}

          {/* http 配置（仅自定义） */}
          {!isBuiltin && type === 'http' && (
            <SettingsSection title={t('settings.mcpHttpGroup')}>
              <SettingsRow
                title={t('settings.mcpUrl')}
                control={
                  <InlineInput
                    value={url}
                    onChange={setUrl}
                    placeholder={t('settings.mcpUrlPlaceholder')}
                    width={260}
                  />
                }
              />
              <SettingsBlock label={t('settings.mcpHeaders')}>
                <textarea
                  value={headersText}
                  onChange={(e) => setHeadersText(e.target.value)}
                  rows={2}
                  className="zen-textarea font-mono text-[11px]"
                  placeholder={t('settings.mcpHeadersPlaceholder')}
                />
              </SettingsBlock>
            </SettingsSection>
          )}

          {/* 内置：只读 URL */}
          {isBuiltin && (
            <SettingsSection title={t('settings.mcpHttpGroup')}>
              <SettingsRow
                title={t('settings.mcpUrl')}
                control={
                  <InlineInput value={url} onChange={setUrl} disabled width={260} monospace />
                }
              />
            </SettingsSection>
          )}

          {/* 环境变量 */}
          <SettingsSection
            title={t('settings.mcpEnvGroup')}
            headerAction={
              <button
                onClick={addEnvPair}
                className="flex items-center gap-1 px-2 py-1 rounded text-[11px] text-accent hover:bg-accent/10 transition-colors"
              >
                <Plus size={11} />
                {t('settings.mcpEnvAddVar')}
              </button>
            }
          >
            {envPairs.length === 0 ? (
              <div className="px-4 py-4 text-center text-[11px] text-text-tertiary">—</div>
            ) : (
              envPairs.map((pair, idx) => (
                <div key={idx} className="flex items-center gap-2 px-4 py-2">
                  <input
                    value={pair.key}
                    onChange={(e) => updateEnvPair(idx, 'key', e.target.value)}
                    disabled={isBuiltin}
                    placeholder={t('settings.mcpEnvKeyPlaceholder')}
                    className="flex-1 appearance-none bg-bg-primary rounded-md px-2.5 py-1 text-[11px] font-mono text-text-primary border border-border-secondary/50 transition-colors hover:border-border-secondary focus:outline-none focus:border-accent/60 placeholder:text-text-tertiary disabled:opacity-60 disabled:cursor-not-allowed"
                  />
                  <input
                    value={pair.value}
                    onChange={(e) => updateEnvPair(idx, 'value', e.target.value)}
                    placeholder={t('settings.mcpEnvValuePlaceholder')}
                    className="flex-1 appearance-none bg-bg-primary rounded-md px-2.5 py-1 text-[11px] font-mono text-text-primary border border-border-secondary/50 transition-colors hover:border-border-secondary focus:outline-none focus:border-accent/60 placeholder:text-text-tertiary"
                  />
                  {!isBuiltin && (
                    <button
                      onClick={() => removeEnvPair(idx)}
                      className="p-1 rounded text-text-tertiary hover:text-danger transition-colors"
                      title={t('common.delete')}
                    >
                      <X size={12} />
                    </button>
                  )}
                </div>
              ))
            )}
          </SettingsSection>
        </div>

        {/* 按钮 */}
        <div className="flex justify-end gap-2 px-5 py-3 border-t border-border-secondary shrink-0">
          <button
            onClick={handleClose}
            className="px-4 py-1.5 rounded-lg text-xs text-text-secondary hover:bg-bg-hover transition-colors"
          >
            {t('common.cancel')}
          </button>
          <button
            onClick={handleSave}
            disabled={!valid || saving}
            className="px-4 py-1.5 rounded-lg text-xs font-medium bg-accent text-white hover:bg-accent-hover disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {saving ? t('settings.mcpSaving') : isEdit ? t('common.save') : t('common.add')}
          </button>
        </div>
      </div>
    </div>
  )
}
