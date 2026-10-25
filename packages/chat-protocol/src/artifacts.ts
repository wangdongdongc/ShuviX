/**
 * 会话产物（Artifacts）—— 会话自己的文件（`~/.shuvix/artifacts/<sessionId>/`），可以 `edit` 反复修改而
 * 不必重画。目录是一个由宿主提交的 git 仓库：每次工具调用改了它，就记下一版（主进程
 * `services/artifacts/history.ts`）。这里只放跨进程的形状。
 */

/** 会话面板「产物」页的一行（`artifact.list`） */
export interface SessionArtifact {
  /** 产出它的会话：所问的会话自己，或它的一个直接子会话（目录跟着产出它的会话走） */
  sessionId: string
  /** 来自子会话时那场子会话的标题（所问的会话自己的产物不带） */
  subSessionTitle?: string
  /** 文件名（含扩展名）—— ```artifact 引用与 `artifact.read` 都按它认 */
  name: string
  /** 人读标题：从内容里取，取不到是文件名主干 */
  title: string
  /** 绝对路径（在文件夹中显示 / 复制路径） */
  path: string
  /** 记下的版本数；还没开始记版本的旧产物算 1 */
  versions: number
  /** 最近一版的时刻（ms）；没有版本记录时取文件的修改时间 */
  updatedAt: number
}

/** ```artifact 引用要显示的那一份（`artifact.read`） */
export interface ArtifactRefContent {
  /** 产物所在的会话（所问的会话自己，或它的一个直接子会话）—— 面板里亮出它要用 */
  sessionId?: string
  /** 真实文件名（围栏里写的可能是标题） */
  name: string
  title: string
  content: string
  /**
   * 显示的是围栏所在那条回复写下时钉住的那一版。缺省 / false = 当前内容（没给消息 id、那条回复写于钉版本
   * 之前、还在流式中、或钉下的那一份取不回来）
   */
  pinned?: boolean
  /** 显示的内容就是文件此刻的内容；钉下的那一版之后又被改过 → false（界面提示「已有新版」） */
  latest?: boolean
}
