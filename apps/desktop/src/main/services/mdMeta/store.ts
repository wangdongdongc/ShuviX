import { MD_FM_FILL_KEYS, type MdObjectKind } from '@shuvix/chat-protocol/mdMeta'
import { mdAttrDao } from '../../dao/mdAttrDao'
import type { MdAttr } from '../../dao/types'

/**
 * md 扩展元数据的内存快照（表 md_attrs，设计 docs/md-metadata-design.md）。
 *
 * 读一律走快照：注册表每次用到都现扫目录、现解析（agentService 每次派发、每次列表都会问一遍补缺值），
 * 每次都查库不划算；表很小（只有人在界面上写的那几行），整表载入内存即可。写只经本模块，写完让快照
 * 失效、下次读时重载 —— 主进程是这张表唯一的写入方，不存在别处改了库而快照不知道的情况。
 */
class MdMetaStore {
  private snapshot: Map<string, MdAttr[]> | null = null

  private rows(objectId: string): MdAttr[] {
    if (!this.snapshot) {
      const map = new Map<string, MdAttr[]>()
      for (const attr of mdAttrDao.findAll()) {
        const list = map.get(attr.objectId)
        if (list) list.push(attr)
        else map.set(attr.objectId, [attr])
      }
      this.snapshot = map
    }
    return this.snapshot.get(objectId) ?? []
  }

  /**
   * 这个对象在这类文件上的补缺值：全局 scope、`fm` 命名空间、这类文件白名单（MD_FM_FILL_KEYS）里的键。
   * 一个都没有 → undefined。复制出来的文件共用 id，所以按「哪类文件在问」过滤，而不是按存的时候是哪类。
   */
  fillFor(objectId: string, kind: MdObjectKind): Record<string, unknown> | undefined {
    const allowed = MD_FM_FILL_KEYS[kind]
    if (allowed.length === 0) return undefined
    const fill: Record<string, unknown> = {}
    for (const attr of this.rows(objectId)) {
      if (attr.scope === '' && attr.ns === 'fm' && allowed.includes(attr.key)) {
        fill[attr.key] = attr.value
      }
    }
    return Object.keys(fill).length > 0 ? fill : undefined
  }

  /** 写一个补缺键（全局 scope）。校验（id 在不在文件里、键在不在白名单、值合不合法）归调用方 */
  setFill(objectId: string, key: string, value: unknown): void {
    mdAttrDao.upsert({ objectId, ns: 'fm', key, value })
    this.snapshot = null
  }

  /** 删一个补缺键；返回是否真有一行被删 */
  unsetFill(objectId: string, key: string): boolean {
    const removed = mdAttrDao.delete({ objectId, ns: 'fm', key })
    this.snapshot = null
    return removed
  }
}

export const mdMetaStore = new MdMetaStore()
