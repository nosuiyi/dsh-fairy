/**
 * Host half of `dsh-hdd-voice`.
 *
 * Everything here answers "what does this machine have, and how does the renderer
 * get the bytes". Nothing is synthesised: the clips are files the user recorded or
 * generated once and dropped into the asset directory, which keeps the shipped
 * package free of third-party audio and free of any TTS runtime.
 *
 * Routes
 *   GET /hdd/info                      what the asset directory currently holds
 *   GET /hdd/asset?path=…              one file, byte ranges supported
 *   GET /hdd/greeting?bucket=…&hour=…  the clip to play for that hour
 *   GET /hdd/cue?since=<seq>           turn cues recorded since a sequence number
 */
import { createReadStream } from 'node:fs'
import { appendFile, mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  BUCKETS,
  bucketById,
  bucketForHour,
  readHour,
  pickGreeting,
  readInventory,
  resolveAssetFile,
  resolveAssetRoot,
} from './lib/asset-store.js'

export const name = 'hdd-voice'
export const inject = ['webServer']

/** How many cue events are remembered for a client that polls late. */
const CUE_HISTORY = 64

/**
 * One line per cue decision, in the same log the skin already writes.
 *
 * "It played four times" is not something to argue about from memory: with this line
 * the count and its reason are in the file.
 */
const LOG = join(
  process.env.DSH_HOME || join(process.env.USERPROFILE || homedir(), '.dsh'),
  'hdd-visual.log',
)

function trace(detail) {
  const line = `${new Date().toISOString()} {"event":"cue","detail":${JSON.stringify(detail)}}\n`
  void appendFile(LOG, line, 'utf8').catch(() => {})
}

/** JSON response helper. */
function json(res, status, body) {
  const payload = Buffer.from(JSON.stringify(body), 'utf8')
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(payload.length),
    'cache-control': 'no-store',
  })
  res.end(payload)
}

/** Stream one file with byte-range support, which `<audio>`/`<video>` need to seek. */
async function streamFile(res, file, rangeHeader) {
  const base = {
    'content-type': file.mediaType,
    'accept-ranges': 'bytes',
    'cache-control': 'no-store',
  }
  const match = typeof rangeHeader === 'string' ? /bytes=(\d*)-(\d*)/.exec(rangeHeader) : null
  if (match === null) {
    res.writeHead(200, { ...base, 'content-length': String(file.size) })
    createReadStream(file.absolute).pipe(res)
    return
  }
  const start = match[1] === '' ? 0 : Number(match[1])
  const end = match[2] === '' ? file.size - 1 : Math.min(Number(match[2]), file.size - 1)
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= file.size) {
    res.writeHead(416, { 'content-range': `bytes */${file.size}` })
    res.end()
    return
  }
  res.writeHead(206, {
    ...base,
    'content-length': String(end - start + 1),
    'content-range': `bytes ${start}-${end}/${file.size}`,
  })
  createReadStream(file.absolute, { start, end }).pipe(res)
}

export function apply(ctx) {
  const root = resolveAssetRoot()
  /* Says which cue mode this process actually loaded; without it a stale Host looks
     exactly like a broken one. */
  trace({ kind: 'voice-apply', cueMode: 'per-run' })

  /* One folder per time-of-day bucket: the user drops a clip in the right folder and
     never has to rename anything. Created on every start, so a fresh install already
     shows the six folders instead of an empty `greeting/`. */
  for (const bucket of BUCKETS) {
    void mkdir(join(root, 'greeting', bucket.id), { recursive: true }).catch(() => {})
  }
  void mkdir(join(root, 'cue'), { recursive: true }).catch(() => {})

  /* --------------------------------------------------------------- cue feed
   *
   * The cue belongs to the agent's **run**, not to a turn.
   *
   * One user message is several turns in DSH (one per model round trip), so keying the
   * cues on `turn/start` / `turn/end` meant "推演中" and "处理完毕" played once per
   * round trip — that is the repetition the user hears. `api-session/status` flips
   * exactly twice per run: `running: true` at the start and `running: false` at the
   * end, which is the signal these two sounds actually stand for.
   */
  let cueSeq = 0
  const cues = []

  const pushCue = (kind, sessionId, detail) => {
    cueSeq += 1
    cues.push({ seq: cueSeq, kind, sessionId, at: Date.now() })
    if (cues.length > CUE_HISTORY) cues.splice(0, cues.length - CUE_HISTORY)
    /* A line per cue, so "how many times did it play" is answerable from the log
       instead of by ear. */
    trace({ kind, sessionId, ...detail })
  }

  /** sessionId → true when the session is delegated work that must stay silent. */
  const background = new Map()
  /** sessionId → whether that agent is currently running, plus its last turn-end reason. */
  const runs = new Map()

  const classify = (sessionId, header, summary) => {
    if (summary !== undefined && summary !== null) {
      const delegated = summary.origin === 'subagent'
        || (summary.parentSessionId !== undefined && summary.parentSessionId !== null)
      background.set(sessionId, delegated)
      return
    }
    if (header === undefined || header === null) return
    const delegated = header.origin === 'subagent'
      || (header.parentSession !== undefined && header.parentSession !== null)
    background.set(sessionId, delegated)
  }

  /** Turn ends that are not a result: the user stopped it, or it was handed off. */
  const SILENT_ENDINGS = new Set(['aborted', 'interrupted', 'forked'])

  ctx.on('api-session/added', (summary) => {
    if (summary === undefined || summary === null) return
    classify(String(summary.sessionId ?? ''), undefined, summary)
  })

  /**
   * The one place a cue is decided, whichever status event reported the flip.
   *
   * `api-session/status` is the documented signal, `agent/status` carries the same
   * transition one layer down; taking both is harmless because the state machine is
   * idempotent, and it means one missing wiring does not silently kill the sounds.
   */
  const handleStatus = (id, running, source) => {
    if (id === '') return
    if (background.get(id) === true) {
      trace({ kind: 'status-skip', id, running, source, why: 'background' })
      return
    }
    const state = runs.get(id) ?? { running: false, reason: 'completed' }
    if (running) {
      if (state.running) return
      state.running = true
      runs.set(id, state)
      pushCue('thinking', id, { running: true, source })
      return
    }
    if (!state.running) {
      trace({ kind: 'status-idle', id, source })
      return
    }
    state.running = false
    const reason = state.reason ?? 'completed'
    state.reason = 'completed'
    runs.set(id, state)
    if (SILENT_ENDINGS.has(reason)) {
      trace({ kind: 'cue-skip', id, reason, source })
      return
    }
    pushCue(reason === 'completed' ? 'done' : 'failed', id, { running: false, reason, source })
  }

  ctx.on('api-session/status', (sessionId, running) => {
    handleStatus(String(sessionId ?? ''), running === true, 'api-session')
  })

  /* `agent/status` payload carries the agent, whose session supplies both the id and
     the header the background check needs. */
  ctx.on('agent/status', (payload) => {
    if (payload === undefined || payload === null) return
    const agent = payload.agent
    const session = agent === undefined || agent === null ? undefined : agent.session
    const id = session === undefined || session === null ? undefined : session.id
    if (id === undefined) return
    const key = String(id)
    if (!background.has(key)) classify(key, session.header)
    handleStatus(key, payload.status === 'running', 'agent')
  })

  /* Turn ends are still worth watching, but only for the *reason*: `running: false`
     alone cannot tell a finished run from a cancelled one. */
  ctx.on('session/event', (session, event) => {
    if (event === undefined || event === null) return
    const sessionId = session === undefined || session === null ? '' : String(session.id ?? '')
    if (!background.has(sessionId)) {
      classify(sessionId, session === undefined || session === null ? undefined : session.header)
    }
    if (event.type !== 'turn/end') return
    const reason = event.data === undefined || event.data === null ? undefined : event.data.reason
    const kind = reason !== undefined && reason !== null && reason.kind !== undefined
      ? String(reason.kind)
      : 'completed'
    const state = runs.get(sessionId) ?? { running: false, reason: 'completed' }
    state.reason = kind
    runs.set(sessionId, state)
  })

  ctx.on('api-session/status', (sessionId, running) => {
    const id = String(sessionId ?? '')
    if (background.get(id) === true) return
    const state = runs.get(id) ?? { running: false, reason: 'completed' }
    if (running === true) {
      /* A second `true` without an intervening `false` is not a new run. */
      if (state.running) return
      state.running = true
      runs.set(id, state)
      pushCue('thinking', id, { running: true })
      return
    }
    if (!state.running) return
    state.running = false
    const reason = state.reason ?? 'completed'
    state.reason = 'completed'
    runs.set(id, state)
    if (SILENT_ENDINGS.has(reason)) {
      trace({ kind: 'skipped', sessionId: id, reason })
      return
    }
    pushCue(reason === 'completed' ? 'done' : 'failed', id, { running: false, reason })
  })

  const lastGreeting = new Map()

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: '/hdd/info',
        handler: async (_req, res) => {
          const inventory = await readInventory(root)
          json(res, 200, inventory)
        },
      }),
    'hdd-voice-info-route',
  )

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: '/hdd/asset',
        handler: async (req, res) => {
          const url = new URL(req.url || '/', 'http://127.0.0.1')
          const file = await resolveAssetFile(root, url.searchParams.get('path') || '')
          if (file === undefined) {
            res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
            res.end('asset not found')
            return
          }
          await streamFile(res, file, req.headers.range)
        },
      }),
    'hdd-voice-asset-route',
  )

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: '/hdd/greeting',
        handler: async (req, res) => {
          const url = new URL(req.url || '/', 'http://127.0.0.1')
          /* `Number(null)` is 0 and `Number.isFinite(0)` is true, so reading the
             hour straight from a missing parameter silently pinned every greeting
             to the 00:00 bucket. Prefer the bucket the client already resolved
             from the device clock; fall back to this process's clock only when
             neither is usable. */
          const requested = url.searchParams.get('bucket')
          const bucket = bucketById(requested) ?? bucketForHour(
            readHour(url.searchParams.get('hour')) ?? new Date().getHours(),
          )
          const inventory = await readInventory(root)
          const chosen = pickGreeting(
            inventory.greetings,
            bucket.id,
            lastGreeting.get(bucket.id),
          )
          if (chosen === undefined) {
            json(res, 200, { bucket: bucket.id, file: null, url: null, reason: 'no-clips' })
            return
          }
          lastGreeting.set(bucket.id, chosen.file)
          json(res, 200, {
            bucket: bucket.id,
            label: bucket.label,
            file: `greeting/${chosen.file}`,
            url: `/hdd/asset?path=${encodeURIComponent(`greeting/${chosen.file}`)}`,
            fallback: chosen.fallback,
          })
        },
      }),
    'hdd-voice-greeting-route',
  )

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: '/hdd/cue',
        handler: (req, res) => {
          const url = new URL(req.url || '/', 'http://127.0.0.1')
          const since = Number(url.searchParams.get('since'))
          const floor = Number.isFinite(since) ? since : 0
          json(res, 200, { seq: cueSeq, cues: cues.filter((cue) => cue.seq > floor) })
        },
      }),
    'hdd-voice-cue-route',
  )
}
