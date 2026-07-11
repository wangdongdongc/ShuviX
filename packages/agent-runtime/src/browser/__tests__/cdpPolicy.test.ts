import { describe, it, expect } from 'vitest'
import { classifyCdpMethod, resolveUidMacros } from '../cdpPolicy'

describe('classifyCdpMethod', () => {
  it('只读方法 → safe', () => {
    for (const m of [
      'Network.getResponseBody',
      'DOM.describeNode',
      'DOM.getDocument',
      'CSS.getMatchedStylesForNode',
      'Accessibility.getFullAXTree',
      'Runtime.enable',
      'Page.getLayoutMetrics',
      'Network.disable'
    ]) {
      expect(classifyCdpMethod(m).cls, m).toBe('safe')
    }
  })

  it('写类/未知方法 → mutating（fail-safe）', () => {
    for (const m of [
      'Input.dispatchMouseEvent',
      'Runtime.evaluate',
      'Emulation.setDeviceMetricsOverride',
      'DOM.setAttributeValue',
      'Network.setCookie',
      'Debugger.pause',
      'Page.handleJavaScriptDialog',
      'Runtime.someBrandNewMethod' // 未知方法默认 mutating
    ]) {
      expect(classifyCdpMethod(m).cls, m).toBe('mutating')
    }
  })

  it('Fetch.enable 覆盖为 mutating（拦截会挂起页面）', () => {
    expect(classifyCdpMethod('Fetch.enable').cls).toBe('mutating')
  })

  it('越界域/危险方法 → blocked，带原因', () => {
    for (const m of [
      'Browser.close',
      'Target.createTarget',
      'Tracing.start',
      'Page.close',
      'Security.setIgnoreCertificateErrors',
      'SystemInfo.getInfo',
      'Nonexistent.method' // 未知域
    ]) {
      const r = classifyCdpMethod(m)
      expect(r.cls, m).toBe('blocked')
      expect(r.reason, m).toBeTruthy()
    }
  })

  it('畸形 method → blocked', () => {
    expect(classifyCdpMethod('nodot').cls).toBe('blocked')
    expect(classifyCdpMethod('Trailing.').cls).toBe('blocked')
  })
})

describe('resolveUidMacros', () => {
  const controller = {
    getNode: (uid: string) => (uid === 'e7' ? { backendDOMNodeId: 42 } : undefined),
    resolveCoordinates: async (uid: string) => (uid === 'e7' ? { x: 10, y: 20 } : { x: 0, y: 0 })
  }

  it('$uid → backendNodeId', async () => {
    const out = await resolveUidMacros({ backendNodeId: { $uid: 'e7' } }, controller)
    expect(out).toEqual({ backendNodeId: 42 })
  })

  it('$uidX/$uidY → 坐标，且同 uid 只解析一次坐标', async () => {
    let calls = 0
    const spyController = {
      getNode: controller.getNode,
      resolveCoordinates: async () => {
        calls++
        return { x: 10, y: 20 }
      }
    }
    const out = await resolveUidMacros(
      { type: 'mouseMoved', x: { $uidX: 'e7' }, y: { $uidY: 'e7' } },
      spyController
    )
    expect(out).toEqual({ type: 'mouseMoved', x: 10, y: 20 })
    expect(calls).toBe(1) // 坐标缓存
  })

  it('未知 uid → 抛错', async () => {
    await expect(resolveUidMacros({ n: { $uid: 'zzz' } }, controller)).rejects.toThrow(
      /Unknown uid/
    )
  })

  it('嵌套结构递归解析，非宏值原样保留', async () => {
    const out = await resolveUidMacros(
      { a: [1, { $uid: 'e7' }], b: 'str', c: { d: { $uidX: 'e7' } } },
      controller
    )
    expect(out).toEqual({ a: [1, 42], b: 'str', c: { d: 10 } })
  })
})
