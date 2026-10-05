/**
 * 场景 4 的模型层（PIN-3：P1-09 的 `ModelCatalog` seam 收 `registry: Pick<ModelRegistry,'models'|'modelRefOf'>` + port）：
 * 真 `createModelRegistry({ port, network })` + 真 `withNetwork` 装饰器，faux 挂在一条**自定义 provider 行的
 * id** 下（`registry.mutable.setProvider(fauxProvider({ provider: U }).provider)`；行没变，`refresh()` 的指纹
 * 一样，faux 就留着）。网络 seam 是真 AsyncLocalStorage（与桌面 llmNetwork 同一个形状），faux 的步骤里
 * 可以 `recordFailure(...)`，装饰器把它贴到错误文本上（verified fact #5）。
 *
 * 另有一条**没有 key** 的自定义行 C「My Proxy」（模型 alpha）：真 pi-ai provider（M4 用例）。它的 uuid 里
 * 有 `503` —— 错误文本里若留着 uuid，重试分类会把配置错误当成「服务不可用」重试十次。
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import { fauxProvider, type FauxProviderHandle } from '@earendil-works/pi-ai'
import { createModelRegistry, type ModelRegistry } from '../../../../models/modelRegistry'
import type { RuntimeNetwork } from '../../../../types'
import { customRow, fakePort, modelRow, type FakePort } from '../../../../models/__tests__/fakePort'
import type { ProcessModels } from './world'

/** faux 所在的自定义 provider 行（uuid 里有 503：它不该让任何东西变得「可重试」） */
export const U = '0193a503-0000-7000-8000-000000000503'
/** 没有 key 的真自定义 provider 行（M4） */
export const C = '0193a503-0000-7000-8000-00000000c503'

export interface AlsSeam {
  readonly network: RuntimeNetwork
  /** 在当前请求作用域里记一条 fetch 层失败（作用域外调用 = 测试写错了） */
  recordFailure(detail: string): void
}

export function alsSeam(): AlsSeam {
  const als = new AsyncLocalStorage<{ failure?: string }>()
  return {
    network: {
      runInRequestScope: (fn) => als.run({}, fn),
      describeLastFailure: () => als.getStore()?.failure
    },
    recordFailure: (detail) => {
      const scope = als.getStore()
      if (!scope) throw new Error('recordFailure outside a request scope — the test is wrong')
      scope.failure = detail
    }
  }
}

export function registryPort(): FakePort {
  return fakePort(
    [customRow(U, { name: 'Faux Proxy', apiKey: 'sk-faux' }), customRow(C, { name: 'My Proxy' })],
    [modelRow(U, 'faux-1', { maxInputTokens: 40000 }), modelRow(C, 'alpha')]
  )
}

/** 当前进程的模型层（世界级的 port；每个进程一个注册表、一个 faux、一个 seam） */
export interface RegistryProcess extends ProcessModels {
  readonly registry: ModelRegistry
  readonly seam: AlsSeam
  readonly faux: FauxProviderHandle
}

/** 交给 `makeWorld({ makeModels })` 的工厂；`current` 总是最近一个进程的那一份 */
export function registryModels(port: FakePort = registryPort()): {
  readonly port: FakePort
  readonly current: () => RegistryProcess
  readonly make: () => RegistryProcess
} {
  let current: RegistryProcess | undefined
  const make = (): RegistryProcess => {
    const seam = alsSeam()
    const registry = createModelRegistry({ port, network: seam.network })
    const faux = fauxProvider({
      provider: U,
      models: [{ id: 'faux-1', reasoning: true, contextWindow: 40000 }]
    })
    registry.mutable.setProvider(faux.provider)
    current = {
      registry,
      seam,
      faux,
      models: registry.models,
      modelCatalog: { registry, port }
    }
    return current
  }
  return {
    port,
    make,
    current: () => {
      if (current === undefined) throw new Error('no registry process yet')
      return current
    }
  }
}
