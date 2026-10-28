/**
 * Host half of `dsh-hdd-visual`.
 *
 * The splash, the emblem and the cue player are renderer concerns, so this half
 * contributes exactly one thing: a place for the renderer to say what happened.
 *
 * Why it exists: a skipped splash and a bundle that never loaded look identical
 * from outside — the window just does nothing. The client posts each phase here
 * and the lines land in `$DSH_HOME/hdd-visual.log`, which is readable without
 * opening DevTools.
 */
import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const name = 'hdd-visual'
export const inject = ['webServer']

const LOG = join(
  process.env.DSH_HOME || join(process.env.USERPROFILE || homedir(), '.dsh'),
  'hdd-visual.log',
)

/** Keep the log bounded; a runaway reporter must not fill the disk. */
const MAX_LOG_BYTES = 256 * 1024

function readBody(req, limit = 32 * 1024) {
  return new Promise((resolve) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size <= limit) chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', () => resolve(''))
  })
}

export function apply(ctx) {
  ctx.logger?.info?.(`hdd-visual: splash diagnostics go to ${LOG}`)

  /* A line here proves the Host half mounted, which separates "client never ran"
     from "client ran and skipped" when the log is read afterwards. */
  void mkdir(dirname(LOG), { recursive: true })
    .then(() => appendFile(LOG, `${new Date().toISOString()} {"event":"host-apply"}\n`, 'utf8'))
    .catch(() => {})

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: '/hdd/report',
        handler: async (req, res) => {
          if (req.method === 'GET') {
            const body = await readFile(LOG, 'utf8').catch(() => '')
            const payload = Buffer.from(body.slice(-64 * 1024), 'utf8')
            res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
            res.end(payload)
            return
          }
          const raw = await readBody(req)
          const line = `${new Date().toISOString()} ${raw.replace(/\s+/g, ' ').slice(0, 2000)}\n`
          try {
            await mkdir(dirname(LOG), { recursive: true })
            const existing = await readFile(LOG, 'utf8').catch(() => '')
            /* Rotate rather than grow without bound. */
            await appendFile(LOG, existing.length > MAX_LOG_BYTES ? '' : line, 'utf8')
            if (existing.length > MAX_LOG_BYTES) {
              await appendFile(LOG, `${new Date().toISOString()} {"event":"log-reset"}\n${line}`, 'utf8')
            }
          } catch {
            /* Diagnostics are best-effort by definition. */
          }
          res.writeHead(204, { 'cache-control': 'no-store' })
          res.end()
        },
      }),
    'hdd-visual-report-route',
  )
}
