/**
 * 一条会话在**本进程**里的记录（option A，用户 2026-10-07）—— 宿主（SessionHost）按会话 id 持有：同一进程里
 * LRU 关了再开拿到的还是同一份，换一个进程（重启 / 崩溃）就是空的，删除会话时丢掉。DurableSession 的每个
 * 实例拿到的都是这同一个对象，读写都是现读现写。
 *
 *  - `agentInitialized`：根 agent 在本进程里创建过、或打开时完整初始化过。锁的含义就是它 ——
 *    存着的锁不是本进程初始化的，打开时要么完整初始化（有可续的工作），要么清掉（空闲），见 `lock.ts`。
 *    销毁 / 清锁时撤掉。
 *  - `stoppedByUser`：有人显式喊停过（中止 / 销毁 / 回退），到下一次用户发送之前不自动续跑。放在这里而不是
 *    实例上：LRU 关了再开不能把它忘了（完成通知可能正好把会话重新打开）。不落盘 —— 换了进程，能叫醒父会话
 *    的只有本进程发起、还记着的驱动（桌面的子会话运行器），上个进程的喊停管不到它们。
 */
export interface SessionProcessRecord {
  agentInitialized: boolean
  stoppedByUser: boolean
}

export function newSessionProcessRecord(): SessionProcessRecord {
  return { agentInitialized: false, stoppedByUser: false }
}
