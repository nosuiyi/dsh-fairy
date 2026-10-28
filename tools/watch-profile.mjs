#!/usr/bin/env node
/**
 * Watch the desktop profile manifest and record every rewrite.
 *
 * Something rewrites `profiles/desktop/package.json` roughly 30 seconds after the
 * app starts and drops third-party bundles while leaving others. Static reading of
 * the sources did not identify the writer, so this records the evidence instead:
 * the moment of the change, the before/after bundle lists, and the process list at
 * that instant.
 *
 * Read-only: it never writes to the profile.
 *
 *   node tools/watch-profile.mjs --minutes 20
 *   node tools/watch-profile.mjs --file <package.json> --log <log path>
 */
import { execFile } from 'node:child_process'
import { appendFile, mkdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)
const argv = process.argv.slice(2)
const flag = (name, fallback) => {
  const index = argv.indexOf(`--${name}`)
  return index === -1 ? fallback : argv[index + 1]
}

const dshHome = process.env.DSH_HOME || join(process.env.USERPROFILE || homedir(), '.dsh')
const file = resolve(flag('file', join(dshHome, 'profiles', 'desktop', 'package.json')))
const log = resolve(flag('log', join(process.cwd(), 'docs', 'bundles-watch.log')))
const minutes = Number(flag('minutes', '20'))
const deadline = Date.now() + minutes * 60_000

const note = async (event) => {
  await mkdir(dirname(log), { recursive: true })
  await appendFile(log, `${new Date().toISOString()} ${JSON.stringify(event)}\n`, 'utf8')
}

const bundlesOf = async () => {
  const manifest = JSON.parse(await readFile(file, 'utf8'))
  return {
    bundles: manifest.dsh?.profile?.bundles ?? [],
    deps: Object.keys(manifest.dependencies ?? {}),
  }
}

/** Process snapshot at the moment of the change; the point is the command lines. */
const snapshot = async () => {
  try {
    const script = [
      "Get-CimInstance Win32_Process | Where-Object { $_.Name -match 'Harness|electron|node' } |",
      'Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress',
    ].join(' ')
    const { stdout } = await run('powershell', ['-NoProfile', '-Command', script], {
      timeout: 20_000,
      maxBuffer: 4 * 1024 * 1024,
    })
    const parsed = JSON.parse(stdout.trim() || '[]')
    const list = Array.isArray(parsed) ? parsed : [parsed]
    return list.map((item) => ({
      pid: item.ProcessId,
      ppid: item.ParentProcessId,
      name: item.Name,
      cmd: String(item.CommandLine ?? '').slice(0, 220),
    }))
  } catch (error) {
    return [{ error: String(error && error.message ? error.message : error).slice(0, 200) }]
  }
}

let last = await stat(file).catch(() => undefined)
const initial = await bundlesOf().catch(() => ({ bundles: [], deps: [] }))
await note({ event: 'start', file, log, minutes, ...initial })

const timer = setInterval(async () => {
  if (Date.now() > deadline) {
    await note({ event: 'stop', reason: 'deadline' })
    clearInterval(timer)
    process.exit(0)
  }
  const info = await stat(file).catch(() => undefined)
  if (info === undefined) return
  if (last !== undefined && info.mtimeMs === last.mtimeMs && info.size === last.size) return
  const previous = last
  last = info
  const after = await bundlesOf().catch(() => ({ bundles: [], deps: [] }))
  const before = initial
  await note({
    event: 'rewrite',
    mtime: new Date(info.mtimeMs).toISOString(),
    size: info.size,
    previousMtime: previous === undefined ? null : new Date(previous.mtimeMs).toISOString(),
    bundlesBefore: before.bundles,
    bundlesAfter: after.bundles,
    removed: before.bundles.filter((name) => !after.bundles.includes(name)),
    added: after.bundles.filter((name) => !before.bundles.includes(name)),
    processes: await snapshot(),
  })
  before.bundles = after.bundles
}, 250)

/* Keep the process alive explicitly; the interval alone is enough on Node, but a
   blocked parent could otherwise drop it. */
process.on('SIGINT', async () => {
  await note({ event: 'stop', reason: 'interrupted' })
  process.exit(0)
})
