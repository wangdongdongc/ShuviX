// Shared helpers for the coding probe's hidden graders. A grader runs after the agent is done, on a copy
// of the repo the agent never saw it in, and prints one JSON line: { checks: [{ name, core, pass, error? }] }.
// "core" checks decide pass/fail for the task; the others are reported only. `fact` names the hidden fact a
// check tests (tasks with a simulated user: the requirement only the user knew). `constraint` names the rule
// from the user's early message a check tests (long set); those are counted apart from the task's checks.
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { inspect, isDeepStrictEqual } from 'node:util'

export function grader(repo, { bin = 'bin/ledger.js' } = {}) {
  const checks = []
  const scratch = mkdtempSync(join(tmpdir(), 'probe-grade-'))
  const servers = []

  async function check(name, fn, opts = {}) {
    const core = opts.core !== false && !opts.constraint
    const fact = opts.fact ? { fact: opts.fact } : {}
    const constraint = opts.constraint ? { constraint: opts.constraint } : {}
    try {
      await fn()
      checks.push({ name, core, ...fact, ...constraint, pass: true })
    } catch (err) {
      const error = String((err && err.message) || err).slice(0, 400)
      checks.push({ name, core, ...fact, ...constraint, pass: false, error })
    }
  }

  const mod = (rel) => import(pathToFileURL(join(repo, rel)).href)

  /** Run the CLI as a user would; stdout split into non-empty lines. */
  function cli(args, env = {}, { timeout = 15000 } = {}) {
    const started = Date.now()
    const r = spawnSync(process.execPath, [join(repo, bin), ...args], {
      cwd: repo,
      encoding: 'utf8',
      timeout,
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, ...env }
    })
    return {
      code: r.status,
      out: (r.stdout || '').split('\n').filter((l) => l.trim() !== ''),
      err: r.stderr || '',
      ms: Date.now() - started,
      timedOut: r.error?.code === 'ETIMEDOUT'
    }
  }

  /**
   * Start `<bin> serve --port 0 ...args` and wait for its "listening on http://..." line.
   * Returns { url, call(method, path, body) → { status, body }, stop() }. Servers left running are
   * stopped by done().
   */
  async function serve(args = []) {
    const child = spawn(process.execPath, [join(repo, bin), 'serve', '--port', '0', ...args], {
      cwd: repo,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    servers.push(child)
    let output = ''
    const url = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`server did not start: ${output}`)), 15000)
      const onData = (chunk) => {
        output += chunk
        const m = output.match(/listening on (http:\/\/\S+)/)
        if (m) {
          clearTimeout(timer)
          resolve(m[1])
        }
      }
      child.stdout.on('data', onData)
      child.stderr.on('data', (chunk) => (output += chunk))
      child.on('exit', (code) => {
        clearTimeout(timer)
        reject(new Error(`server exited ${code}: ${output}`))
      })
    })
    const call = async (method, path, body) => {
      const res = await fetch(url + path, {
        method,
        headers: body === undefined ? {} : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body)
      })
      const text = await res.text()
      let parsed
      try {
        parsed = JSON.parse(text)
      } catch {
        parsed = text
      }
      return { status: res.status, body: parsed }
    }
    const stop = () =>
      new Promise((resolve) => {
        if (child.exitCode !== null) return resolve()
        child.once('exit', () => resolve())
        child.kill()
      })
    return { url, call, stop }
  }

  /** A fresh empty directory under the grader's scratch folder */
  function dir(name) {
    const path = join(scratch, name)
    mkdirSync(path, { recursive: true })
    return path
  }

  /** Evaluate an expression against the repo's modules in a child process (to vary TZ). */
  function inChild(code, env = {}) {
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
      cwd: repo,
      encoding: 'utf8',
      timeout: 15000,
      env: { ...process.env, ...env }
    })
    if (r.status !== 0) throw new Error(`child failed: ${(r.stderr || '').slice(0, 300)}`)
    return JSON.parse(r.stdout)
  }

  function file(name, text) {
    const path = join(scratch, name)
    writeFileSync(path, text)
    return path
  }

  function eq(actual, expected, what = '') {
    if (!isDeepStrictEqual(actual, expected)) {
      throw new Error(
        `${what ? `${what}: ` : ''}expected ${inspect(expected)}, got ${inspect(actual)}`
      )
    }
  }

  function ok(cond, what) {
    if (!cond) throw new Error(what)
  }

  const done = () => {
    for (const child of servers) if (child.exitCode === null) child.kill()
    process.stdout.write(JSON.stringify({ checks }) + '\n')
    process.exit(0)
  }

  return { check, mod, cli, serve, inChild, file, dir, eq, ok, done, repo, scratch }
}

/** Last whitespace-separated token of a report line, e.g. "food        $12.50" → "$12.50" */
export const lastToken = (line) => line.trim().split(/\s+/).at(-1)
