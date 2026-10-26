/**
 * `shuvix policy check` 的桌面接线（policyCheck.ts 是纯逻辑）：策略服务、网络状态、网卡表、试算形态的网络安全上下文。
 * 主入口经 `cliServer.setPolicyCheckDeps` 注入 —— cliServer 直接 import 网络服务会成环。
 */
import { homedir, networkInterfaces } from 'os'
import i18next from 'i18next'
import { buildBuiltinPolicies } from '@shuvix/agent-runtime'
import { networkService } from '../frontend/network'
import { getDefaultPoliciesDir } from '../utils/paths'
import type { PolicyCheckDeps } from './policyCheck'
import { policyService } from './policyService'
import {
  getDesktopAgentTrialSecurityContext,
  getDesktopNetworkSecurityContext
} from './toolContext'
import { providerCredentialPort } from './models/providerCredentialPort'
import { policyProviderName } from './redactionPolicy'

export function desktopPolicyCheckDeps(): PolicyCheckDeps {
  return {
    policiesDir: getDefaultPoliciesDir(),
    home: homedir(),
    userPolicies: () => {
      // 拷进来还没被定时器认下的文件也要算上：现扫一次（与设置页列表同一份缓存）
      policyService.refresh()
      return policyService.getUserPolicies()
    },
    builtinPolicies: () =>
      buildBuiltinPolicies({
        language: i18next.language,
        readMd: (fileName) => policyService.readBuiltinPolicyMd(fileName)
      }),
    isDisabled: (policy) => policyService.isDisabled(policy),
    contextFor: (userPolicies, logger) => (subject) =>
      getDesktopNetworkSecurityContext(subject, { userPolicies, logger }),
    status: () => networkService.status(),
    interfaces: () => networkInterfaces(),
    redaction: {
      // 已启用服务商的已启用模型，服务商按策略里的名字（内置 = slug，自定义 = 用户起的名字）
      models: () => {
        const rows = providerCredentialPort.listProviders().filter((row) => row.isEnabled)
        const models = providerCredentialPort.listModels().filter((m) => m.isEnabled)
        return rows.flatMap((row) =>
          models
            .filter((m) => m.providerId === row.id)
            .map((m) => ({ provider: policyProviderName(row), model: m.modelId }))
        )
      },
      agentContextFor: (userPolicies, logger, subject) =>
        getDesktopAgentTrialSecurityContext(subject, { userPolicies, logger })
    }
  }
}
