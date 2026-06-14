/**
 * 共享 i18n t() 绑定 — 供插件工具使用
 *
 * 与 src/main/i18n.ts 使用同一个 i18next 单例（Node.js module cache 保证），
 * 无需重复初始化。插件工具用 getter 而非 readonly 字段调用，确保惰性求值
 * （main 进程完成 initI18n() 后才会被读取）。
 */
import i18next from 'i18next'

export const t = i18next.t.bind(i18next)
