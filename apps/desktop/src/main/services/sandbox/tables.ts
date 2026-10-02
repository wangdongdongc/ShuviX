/**
 * 沙箱的固定清单 —— 刻意只剩两项。
 *
 * 2026-10-01 起沙箱不再尽量把功能圈在里面（包缓存可写、`/tmp` 可写、家目录工具配置可读……），
 * 也不再维护围栏清单（git 元数据、shell 启动文件、LaunchAgents、~/.shuvix 拒写……）：命令只能读写
 * 本会话的目录，需要更多的直接到沙箱外执行、交给自动审查。可写范围收到会话目录以后，那些围栏
 * 本来就碰不到了。
 */

/**
 * `~/.shuvix` 里可以当作工作目录的内容目录（用户产出的东西）。工作目录落在 `~/.shuvix` 的
 * 其他地方（agents / policies / hooks / bots / skills 的 notebook 会话）⇒ 它不算会话目录、该会话
 * 不套沙箱：那些文件会被主进程读作配置，命令改它们等于改 agent 自己的规矩。
 */
export const SHUVIX_CONTENT_DIRS: readonly string[] = [
  'knowledge',
  'knowledge-shuvix',
  'widgets',
  'artifacts'
]

/** macOS 的 DNS 走这个 unix socket（不放行它，出网就解析不了域名） */
export const MDNS_RESPONDER_SOCKET = '/private/var/run/mDNSResponder'
