/**
 * 「哪些父会话该自动展开」的判定 —— 从 ProjectSessionGroups 抽出来是为了能直接测：
 * 它要区分的两种情形只差一帧，靠 e2e 很难稳定地摆出来（见本文件的用例）。
 */

/** 判定所需的两帧快照 */
export interface AutoExpandInput {
  /** 这一帧的父 → 子会话 */
  childrenByParent: ReadonlyMap<string, ReadonlyArray<{ id: string }>>
  /** 上一帧见过的子会话 id */
  seenChildren: ReadonlySet<string>
  /** 上一帧见过的**全部**会话 id（含父行本身） */
  seenSessions: ReadonlySet<string>
}

/**
 * 返回该展开的父会话 id。
 *
 * 判据是「**父行上一帧就在**，而这一帧它下面冒出了新的子会话 id」。
 *
 * 只认「新 id」是不够的 —— 会话列表是异步拉来的，**新开的窗口第一次拿到数据时所有子会话
 * 都是「新」的**，于是整棵树全展开（这正是要防的那个现象：打开窗口就被一堆子会话糊满）。
 * 而在那一帧里父行同样是第一次出现，所以「父行上一帧就在」恰好把两种情形分开：
 *
 *   - 初次加载：父行也是新的 → 谁都不展开（缺省折叠）；
 *   - 之后 agent 在一条**已经在列表里**的会话下开出子会话 → 展开。
 *
 * 后者永远成立：子会话只能开在当前会话下，而当前会话必然已经在列表里。
 */
export function parentsToAutoExpand(input: AutoExpandInput): string[] {
  const out = new Set<string>()
  for (const [parentId, children] of input.childrenByParent) {
    if (!input.seenSessions.has(parentId)) continue
    if (children.some((c) => !input.seenChildren.has(c.id))) out.add(parentId)
  }
  return [...out]
}
