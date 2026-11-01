/**
 * 远端任务的脚本与回执 —— 纯函数，不碰进程与网络（编排在 sshRemoteTasks）。
 *
 * 每个远端操作都是一段 POSIX sh，经 stdin 交给 `ssh host sh -s`（见 sshControl.sshScript）：开头几行
 * 变量，接 REMOTE_LIB，再接本操作自己的几行。远端不预装任何东西。设计见 docs/ssh-background-task-design.md。
 *
 * 远端布局（§3）：`~/.shuvix-ssh/<installId>/<taskDir>/`，一个发起端 ShuviX 安装一个目录、一条命令一个目录。
 * 不放 `~/.shuvix`（远端自己装了 ShuviX 时那是它的用户配置区），也不放 `/tmp`（多用户共享、可能是内存盘、
 * systemd-tmpfiles 会清掉跑得久的任务目录）。
 *
 * 几条在真机上踩出来的规矩：
 *  - **整段脚本包进一个函数再调用**：连接在脚本送到一半时断掉，sh 读到的是半截 —— 包在函数里，半截就是
 *    一个语法错误，什么都不执行；不包的话前面那几行已经跑了（比如命令文件只写了一半）。
 *  - **杀进程组写 `kill -s TERM -- -PGID`**：Ubuntu 的 `/bin/sh` 是 dash，它不认 `kill -TERM -- -PGID`
 *    （`Illegal number: -`），原型第一版因此什么都停不掉。
 *  - **命令放在随机结束符的 quoted heredoc 里**：一个字节都不转义，也不经远端登录 shell。
 *  - **退出码经 `exit.tmp` + `mv` 原子出现**：读到 exit 文件就一定是完整的。
 */

/** 远端根目录名（在远端用户的 $HOME 下） */
export const REMOTE_ROOT_DIRNAME = '.shuvix-ssh'

/** task.json / origin.json 的格式名 —— 远端的人 cat 它时看得出这是什么 */
export const TASK_SCHEMA = 'shuvix.ssh-task/1'
export const ORIGIN_SCHEMA = 'shuvix.ssh-origin/1'

/** 探测脚本输出的第一行 —— 没有它就是这台远端跑不了 `sh -s`（Windows、受限 shell…） */
const PROBE_MARKER = 'SHUVIX-PROBE 1'

/**
 * 远端库：轮询、停止、runner 存活判断。POSIX sh（dash / bash / busybox ash 都要能跑）。
 *
 * poll_task 的输出协议：一行 `SHUVIX-STATE <状态> SIZE <字节数>`，之后是 out.log 从 from 起的原始字节（至多 cap）。
 * 状态：RUNNING | EXIT <code>[ stopped][ orphaned] | LOST | GONE。这一行之前可能还有别的输出 —— 远端用户的
 * `.bashrc` 之类往 stdout 打字的，ssh 原样带回来 —— 所以解析时按哨兵找这一行，不认第一行。
 *
 * **轮询从不删目录**：删目录由本机在收全字节之后另发一次 reap（buildReapScript）。回执可能在路上丢了 ——
 * 同一次请求里交回结果又删掉目录的话，重发时要么什么都拿不到（GONE），要么（启动时）目录不在、命令又被起一遍。
 */
const REMOTE_LIB = String.raw`ROOT="$HOME/${REMOTE_ROOT_DIRNAME}"
now() { date +%s; }
mtime() { stat -c %Y "$1" 2>/dev/null || stat -f %m "$1" 2>/dev/null || echo 0; }
# runner 还活着、而且真是这条任务的（防 pid 复用）。先看 /proc（Linux 连 ps 都可能没装），
# 再看 ps；两样都用不了（busybox 的 ps 不认 -p）就只能信 kill -0
runner_alive() {
  rp=$(cat "$1/runner" 2>/dev/null) || return 1
  [ -n "$rp" ] && kill -0 "$rp" 2>/dev/null || return 1
  if [ -r "/proc/$rp/cmdline" ]; then
    tr '\000' ' ' < "/proc/$rp/cmdline" | grep -qF "$1/run"
    return $?
  fi
  rargs=$(ps -o args= -p "$rp" 2>/dev/null) || return 0
  [ -n "$rargs" ] || return 0
  printf '%s\n' "$rargs" | grep -qF "$1/run"
}
# runner 没了又没留下退出码：记成 lost，之后谁来问都是同一个答案
mark_lost() {
  [ -f "$1/exit" ] || printf 'lost %s\n' "$(now)" > "$1/exit"
}
poll_task() {
  pd=$1; pw=$2; pfrom=$3; pcap=$4
  if [ ! -d "$pd" ]; then echo "SHUVIX-STATE GONE SIZE 0"; return 0; fi
  touch "$pd/seen"
  pi=0; plim=$((pw * 10))
  while [ ! -f "$pd/exit" ]; do
    if ! runner_alive "$pd"; then
      [ -f "$pd/exit" ] || mark_lost "$pd"
      break
    fi
    [ "$pi" -ge "$plim" ] && break
    sleep 0.1; pi=$((pi + 1))
    [ $((pi % 50)) -eq 0 ] && touch "$pd/seen"
  done
  pstate=RUNNING
  if [ -f "$pd/exit" ]; then
    pcode=$(cut -d' ' -f1 "$pd/exit")
    if [ "$pcode" = lost ]; then pstate=LOST; else
      pstate="EXIT $pcode"
      [ -f "$pd/stopping" ] && pstate="$pstate stopped"
      [ -f "$pd/orphaned" ] && pstate="$pstate orphaned"
    fi
  fi
  psize=$(wc -c < "$pd/out.log" 2>/dev/null | tr -d ' ')
  [ -n "$psize" ] || psize=0
  echo "SHUVIX-STATE $pstate SIZE $psize"
  tail -c +$((pfrom + 1)) "$pd/out.log" 2>/dev/null | head -c "$pcap"
  return 0
}
# 停整个进程组：TERM，3 秒内没结束再 KILL
stop_task() {
  sd=$1
  [ -d "$sd" ] || return 0
  [ -f "$sd/exit" ] && return 0
  touch "$sd/stopping"
  sg=$(cat "$sd/pgid" 2>/dev/null)
  if [ -n "$sg" ]; then
    kill -s TERM -- "-$sg" 2>/dev/null
    si=0
    while [ ! -f "$sd/exit" ] && [ "$si" -lt 30 ]; do sleep 0.1; si=$((si + 1)); done
    [ -f "$sd/exit" ] || kill -s KILL -- "-$sg" 2>/dev/null
    si=0
    while [ ! -f "$sd/exit" ] && runner_alive "$sd" && [ "$si" -lt 20 ]; do sleep 0.1; si=$((si + 1)); done
  fi
  runner_alive "$sd" || mark_lost "$sd"
  return 0
}`

/** 远端写给路过的人看的说明（第一次在这台机器上建根目录时写一次） */
const README_TEXT = `This folder was created over SSH by ShuviX running on other machines.

One folder per ShuviX installation (origin.json says which machine it is),
one folder per command it ran (task.json says what, when and from which
conversation). out.log is the command's output, exit holds its exit code.

ShuviX installed on this machine does not use this folder; its own data lives
in ~/.shuvix and its app data folder. Finished commands are removed by the
ShuviX that started them. Deleting this folder by hand is safe once nothing in
it is still running.
`

/** 远端目录名 / 变量里能放的字符（会被拼进单引号里，也会成为路径的一段） */
const SAFE_ID = /^[A-Za-z0-9_-]{1,80}$/

/**
 * tool call id → 远端任务目录名：`<id 或其哈希>-<这次调用的随机后缀>`。
 *
 * id 来自模型供应商，长什么样不归我们管；只含安全字符、不太长的原样用（远端的人一眼认得出），否则取哈希。
 * **后缀不能省**：有的供应商每一轮都从头编号（`functions.exec:0`），同一个 id 会在一个会话里反复出现 ——
 * 而启动脚本是可重放的（目录里已有 runner 就只 poll），没有后缀的话，第二条命令会被当成第一条的重连，
 * 根本不起。后缀由调用方每次调用生成一次，同一次调用的重试沿用它。task.json 里总有原样的 id。
 */
export function remoteTaskDirName(
  taskId: string,
  hash: (s: string) => string,
  suffix: string
): string {
  const base = /^[A-Za-z0-9_-]{1,64}$/.test(taskId) ? taskId : `t-${hash(taskId).slice(0, 24)}`
  return `${base}-${suffix}`
}

function assertSafe(name: string, value: string): void {
  if (!SAFE_ID.test(value)) throw new Error(`unsafe ${name} for a remote script: ${value}`)
}

/** 一段内容的 heredoc 结束符：内容里不能恰好有一行就是它 */
function delimiterFor(contents: string[], random: () => string): string {
  for (;;) {
    const tag = `SHUVIX_${random()}`
    if (!contents.some((c) => c.split('\n').includes(tag))) return tag
  }
}

/** 包成函数再调用：半截脚本 = 语法错误 = 什么都不执行（见文件头） */
function wrap(vars: Record<string, string | number>, body: string): string {
  const head = Object.entries(vars)
    .map(([k, v]) => `${k}='${String(v)}'`)
    .join('\n')
  return `${head}\n${REMOTE_LIB}\nshuvix_main() {\n${body}\n}\nshuvix_main\n`
}

export interface LaunchScriptParams {
  installId: string
  runId: string
  /** 远端目录名（remoteTaskDirName） */
  dir: string
  /** 原地等多久（秒）：窗口内结束的把结果带回、目录当场删掉 */
  waitSec: number
  /** 一次带回的日志上限（字节） */
  capBytes: number
  /** task.json 的内容 */
  manifest: Record<string, unknown>
  /** origin.json 的内容（远端还没有才写） */
  origin: Record<string, unknown>
  /** 用户的命令原文 —— 由远端用户的登录 shell 解释，与 `ssh host cmd` 同义 */
  command: string
  /**
   * runner 交给 `systemd-run --user` 起（这台机器登出会杀进程、而用户开了 linger，见 §7）；
   * 给的是 unit 名
   */
  systemdUnit?: string
  /** 16 位随机十六进制（测试注入定值） */
  random: () => string
}

/**
 * 启动：写目录与文件，脱离地起 runner，原地 poll 至多 waitSec 秒。
 *
 * **可重放**：目录里已经有 runner 了（上一次启动的连接在回话前断了），就只 poll，绝不再起第二个。
 * 所以启动**从不删目录**，哪怕命令在窗口内就结束了 —— 回执丢在路上的话，重放靠的正是这个目录还在；
 * 本机收全之后另发 reap。
 */
export function buildLaunchScript(p: LaunchScriptParams): string {
  assertSafe('installId', p.installId)
  assertSafe('runId', p.runId)
  assertSafe('dir', p.dir)
  if (p.systemdUnit) assertSafe('systemdUnit', p.systemdUnit)
  const manifest = JSON.stringify(p.manifest, null, 2)
  const origin = JSON.stringify(p.origin, null, 2)
  const tag = delimiterFor([p.command, manifest, origin, README_TEXT], p.random)
  const runScript = String.raw`d=$1
trap '' HUP
[ -f "$d/env" ] && . "$d/env" && cd "$HOME" 2>/dev/null
echo $$ > "$d/runner"
# 包装层先写自己的 pid（它就是组长 = pgid），再变成用户的 shell 去解释命令
wrap='echo $$ > "$1/pgid"; s=$SHELL; [ -n "$s" ] || s=/bin/sh; exec "$s" "$1/cmd"'
if command -v setsid >/dev/null 2>&1; then
  # 后台作业不是组长，setsid 不 fork、原地变成会话组长，$! 就是命令本身；
  # util-linux 有 --wait 就再加一道保险（万一 fork 了也等子进程、交回它的退出码）。busybox 没有 --wait
  if setsid --help 2>&1 | grep -q -- --wait; then
    setsid -w sh -c "$wrap" _ "$d" > "$d/out.log" 2>&1 < /dev/null &
  else
    setsid sh -c "$wrap" _ "$d" > "$d/out.log" 2>&1 < /dev/null &
  fi
else
  # 没有 util-linux setsid（macOS）：bash 的作业控制给后台作业单独的进程组（无 tty 也行，dash 不行）
  set -m
  sh -c "$wrap" _ "$d" > "$d/out.log" 2>&1 < /dev/null &
fi
wait $!
code=$?
printf '%s %s\n' "$code" "$(date +%s)" > "$d/exit.tmp" && mv "$d/exit.tmp" "$d/exit"`
  const start = p.systemdUnit
    ? String.raw`  export -p > "$d/env"
  systemd-run --user --collect --quiet --unit="$UNIT" sh "$d/run" "$d" > "$d/start.log" 2>&1`
    : String.raw`  if command -v setsid >/dev/null 2>&1; then
    nohup sh "$d/run" "$d" > /dev/null 2>&1 < /dev/null &
  else
    nohup bash "$d/run" "$d" > /dev/null 2>&1 < /dev/null &
  fi`
  const body = String.raw`  umask 077
  d="$ROOT/$I/$T"
  if [ -f "$d/runner" ] || [ -f "$d/exit" ]; then
    poll_task "$d" "$WAIT" 0 "$CAP"
    exit 0
  fi
  mkdir -p "$d" || { echo "SHUVIX-STATE ERROR cannot-create-task-folder SIZE 0"; exit 0; }
  [ -f "$ROOT/README" ] || cat > "$ROOT/README" <<'${tag}'
${README_TEXT}${tag}
  [ -f "$ROOT/$I/origin.json" ] || cat > "$ROOT/$I/origin.json" <<'${tag}'
${origin}
${tag}
  cat > "$d/task.json" <<'${tag}'
${manifest}
${tag}
  cat > "$d/cmd" <<'${tag}'
${p.command}
${tag}
  cat > "$d/run" <<'${tag}'
${runScript}
${tag}
  date +%s > "$d/started"
  touch "$d/seen"
${start}
  i=0
  while [ ! -s "$d/pgid" ] && [ ! -f "$d/exit" ] && [ "$i" -lt 250 ]; do sleep 0.02; i=$((i + 1)); done
  if [ ! -s "$d/pgid" ] && [ ! -f "$d/exit" ]; then
    echo "SHUVIX-STATE ERROR runner-did-not-start SIZE 0"
    cat "$d/start.log" 2>/dev/null
    rm -rf "$d"
    exit 0
  fi
  poll_task "$d" "$WAIT" 0 "$CAP"`
  return wrap(
    {
      I: p.installId,
      T: p.dir,
      RUN: p.runId,
      WAIT: Math.max(0, Math.floor(p.waitSec)),
      CAP: Math.floor(p.capBytes),
      ...(p.systemdUnit ? { UNIT: p.systemdUnit } : {})
    },
    body
  )
}

/** 轮询：至多等 waitSec 秒，带回 from 之后的日志。从不删目录（见 REMOTE_LIB 的说明） */
export function buildPollScript(p: {
  installId: string
  dir: string
  waitSec: number
  fromByte: number
  capBytes: number
}): string {
  assertSafe('installId', p.installId)
  assertSafe('dir', p.dir)
  return wrap(
    {
      I: p.installId,
      T: p.dir,
      WAIT: Math.max(0, Math.floor(p.waitSec)),
      FROM: Math.max(0, Math.floor(p.fromByte)),
      CAP: Math.floor(p.capBytes)
    },
    '  poll_task "$ROOT/$I/$T" "$WAIT" "$FROM" "$CAP"'
  )
}

/**
 * 本机已经收全（结束了，且远端日志不比 fromByte 长）才删目录。条件在远端复核：重发的、过期的 reap
 * 碰不到一条还在跑或还有字节没取走的任务。可重放 —— 目录早没了也照样回 REAPED。
 */
export function buildReapScript(p: { installId: string; dir: string; fromByte: number }): string {
  assertSafe('installId', p.installId)
  assertSafe('dir', p.dir)
  return wrap(
    { I: p.installId, T: p.dir, FROM: Math.max(0, Math.floor(p.fromByte)) },
    String.raw`  d="$ROOT/$I/$T"
  if [ ! -d "$d" ]; then echo "REAPED"; exit 0; fi
  rsize=$(wc -c < "$d/out.log" 2>/dev/null | tr -d ' ')
  [ -n "$rsize" ] || rsize=0
  if [ -f "$d/exit" ] && [ "$rsize" -le "$FROM" ]; then rm -rf "$d"; echo "REAPED"; else echo "KEPT"; fi`
  )
}

/** 停一条任务（等它真的停下，至多几秒）。结局由之后的 poll 带回 */
export function buildStopScript(p: { installId: string; dir: string }): string {
  assertSafe('installId', p.installId)
  assertSafe('dir', p.dir)
  return wrap({ I: p.installId, T: p.dir }, '  stop_task "$ROOT/$I/$T"\n  echo "STOPPED"')
}

/**
 * 停掉并删除若干任务 —— 退出 / 删会话时经脱离的 ssh 发出去（sshScriptDetached），没人等回话。
 *
 * 活儿先放进远端后台再回话：连接随时可能断（本地进程已经退出），在前台做的话断在哪一步就停在哪一步。
 */
export function buildKillScript(p: { installId: string; dirs: string[] }): string {
  assertSafe('installId', p.installId)
  for (const dir of p.dirs) assertSafe('dir', dir)
  return wrap(
    { I: p.installId, DIRS: p.dirs.join(' ') },
    String.raw`  for t in $DIRS; do
    ( stop_task "$ROOT/$I/$t"; rm -rf "$ROOT/$I/$t" ) < /dev/null > /dev/null 2>&1 &
  done
  echo "KILL-SENT"`
  )
}

/**
 * 每台主机每次运行第一次连上时跑一次：探测这台远端，顺手清理。
 *
 * 清理只碰**本安装**目录下的：结束超过 gcDays 天的删掉；还没结束、却不是本轮运行起的、且超过 staleSec
 * 秒没人来 poll 的（上一轮 ShuviX 崩了或退出时连不上）停掉并标 orphaned。「seen 新鲜就不动」保护的是
 * 复制了数据目录的另一台机器 —— 同一个 installId、它还活着在 poll。
 *
 * KillUserProcesses 按 logind 自己的规则判（manager_shall_kill）：排除名单**为空**时 root 照样被排除，
 * 写了名单就只看名单；KillOnlyUsers 非空时只杀名单里的人。只在本进程确实处于登录会话的 scope 里时才算。
 */
export function buildProbeScript(p: {
  installId: string
  runId: string
  staleSec: number
  gcDays: number
}): string {
  assertSafe('installId', p.installId)
  assertSafe('runId', p.runId)
  return wrap(
    {
      I: p.installId,
      RUN: p.runId,
      STALE: Math.floor(p.staleSec),
      GC_DAYS: Math.floor(p.gcDays)
    },
    String.raw`  echo "${PROBE_MARKER}"
  echo "os=$(uname -s 2>/dev/null)"
  if command -v setsid >/dev/null 2>&1; then echo "group=setsid"
  elif command -v bash >/dev/null 2>&1; then echo "group=jobctl"
  else echo "group=none"; fi
  if mkdir -p "$ROOT/$I" 2>/dev/null && [ -w "$ROOT/$I" ]; then echo "home=ok"; else echo "home=unwritable"; fi
  kup=0
  if grep -q 'session-[^/]*\.scope' /proc/self/cgroup 2>/dev/null && command -v busctl >/dev/null 2>&1; then
    me=$(id -un)
    prop() { busctl get-property org.freedesktop.login1 /org/freedesktop/login1 org.freedesktop.login1.Manager "$1" 2>/dev/null; }
    kon=$(prop KillUserProcesses); kex=$(prop KillExcludeUsers); konly=$(prop KillOnlyUsers)
    if { [ -z "$kex" ] || [ "$kex" = "as 0" ]; } && [ "$me" = root ]; then kup=0
    elif printf '%s' "$kex" | grep -qF "\"$me\""; then kup=0
    elif [ -n "$konly" ] && [ "$konly" != "as 0" ]; then printf '%s' "$konly" | grep -qF "\"$me\"" && kup=1
    elif [ "$kon" = "b true" ]; then kup=1; fi
  fi
  echo "kup=$kup"
  echo "linger=$(loginctl show-user "$(id -un)" -p Linger --value 2>/dev/null)"
  if command -v systemd-run >/dev/null 2>&1; then echo "systemd_run=1"; else echo "systemd_run=0"; fi
  orphaned=0; gc=0; t=$(now)
  for d in "$ROOT/$I"/*; do
    [ -f "$d/task.json" ] || continue
    if [ ! -f "$d/exit" ]; then
      runner_alive "$d" || mark_lost "$d"
    fi
    if [ -f "$d/exit" ]; then
      ended=$(cut -d' ' -f2 "$d/exit")
      [ -n "$ended" ] || ended=$t
      if [ $((t - ended)) -gt $((GC_DAYS * 86400)) ]; then rm -rf "$d"; gc=$((gc + 1)); fi
      continue
    fi
    run=$(sed -n 's/.*"runId": *"\([^"]*\)".*/\1/p' "$d/task.json")
    [ "$run" = "$RUN" ] && continue
    [ $((t - $(mtime "$d/seen"))) -lt "$STALE" ] && continue
    touch "$d/orphaned"; stop_task "$d"; orphaned=$((orphaned + 1))
  done
  echo "sweep orphaned=$orphaned gc=$gc"`
  )
}

// ─── 回执解析 ────────────────────────────────────────

export type RemoteState =
  | { kind: 'running' }
  | { kind: 'exit'; code: number; stopped: boolean; orphaned: boolean }
  | { kind: 'lost' }
  | { kind: 'gone' }
  | { kind: 'error'; reason: string }

export interface RemoteReport {
  state: RemoteState
  /** 远端 out.log 当前的字节数 */
  size: number
  /** 这一轮带回的日志字节 */
  body: Buffer
}

const STATE_LINE =
  /^SHUVIX-STATE (RUNNING|EXIT (-?\d+)((?: stopped| orphaned)*)|LOST|GONE|ERROR (\S+)) SIZE (\d+)$/
const SENTINEL = Buffer.from('SHUVIX-STATE ')

/**
 * 解析一轮 launch / poll 的回执。认不出（没有哨兵行）= null —— 调用方当作这一轮没成，
 * 绝不能把半截输出当日志收下（字节偏移会错位）。
 *
 * 哨兵行**不必是第一行**：远端登录 shell 的启动文件（`.bashrc` 里的 echo）会先往 stdout 打字，ssh 原样
 * 带回来。取第一个行首的哨兵，它之前的一律丢掉，之后的才是日志字节。
 */
export function parseReport(stdout: Buffer): RemoteReport | null {
  let at = stdout.indexOf(SENTINEL)
  while (at > 0 && stdout[at - 1] !== 0x0a) at = stdout.indexOf(SENTINEL, at + 1)
  if (at < 0) return null
  const nl = stdout.indexOf(0x0a, at)
  if (nl < 0) return null
  const m = STATE_LINE.exec(stdout.subarray(at, nl).toString('utf-8'))
  if (!m) return null
  const body = stdout.subarray(nl + 1)
  const size = Number(m[5])
  if (m[1] === 'RUNNING') return { state: { kind: 'running' }, size, body }
  if (m[1] === 'LOST') return { state: { kind: 'lost' }, size, body }
  if (m[1] === 'GONE') return { state: { kind: 'gone' }, size, body }
  if (m[4] !== undefined) return { state: { kind: 'error', reason: m[4] }, size, body }
  const flags = m[3] ?? ''
  return {
    state: {
      kind: 'exit',
      code: Number(m[2]),
      stopped: flags.includes('stopped'),
      orphaned: flags.includes('orphaned')
    },
    size,
    body
  }
}

export interface ProbeResult {
  os: string
  /** 进程组的办法：util-linux setsid / bash 作业控制 / 都没有（只能杀 runner 记下的 pid） */
  group: 'setsid' | 'jobctl' | 'none'
  homeWritable: boolean
  /** 这台机器登出会杀掉本用户会话里的进程（logind KillUserProcesses 对本用户生效） */
  killUserProcesses: boolean
  linger: boolean
  systemdRun: boolean
  orphaned: number
  collected: number
}

/** 解析探测回执；没有标记行 = 这台远端跑不了脚本（null） */
export function parseProbe(stdout: string): ProbeResult | null {
  const lines = stdout.split('\n').map((l) => l.trim())
  if (!lines.includes(PROBE_MARKER)) return null
  const kv = new Map<string, string>()
  for (const line of lines) {
    const eq = line.indexOf('=')
    if (eq > 0 && !line.includes(' ')) kv.set(line.slice(0, eq), line.slice(eq + 1))
  }
  const sweep = /^sweep orphaned=(\d+) gc=(\d+)$/m.exec(stdout)
  const group = kv.get('group')
  return {
    os: kv.get('os') ?? '',
    group: group === 'setsid' || group === 'jobctl' ? group : 'none',
    homeWritable: kv.get('home') === 'ok',
    killUserProcesses: kv.get('kup') === '1',
    linger: kv.get('linger') === 'yes',
    systemdRun: kv.get('systemd_run') === '1',
    orphaned: sweep ? Number(sweep[1]) : 0,
    collected: sweep ? Number(sweep[2]) : 0
  }
}
