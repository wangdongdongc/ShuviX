/**
 * LLM 请求日志的跨端常量。
 *
 * pi-durable 迁移期间（phase 3 / 4）请求日志不记录：模型请求走 durable 的 Models，旧的 payload 钩子随 pi 0.80
 * 一起没了（主进程 `httpLogService` 的 TODO(pi-durable p5)）。设置页据此常显「已暂停」横幅，开关照常可切
 * —— 偏好保留到 phase 5 重新接上记录时生效。phase 5 删掉这个常量。
 */
export const HTTP_LOG_RECORDING_PAUSED = true
