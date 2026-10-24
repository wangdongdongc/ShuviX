/**
 * 派发给 hook agent 的任务文本 = 「正文 + 事件」。
 *
 * 没有模板语法：正文永远是一段话，事件永远以 YAML 附在一个固定围栏里。想让 agent 只看某个
 * 字段，就在正文里用字段名说（「excerpt 在 `recentText`」），而不是在 md 里发明占位符 ——
 * 这是把 workflow 时代的 `{{path}}` / `{{>name}}` 两套模板语法整个删掉换来的简单。
 *
 * 用 YAML 而不是 JSON：多行文本（对话尾部）以 `|` 块字面量呈现，模型与翻日志的人都读得顺；
 * 长行不折（lineWidth: 0），免得一段散文被 YAML 折成几行。
 */
import { stringify as stringifyYaml } from 'yaml'

/** 事件围栏的标签名（agent 面向，仅英文） */
export const HOOK_EVENT_TAG = 'hook_event'

/**
 * 渲染任务文本。`body` 为空时只有事件围栏（agent md 自己已说清要做什么的场景）。
 * payload 不含 `trigger` —— 它在围栏属性上；CEL 侧的 event 才带这个键。
 */
export function renderHookPrompt(
  body: string,
  trigger: string,
  payload: Record<string, unknown>
): string {
  return renderEventPrompt(HOOK_EVENT_TAG, body, trigger, payload)
}

/**
 * 「正文 + 事件围栏」的通用形状：hook 的任务文本用 `hook_event`，触发器替 bot 发的消息用 `trigger_event`
 * （宿主的 bot 触发分发）。同一套 YAML 规则。
 */
export function renderEventPrompt(
  tag: string,
  body: string,
  trigger: string,
  payload: Record<string, unknown>
): string {
  const yaml = stringifyYaml(payload, { lineWidth: 0 }).trimEnd()
  const fence = `<${tag} trigger="${trigger}">\n${yaml}\n</${tag}>`
  const text = body.trim()
  return text ? `${text}\n\n${fence}` : fence
}
