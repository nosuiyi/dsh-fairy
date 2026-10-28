/**
 * Reproduce the desktop's Host handshake outside the shell.
 *
 * The desktop boots `dsh-desktop-host` as a child (see `lib/main.js:3797`), gets a
 * launch URL over IPC, then:
 *
 *   1. `authenticateWebHost(url)` — GET with `redirect: 'manual'`, expects 303 + Set-Cookie
 *   2. `connectDesktopWelcome(url, net.fetch)` — GET again with `credentials: 'include'`,
 *      requires a 2xx or throws "desktop welcome: Web authentication failed"
 *
 * This script does the same three things with Node's fetch (which shares nothing with
 * Chromium's cookie jar) and prints every status, so "which step is not ok" stops being
 * a guess.
 *
 *   node lab/probe-host-handshake.mjs
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const APP = 'B:/deepseek harness'
const EXE = join(APP, 'DeepSeek Harness.exe')
const RUNTIME_DIR = join(APP, 'resources/app.asar/dsh')
const PRIMARY_RUNTIME = join(APP, 'resources/runtime/primary-runtime')
const PROFILE = join(process.env.USERPROFILE || homedir(), '.dsh', 'profiles', 'desktop')

for (const [label, path] of [['exe', EXE], ['runtime', RUNTIME_DIR], ['primary', PRIMARY_RUNTIME], ['profile', PROFILE]]) {
  if (!existsSync(path)) {
    console.error(`missing ${label}: ${path}`)
    process.exit(2)
  }
}

const child = spawn(EXE, [
  '--expose-internals',
  join(RUNTIME_DIR, 'node_modules/@deepseek-ai/dsh-desktop-host/lib/index.js'),
  RUNTIME_DIR,
  PROFILE,
  PRIMARY_RUNTIME,
], {
  cwd: PROFILE,
  env: {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    DSH_CLIENT_VERSION: 'desktop-probe',
  },
  stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
})

let stderr = ''
child.stderr.setEncoding('utf8')
child.stderr.on('data', (chunk) => { stderr += chunk })
child.stdout.setEncoding('utf8')
child.stdout.on('data', (chunk) => process.stdout.write(`[host] ${chunk}`))

const ready = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`no ready event in 45s\nstderr:\n${stderr.slice(-2000)}`)), 45_000)
  child.on('message', (message) => {
    if (message && message.type === 'ready') {
      clearTimeout(timer)
      resolve(message)
    }
  })
  child.once('exit', (code) => {
    clearTimeout(timer)
    reject(new Error(`host exited ${String(code)} before ready\nstderr:\n${stderr.slice(-2000)}`))
  })
}).catch((error) => {
  console.error(error.message)
  child.kill('SIGTERM')
  process.exit(1)
})

console.log(`\nready url: ${ready.url}\ninjections: ${Array.isArray(ready.injections) ? ready.injections.length : 'none'}\n`)

const step = async (label, init) => {
  try {
    const response = await fetch(ready.url, init)
    const cookie = response.headers.get('set-cookie')
    const body = await response.text()
    console.log(`${label}`)
    console.log(`  status      : ${response.status}${response.statusText ? ' ' + response.statusText : ''}`)
    console.log(`  location    : ${response.headers.get('location') ?? '-'}`)
    console.log(`  set-cookie  : ${cookie === null ? '-' : cookie.slice(0, 60)}…`)
    console.log(`  bytes       : ${body.length}`)
    console.log(`  body head   : ${body.slice(0, 90).replace(/\s+/g, ' ')}`)
    return cookie
  } catch (error) {
    console.log(`${label}\n  threw: ${String(error)}`)
    return null
  } finally {
    console.log('')
  }
}

/* 1. Launch URL, no redirect following — the shell's authenticateWebHost. */
const cookie = await step('1) GET url (redirect: manual)   ← authenticateWebHost', { redirect: 'manual' })

/* 2. The same URL again, following redirects, carrying the cookie — connectDesktopWelcome. */
await step('2) GET url with cookie (redirect: follow)   ← connectDesktopWelcome', {
  redirect: 'follow',
  headers: cookie === null ? {} : { cookie: cookie.split(';')[0] },
})

/* 3. Control: the same request without the cookie. */
await step('3) GET url without cookie (redirect: follow)', { redirect: 'follow' })

/* 4. The page the redirect points at. */
const origin = new URL(ready.url).origin
await step('4) GET / with cookie', {
  redirect: 'follow',
  headers: cookie === null ? {} : { cookie: cookie.split(';')[0] },
})

child.kill('SIGTERM')
await new Promise((resolve) => setTimeout(resolve, 1500))
if (!child.killed) child.kill('SIGKILL')
console.log('host stopped')
