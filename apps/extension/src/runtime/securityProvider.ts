/**
 * 扩展 SecurityHostProvider / SecurityContext —— 接入共享安全模块的统一评估路径。
 *
 * 原则反转后（无策略 = 放行），扩展的"根句柄内读写一律放行不弹"由两点保证：
 *   - FSA/OPFS 端口是 rooted 的，工具触不到句柄外 —— 硬边界在文件系统 API 层；
 *   - 内置的路径类门（read/ask-on-write、protect-credentials/system）的 match 都带
 *     `env.host == 'desktop'` 守卫，不作用于扩展（项目文件夹在用户选取时已整夹授权；
 *     OPFS 不涉真实文件、无真实 home/系统目录）；ask-on-command 在扩展端天然不命中
 *     （无 bash/ssh）。
 * 因此无需任何 derived 规则 —— 未命中即默认放行。
 *
 * 询问代码路径照样接上（requestUserInput 注入），当前仅 git 危险操作（git-safety）
 * 会触发；将来若加"越界/第二目录"能力，直接复用已共享的扩展询问 UI（AskForm）。
 */
import i18next from 'i18next'
import {
  createSecurityContext,
  type SecurityContext,
  type SecurityHostProvider
} from '@shuvix/agent-runtime'
import type { InputRequest, InputResponse } from '@shuvix/chat-protocol/types/inputRequest'

export function createExtensionSecurityProvider(
  requestUserInput?: (req: InputRequest) => Promise<InputResponse>
): SecurityHostProvider {
  return {
    host: 'extension',
    pathSep: '/',
    // 扩展无 workspace/home/系统目录概念，但内置策略的 lets/match 引用这些变量 ——
    // 恒供给空值（inDir 对空串/空列表恒不命中），避免 strict 缺键报错刷 fail-safe 告警；
    // 语义由各内置门 match 里的 env.host == 'desktop' 守卫兜底
    getVars: () => ({
      workspace: '',
      toolResultsBase: '',
      skillsDirs: [],
      home: '',
      systemDirs: []
    }),
    getSessionGrants: () => ({ autoAllow: false, allowList: [] }),
    // 仅影响内置策略的人读面（description/body/规则 prompt）；规则的判定字段恒取 en
    getLanguage: () => i18next.language,
    requestUserInput
  }
}

/** 扩展 SecurityContext（会话根句柄内的文件工具共用一份） */
export function createExtensionSecurityContext(
  sessionId: string,
  requestUserInput?: (req: InputRequest) => Promise<InputResponse>
): SecurityContext {
  return createSecurityContext(
    { kind: 'agent', sessionId, agentKind: 'root' },
    { host: 'extension' },
    createExtensionSecurityProvider(requestUserInput)
  )
}
