/** 后台完成通知的正文（与桌面 bgTaskService.formatExitNotice 同一个信封） */
export function bg(id: string, body: string): string {
  return `<background-task id="${id}" status="exited">${body}</background-task>`
}
