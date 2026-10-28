/**
 * Host half of the lab probe — answers two questions the design depends on:
 *
 *   1. can a bundle stream a static audio file (a `.m4a`, i.e. an extension the
 *      package-asset route refuses) through `ctx.webServer`, ranges included?
 *   2. does an `<audio>` element started with no user gesture actually play in
 *      the desktop shell, and is a bare `AudioContext` usable or suspended?
 *
 * The second question can only be answered from inside the renderer, so the
 * client half posts its findings here and they are appended to
 * `$DSH_HOME/hdd-lab-audio.log`, readable from outside the app.
 */
import { createReadStream } from 'node:fs'
import { appendFile, mkdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const TONE = fileURLToPath(new URL('./assets/test-tone.m4a', import.meta.url))
const LOG = join(
  process.env.DSH_HOME || join(process.env.USERPROFILE || homedir(), '.dsh'),
  'hdd-lab-audio.log',
)

export const name = 'lab-audio'
export const inject = ['webServer']

function note(line) {
  return mkdir(dirname(LOG), { recursive: true })
    .then(() => appendFile(LOG, line + '\n', 'utf8'))
    .catch(() => {})
}

/* Read at most a few kilobytes of a POST body; the probe sends one small object. */
function readBody(req, limit = 64 * 1024) {
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
  ctx.logger?.info?.(`lab-audio: probe installed, tone at ${TONE}, log at ${LOG}`)
  note(`installed ${new Date().toISOString()}`)

  /* Static audio with byte ranges: the pattern a shipped bundle would use, since
     the package-asset route only serves image types. */
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: '/lab-audio/file',
        handler: async (req, res) => {
          const info = await stat(TONE).catch(() => null)
          if (!info || !info.isFile()) {
            res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
            res.end('test-tone.m4a missing')
            return
          }
          const base = {
            'content-type': 'audio/mp4',
            'accept-ranges': 'bytes',
            'cache-control': 'no-store',
          }
          const match = req.headers.range ? /bytes=(\d*)-(\d*)/.exec(req.headers.range) : null
          if (match) {
            const start = match[1] ? Number(match[1]) : 0
            const end = match[2] ? Math.min(Number(match[2]), info.size - 1) : info.size - 1
            if (!Number.isFinite(start) || start > end || start >= info.size) {
              res.writeHead(416, { 'content-range': `bytes */${info.size}` })
              res.end()
              return
            }
            res.writeHead(206, {
              ...base,
              'content-length': end - start + 1,
              'content-range': `bytes ${start}-${end}/${info.size}`,
            })
            createReadStream(TONE, { start, end }).pipe(res)
            return
          }
          res.writeHead(200, { ...base, 'content-length': info.size })
          createReadStream(TONE).pipe(res)
        },
      }),
    'lab-audio-file-route',
  )

  /* The client half's report lands here; one JSON object per line. */
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: '/lab-audio/report',
        handler: async (req, res) => {
          const body = await readBody(req)
          const line = `${new Date().toISOString()} ${body.replace(/\s+/g, ' ').slice(0, 4000)}`
          await note(line)
          res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
          res.end('ok')
        },
      }),
    'lab-audio-report-route',
  )
}
