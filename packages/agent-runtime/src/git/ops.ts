/**
 * git 操作目录 —— 单一真源。
 *
 * 每个 op 声明：一行 description（进工具 description）、参数必选/可选、usage（参数错误时回显）。
 * tool.ts 的 schema / description、help.ts 的手册骨架都从这里生成，避免多处漂移。
 *
 * v1 仅本地操作（不含 clone/fetch/pull/push）；两端能力同集，暂无 caps。
 * 将来引入网络操作时再加 GitCaps + opsForCaps（OpSpec 已预留 cap? 键位）。
 */

export const GIT_ACTIONS = [
  'help',
  'status',
  'log',
  'show',
  'diff',
  'add',
  'unstage',
  'commit',
  'branch',
  'checkout',
  'restore',
  'init'
] as const
export type GitAction = (typeof GIT_ACTIONS)[number]

/** 扁平参数超集的键名（与 tool.ts 的参数 schema 一一对应） */
export type GitParamKey =
  | 'dir'
  | 'paths'
  | 'path'
  | 'message'
  | 'ref'
  | 'from'
  | 'to'
  | 'staged'
  | 'depth'
  | 'name'
  | 'delete'
  | 'force'
  | 'authorName'
  | 'authorEmail'
  | 'topic'

/** execute 收到的参数形状（扁平超集；每个 action 实际接受的键见 GIT_OPS） */
export interface GitOpParams {
  /** 仓库目录（绝对或相对工作目录；缺省 = 工作目录）。仅在宿主注入 resolveDir 时可用 */
  dir?: string
  paths?: string[]
  path?: string
  message?: string
  ref?: string
  from?: string
  to?: string
  staged?: boolean
  depth?: number
  name?: string
  delete?: boolean
  force?: boolean
  authorName?: string
  authorEmail?: string
  topic?: string
}

export interface GitOpSpec {
  name: GitAction
  /** 一行英文描述（token 预算 ~1 行/op） */
  description: string
  required: readonly GitParamKey[]
  optional: readonly GitParamKey[]
  /** 是否修改仓库/工作树（供宿主 resolveDir 按读/写语义做权限判定） */
  mutates: boolean
  /** 预留：将来引入 GitCaps（如 network）时启用；undefined = 恒可用 */
  cap?: string
  /** 参数错误时回显的 usage 行 */
  usage: string
}

export const GIT_OPS: readonly GitOpSpec[] = [
  {
    name: 'help',
    mutates: false,
    description: 'Show the full git manual (optionally a single topic). Call when unsure.',
    required: [],
    optional: ['topic'],
    usage: 'help(topic?: workflow|diff|branching|destructive|author)'
  },
  {
    name: 'status',
    mutates: false,
    description:
      'Working tree status: two-column codes "XY path" (X = HEAD→index, Y = index→worktree, ?? = untracked).',
    required: [],
    optional: ['paths'],
    usage: 'status(paths?: string[])'
  },
  {
    name: 'log',
    mutates: false,
    description: 'Commit history of a ref (default HEAD), newest first, one line per commit.',
    required: [],
    optional: ['ref', 'depth', 'path'],
    usage: 'log(ref?, depth?: number = 20, path?)'
  },
  {
    name: 'show',
    mutates: false,
    description: 'Show one commit: metadata, full message, and changed files (name-status).',
    required: ['ref'],
    optional: [],
    usage: 'show(ref)'
  },
  {
    name: 'diff',
    mutates: false,
    description:
      'Unified diff. Default: worktree vs index; staged:true = index vs HEAD; from(+to) = between commits (to omitted = worktree).',
    required: [],
    optional: ['staged', 'from', 'to', 'path'],
    usage: 'diff(staged?: boolean, from?, to?, path?)'
  },
  {
    name: 'add',
    mutates: true,
    description: 'Stage files, including deletions. paths:["."] stages all changes.',
    required: ['paths'],
    optional: [],
    usage: 'add(paths: string[])'
  },
  {
    name: 'unstage',
    mutates: true,
    description: 'Remove files from the index (inverse of add); the working tree is untouched.',
    required: ['paths'],
    optional: [],
    usage: 'unstage(paths: string[])'
  },
  {
    name: 'commit',
    mutates: true,
    description:
      'Commit staged changes. Author comes from repo config, or pass authorName+authorEmail (see help topic "author").',
    required: ['message'],
    optional: ['authorName', 'authorEmail'],
    usage: 'commit(message, authorName?, authorEmail?)'
  },
  {
    name: 'branch',
    mutates: true,
    description:
      'No name: list branches (current marked *). With name: create AND switch to it; delete:true deletes it instead.',
    required: [],
    optional: ['name', 'delete'],
    usage: 'branch(name?, delete?: boolean)'
  },
  {
    name: 'checkout',
    mutates: true,
    description:
      'Switch to a branch or commit. Refuses if local changes would be overwritten unless force:true (which DISCARDS them).',
    required: ['ref'],
    optional: ['force'],
    usage: 'checkout(ref, force?: boolean)'
  },
  {
    name: 'restore',
    mutates: true,
    description:
      'Restore files from a commit (default HEAD) — DISCARDS the local changes of those files.',
    required: ['paths'],
    optional: ['ref'],
    usage: 'restore(paths: string[], ref?)'
  },
  {
    name: 'init',
    mutates: true,
    description: 'Initialize a new repository (default branch "main") in the working directory.',
    required: [],
    optional: [],
    usage: 'init()'
  }
]
