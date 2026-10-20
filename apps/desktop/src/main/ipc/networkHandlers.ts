import { defineHandler } from './registry'
import { networkService } from '../frontend/network'

/**
 * 网络访问的 IPC（server mode phase B）—— 设置页「网络访问」一节读写它。开关与端口照常存在设置表里
 * （`network.enabled` / `network.port`），这几条通道写设置之后等网络服务对完账，回改完之后的状态；
 * 别的路径改了这两个设置（`settings:set`）网络服务同样跟着走。谁能连由安全策略 network-admission 定，
 * 没有设置项（docs/network-policy/design.md）。
 *
 * 浏览器也能调它们（没有认证；能不能调由安全策略按通道判 —— 这两条写设置的是 `admin`）：从浏览器里关掉网络访问，
 * 等于把自己断开。
 * 无头运行（`shuvix --headless`）时关掉与换端口一律拒绝（`code: 'headless'`），状态带 `headless: true`。
 */
export function registerNetworkHandlers(): void {
  /** 开关、端口、是否在监听、能打开的地址、连着的客户端、准入策略的状态、最近的拒绝、监听失败的原因 */
  defineHandler('network:status', () => networkService.status())

  /** 开 / 关网络访问（无头运行：关 → 拒绝） */
  defineHandler('network:setEnabled', (_ctx, enabled: boolean) =>
    networkService.setEnabled(enabled)
  )

  /** 换端口（1024–65535 的整数；无头运行：换成别的端口 → 拒绝） */
  defineHandler('network:setPort', (_ctx, port: number) => networkService.setPort(port))
}
