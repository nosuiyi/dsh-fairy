/**
 * Host half of `dsh-skin-hdd-fairy`.
 *
 * A skin is a client-only surface: the palette, the splash and the mark are all
 * renderer concerns. This half contributes exactly one thing — the diagnostics
 * route the client half reports to.
 *
 * Why it exists: a skipped splash and a broken skin look identical from outside.
 * The client posts each phase here and the lines land in `$DSH_HOME/hdd-visual.log`,
 * readable without DevTools. (The route kept its old path so existing logs and
 * habits still work.)
 *
 * There is deliberately no artwork route: the reference skins serve hashed `.webp`
 * files under `/skin-assets/<id>/`, but this skin ships no third-party art. The
 * launch clip, the backdrop and the voice clips are the user's own, served by this
 * module itself under `/hdd/*` (the media layer used to be a separate package).
 */
import { spawn } from 'node:child_process'
import { createReadStream } from 'node:fs'
import { appendFile, mkdir, readFile, readdir, stat, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, extname, isAbsolute, join, resolve } from 'node:path'
import {
  BUCKETS,
  bucketById,
  bucketForHour,
  pickGreeting,
  readHour,
  readInventory,
  resolveAssetFile,
  resolveAssetRoot,
} from './asset-store.js'

export const name = 'hdd-fairy-skin'
export const inject = ['webServer']

const LOG = join(
  process.env.DSH_HOME || join(process.env.USERPROFILE || homedir(), '.dsh'),
  'hdd-visual.log',
)

/**
 * The asset root. `asset-store.js` owns the convention (env override, DSH home
 * fallback); this module only needs a short name for it, so the two cannot drift.
 *
 * The media layer used to live in a separate bundle (`dsh-hdd-voice`), which the skin
 * then had to call over HTTP: an implicit dependency nobody declared. It is merged in
 * now — one package answers every route the client calls.
 */
const assetRoot = resolveAssetRoot

/** What may be imported, where it lands, and how large it may be. */
const ASSET_KINDS = {
  video: { dir: '', stem: 'boot', ext: ['.mp4', '.webm'], max: 96 * 1024 * 1024 },
  backdrop: { dir: '', stem: 'boot', ext: ['.png', '.jpg', '.jpeg', '.webp'], max: 16 * 1024 * 1024 },
  field: { dir: '', stem: 'field', ext: ['.png', '.jpg', '.jpeg', '.webp'], max: 16 * 1024 * 1024 },
  greeting: { dir: 'greeting', ext: ['.m4a', '.mp3', '.ogg', '.opus', '.wav'], max: 8 * 1024 * 1024 },
  cue: { dir: 'cue', ext: ['.m4a', '.mp3', '.ogg', '.opus', '.wav'], max: 4 * 1024 * 1024 },
}

const GREETING_BUCKETS = ['dawn', 'morning', 'noon', 'afternoon', 'evening', 'night']
const CUE_KINDS = ['thinking', 'done', 'failed']

/** A file-name stem that is safe on Windows and keeps the user's own name. */
function safeStem(name, extension) {
  const base = name.toLowerCase().endsWith(extension) ? name.slice(0, name.length - extension.length) : name
  const cleaned = base
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/^\.+/, '')
    /* Windows refuses a name ending in a dot or a space, and reserves a handful of
       device names outright; both failures look like "the write did nothing". */
    .replace(/[. ]+$/g, '')
    .trim()
  const guarded = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(cleaned) ? `_${cleaned}` : cleaned
  return guarded === '' ? 'clip' : guarded.slice(0, 60)
}

/**
 * A free file name in `dir` derived from the user's own name.
 *
 * Greeting clips keep their name (`早安.m4a`) instead of being renamed to
 * `<bucket>-<n>`: the folder already says which bucket they belong to, so renaming
 * would only destroy information the user cares about.
 */
async function uniqueName(dir, original, extension) {
  const stem = safeStem(original, extension)
  const taken = async (candidate) => stat(join(dir, candidate)).then(() => true, () => false)
  let candidate = `${stem}${extension}`
  let index = 2
  while (await taken(candidate)) {
    candidate = `${stem}-${index}${extension}`
    index += 1
    if (index > 999) break
  }
  return candidate
}

/**
 * Replace every same-stem sibling that shares this kind's extensions.
 *
 * The extension filter is not optional: the clip and the backdrop share the stem
 * `boot`, so an unfiltered sweep would delete `boot.png` when the user replaces the
 * video.
 */
async function dropSiblings(dir, stem, keepName, extensions) {
  let names = []
  try {
    names = await readdir(dir)
  } catch {
    return
  }
  for (const name of names) {
    if (name === keepName) continue
    const dot = name.lastIndexOf('.')
    if (dot <= 0) continue
    if (name.slice(0, dot) !== stem) continue
    if (!extensions.includes(name.slice(dot).toLowerCase())) continue
    await unlink(join(dir, name)).catch(() => {})
  }
}

/** Extensions the picker is willing to show, across every kind. */
const MEDIA_EXTENSIONS = ['.mp4', '.webm', '.png', '.jpg', '.jpeg', '.webp', '.m4a', '.mp3', '.ogg', '.opus', '.wav']

/**
 * Media files in one directory, names and sizes only.
 *
 * Deliberately narrow: only whitelisted media extensions are reported and no file
 * content is ever returned, so this route cannot be turned into a general file browser.
 */
async function listMedia(dir) {
  const entries = await readdir(dir, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    if (!entry.isFile()) continue
    if (!MEDIA_EXTENSIONS.includes(extname(entry.name).toLowerCase())) continue
    const info = await stat(join(dir, entry.name)).catch(() => null)
    files.push({ name: entry.name, size: info === null ? 0 : info.size })
    if (files.length >= 200) break
  }
  files.sort((left, right) => left.name.localeCompare(right.name))
  return files
}

/**
 * Where an asset of `kind` with `extension` lands, creating the directory.
 * Shared by the upload route and the adopt-from-path route so both obey the same
 * replace / add / overwrite rules.
 *
 * Greetings land in `greeting/<bucket>/` and keep the user's own file name; every
 * other kind keeps its fixed slot (`boot.<ext>`, `cue/<kind>.<ext>`).
 */
async function resolveTarget(kindName, extension, bucket, cue, original) {
  const spec = ASSET_KINDS[kindName]
  const base = join(assetRoot(), spec.dir)
  if (kindName === 'greeting') {
    const dir = join(base, bucket)
    await mkdir(dir, { recursive: true })
    return { dir, name: await uniqueName(dir, original, extension), spec }
  }
  await mkdir(base, { recursive: true })
  let name
  if (kindName === 'cue') {
    name = `${cue}${extension}`
  } else {
    name = `${spec.stem}${extension}`
    await dropSiblings(base, spec.stem, name, spec.ext)
  }
  return { dir: base, name, spec }
}

/** The asset-root-relative path to show the user after an import. */
function reportedFile(kindName, name, bucket) {
  const parts = [ASSET_KINDS[kindName].dir, kindName === 'greeting' ? bucket : '', name]
    .filter((part) => part !== '')
  return parts.join('/')
}

/** Collect a request body as bytes, refusing anything past `limit`. */
function readBytes(req, limit) {
  return new Promise((resolve) => {
    const chunks = []
    let size = 0
    let overflow = false
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        overflow = true
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(overflow ? null : Buffer.concat(chunks)))
    req.on('error', () => resolve(null))
  })
}

/**
 * Show a file (or a folder) in the OS file manager.
 *
 * Best effort by design: the route reports a failure to the panel and never throws
 * into the Host. `stdio: 'ignore'` + `detached` keeps the Host from owning the
 * Explorer process.
 */
function revealPath(target, isFile) {
  return new Promise((resolve) => {
    let command
    let args
    if (process.platform === 'win32') {
      command = 'explorer.exe'
      /* `/select,<path>` highlights the file instead of launching it. */
      args = isFile ? [`/select,${target}`] : [target]
    } else if (process.platform === 'darwin') {
      command = 'open'
      args = isFile ? ['-R', target] : [target]
    } else {
      command = 'xdg-open'
      args = [isFile ? dirname(target) : target]
    }
    let settled = false
    const done = (error) => {
      if (settled) return
      settled = true
      resolve(error === undefined
        ? { ok: true }
        : { ok: false, error: String(error.message ?? error).slice(0, 140) })
    }
    try {
      const child = spawn(command, args, { detached: true, stdio: 'ignore' })
      child.on('error', done)
      child.on('spawn', () => done())
      child.unref()
    } catch (error) {
      done(error)
    }
  })
}

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

function json(res, status, body) {
  const payload = Buffer.from(JSON.stringify(body), 'utf8')
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(payload.length),
    'cache-control': 'no-store',
  })
  res.end(payload)
}

/** Append one diagnostic line to the shared splash log. */
function note(line) {
  void appendFile(LOG, `${new Date().toISOString()} ${line}\n`, 'utf8').catch(() => {})
}

/** One-line, size-bounded error text for a log line or a JSON reply. */
function describe(error) {
  const message = error && error.message ? String(error.message) : String(error)
  return message.replace(/\s+/g, ' ').slice(0, 300)
}

/* ------------------------------------------------------------------ media layer
 *
 * Everything the client calls under `/hdd/*` that is not about importing files: the
 * inventory, the byte stream, the greeting pick and the cue feed. This used to live in
 * a separate bundle (`dsh-hdd-voice`), which made the skin work only when another
 * bundle happened to be enabled — the merge removes that implicit dependency.
 */

/** How many cue events are remembered for a client that polls late. */
const CUE_HISTORY = 64

/** Turn ends that are not a result: the user stopped it, or it was handed off. */
const SILENT_ENDINGS = new Set(['aborted', 'interrupted', 'forked'])

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

/**
 * The cue feed: one `thinking` when a run starts, one `done`/`failed` when it ends.
 *
 * Keyed on the agent's **run**, not on a turn: one user message is several turns in
 * DSH (one per model round trip), so a turn-keyed feed played the "done" cue once per
 * round trip. Both `agent/status` and `api-session/status` report the flip, at
 * different moments, so both feed one idempotent state machine.
 * See `docs/findings-2026-10-28-cue-signals.md`.
 */
function installCueFeed(ctx, root) {
  let cueSeq = 0
  const cues = []

  const pushCue = (kind, sessionId, detail) => {
    cueSeq += 1
    cues.push({ seq: cueSeq, kind, sessionId, at: Date.now() })
    if (cues.length > CUE_HISTORY) cues.splice(0, cues.length - CUE_HISTORY)
    note(`{"event":"cue","detail":${JSON.stringify({ kind, sessionId, ...detail })}}`)
  }

  /** sessionId → true when the session is delegated work that must stay silent. */
  const background = new Map()
  /** sessionId → whether that agent is running now, plus its last turn-end reason. */
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

  const handleStatus = (id, running, source) => {
    if (id === '') return
    if (background.get(id) === true) {
      note(`{"event":"cue","detail":${JSON.stringify({ kind: 'status-skip', id, running, source })}}`)
      return
    }
    const state = runs.get(id) ?? { running: false, reason: 'completed' }
    if (running) {
      /* A second `true` without an intervening `false` is not a new run. */
      if (state.running) return
      state.running = true
      runs.set(id, state)
      pushCue('thinking', id, { running: true, source })
      return
    }
    if (!state.running) return
    state.running = false
    const reason = state.reason ?? 'completed'
    state.reason = 'completed'
    runs.set(id, state)
    if (SILENT_ENDINGS.has(reason)) {
      note(`{"event":"cue","detail":${JSON.stringify({ kind: 'cue-skip', id, reason, source })}}`)
      return
    }
    pushCue(reason === 'completed' ? 'done' : 'failed', id, { running: false, reason, source })
  }

  ctx.on('api-session/added', (summary) => {
    if (summary === undefined || summary === null) return
    classify(String(summary.sessionId ?? ''), undefined, summary)
  })

  ctx.on('api-session/status', (sessionId, running) => {
    handleStatus(String(sessionId ?? ''), running === true, 'api-session')
  })

  /* `agent/status` carries the agent, whose session supplies both the id and the
     header the background check needs. */
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

  /* Turn ends are watched only for the *reason*: `running: false` alone cannot tell a
     finished run from a cancelled one. */
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

  const lastGreeting = new Map()

  serveRoute(ctx, '/hdd/info', 'hdd-skin info route', async (_req, res) => {
    json(res, 200, await readInventory(root))
  })

  serveRoute(ctx, '/hdd/asset', 'hdd-skin asset route', async (req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1')
    const file = await resolveAssetFile(root, url.searchParams.get('path') || '')
    if (file === undefined) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('asset not found')
      return
    }
    await streamFile(res, file, req.headers.range)
  })

  serveRoute(ctx, '/hdd/greeting', 'hdd-skin greeting route', async (req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1')
    /* `Number(null)` is 0 and `Number.isFinite(0)` is true, so reading the hour
       straight from a missing parameter silently pins every greeting to midnight. */
    const bucket = bucketById(url.searchParams.get('bucket')) ?? bucketForHour(
      readHour(url.searchParams.get('hour')) ?? new Date().getHours(),
    )
    const inventory = await readInventory(root)
    const chosen = pickGreeting(inventory.greetings, bucket.id, lastGreeting.get(bucket.id))
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
  })

  serveRoute(ctx, '/hdd/cue', 'hdd-skin cue route', (req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1')
    const since = Number(url.searchParams.get('since'))
    const floor = Number.isFinite(since) ? since : 0
    const pending = cues.filter((cue) => cue.seq > floor)
    /* A delivery line per polling document: "played twice" is either one client that
       delivered twice or two clients that each delivered once, and only the feed sees
       which. */
    if (pending.length > 0) {
      note(`{"event":"cue-deliver","detail":${JSON.stringify({
        client: url.searchParams.get('client') ?? '',
        seq: pending.map((cue) => cue.seq),
      })}}`)
    }
    json(res, 200, { seq: cueSeq, cues: pending })
  })
}

/**
 * Register an exact route, degrading to "no route" instead of "no skin".
 *
 * The same reason the report route has it: during the migration a stale bundle may
 * still own the path, and a duplicate must never take the whole skin down.
 */
function serveRoute(ctx, path, label, handler) {
  ctx.effect(() => {
    try {
      return ctx.webServer.register({ kind: 'exact', path, handler })
    } catch (error) {
      ctx.logger?.warn?.(`hdd-fairy-skin: ${path} unavailable (${describe(error)})`)
      return () => {}
    }
  }, label)
}

export function apply(ctx) {
  ctx.logger?.info?.(`hdd-fairy-skin: splash diagnostics go to ${LOG}`)

  const root = assetRoot()

  /* One folder per time-of-day bucket: the user drops a clip in the right folder and
     never has to rename anything. Created on every start, so a fresh install already
     shows the six folders instead of an empty `greeting/`. */
  for (const bucket of BUCKETS) {
    void mkdir(join(root, 'greeting', bucket.id), { recursive: true }).catch(() => {})
  }
  void mkdir(join(root, 'cue'), { recursive: true }).catch(() => {})

  /* The media layer: inventory, byte stream, greeting pick and the cue feed. */
  installCueFeed(ctx, root)

  /* A line here proves the Host half mounted, which separates "client never ran"
     from "client ran and skipped" when the log is read afterwards. */
  void mkdir(dirname(LOG), { recursive: true })
    .then(() => appendFile(LOG, `${new Date().toISOString()} {"event":"host-apply"}\n`, 'utf8'))
    .catch(() => {})

  ctx.effect(() => {
    try {
      return ctx.webServer.register({
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
      })
    } catch (error) {
      /* During the migration from `dsh-hdd-visual` both halves claim this exact
         path; a duplicate must degrade to "no diagnostics", never to "no skin". */
      ctx.logger?.warn?.(`hdd-fairy-skin: diagnostics route unavailable (${String(error).slice(0, 120)})`)
      return () => {}
    }
  }, 'hdd-skin-report-route')

  /**
   * Media import.
   *
   * The settings page opens a browser file picker (no native dialog needed), then
   * POSTs the bytes here and this route writes them into the asset directory. The
   * target name is built from `kind` + the request's extension, never from a path in
   * the request, so a crafted name cannot escape the asset root.
   */
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: '/hdd/import',
        handler: async (req, res) => {
          if (req.method !== 'POST') {
            res.writeHead(405, { allow: 'POST', 'cache-control': 'no-store' }).end()
            return
          }
          const url = new URL(req.url ?? '/', 'http://127.0.0.1')
          const kindName = url.searchParams.get('kind') ?? ''
          const spec = ASSET_KINDS[kindName]
          if (spec === undefined) {
            json(res, 400, { error: `unknown kind "${kindName}"` })
            return
          }
          const original = url.searchParams.get('name') ?? ''
          const extension = extname(original).toLowerCase()
          if (!spec.ext.includes(extension)) {
            json(res, 400, { error: `unsupported extension "${extension || '(none)'}" for ${kindName}` })
            return
          }
          const bytes = await readBytes(req, spec.max)
          if (bytes === null) {
            json(res, 413, { error: `file larger than ${Math.round(spec.max / 1024 / 1024)} MB` })
            return
          }
          if (bytes.length === 0) {
            json(res, 400, { error: 'empty body' })
            return
          }
          const bucket = url.searchParams.get('bucket') ?? ''
          if (kindName === 'greeting' && !GREETING_BUCKETS.includes(bucket)) {
            json(res, 400, { error: `unknown bucket "${bucket}"` })
            return
          }
          const cue = url.searchParams.get('cue') ?? ''
          if (kindName === 'cue' && !CUE_KINDS.includes(cue)) {
            json(res, 400, { error: `unknown cue "${cue}"` })
            return
          }
          try {
            const target = await resolveTarget(kindName, extension, bucket, cue, original)
            await writeFile(join(target.dir, target.name), bytes)
            note(JSON.stringify({
              event: 'import',
              kind: kindName,
              name: target.name,
              bytes: bytes.length,
              ok: true,
            }))
            json(res, 200, {
              file: reportedFile(kindName, target.name, bucket),
              bytes: bytes.length,
            })
          } catch (error) {
            /* A silent 500 here creates an empty folder and no file, which is
               indistinguishable from "the picker did nothing". Say why. */
            note(JSON.stringify({
              event: 'import',
              kind: kindName,
              name: original,
              bytes: bytes.length,
              ok: false,
              error: describe(error),
            }))
            json(res, 500, { error: `写入失败：${describe(error)}` })
          }
        },
      }),
    'hdd-skin-import-route',
  )

  /**
   * List the media files in one directory.
   *
   * The settings page uses this with a directory the user picked through the native
   * folder dialog, which is the only way to control where the picker starts — the
   * browser's own file dialog always reopens its last folder for the whole profile.
   */
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: '/hdd/list',
        handler: async (req, res) => {
          const url = new URL(req.url ?? '/', 'http://127.0.0.1')
          const dir = url.searchParams.get('dir') ?? ''
          if (dir === '' || !isAbsolute(dir)) {
            json(res, 400, { error: 'an absolute directory is required' })
            return
          }
          let files
          try {
            files = await listMedia(dir)
          } catch (error) {
            json(res, 400, { error: `cannot read ${dir}: ${String(error.code ?? error).slice(0, 80)}` })
            return
          }
          const parent = dirname(dir)
          json(res, 200, { dir, parent: parent === dir ? '' : parent, files })
        },
      }),
    'hdd-skin-list-route',
  )

  /**
   * Adopt a file that already sits on disk, by absolute directory + file name.
   *
   * Same target rules as the upload route; the point is that a 90 MB clip is copied
   * instead of being read into the page and posted back.
   */
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: '/hdd/adopt',
        handler: async (req, res) => {
          if (req.method !== 'POST') {
            res.writeHead(405, { allow: 'POST', 'cache-control': 'no-store' }).end()
            return
          }
          const url = new URL(req.url ?? '/', 'http://127.0.0.1')
          const kindName = url.searchParams.get('kind') ?? ''
          const spec = ASSET_KINDS[kindName]
          if (spec === undefined) {
            json(res, 400, { error: `unknown kind "${kindName}"` })
            return
          }
          const dir = url.searchParams.get('dir') ?? ''
          const name = url.searchParams.get('name') ?? ''
          if (dir === '' || !isAbsolute(dir) || name === '' || /[\\/]/.test(name)) {
            json(res, 400, { error: 'an absolute directory and a bare file name are required' })
            return
          }
          const extension = extname(name).toLowerCase()
          if (!spec.ext.includes(extension)) {
            json(res, 400, { error: `unsupported extension "${extension || '(none)'}" for ${kindName}` })
            return
          }
          const bucket = url.searchParams.get('bucket') ?? ''
          if (kindName === 'greeting' && !GREETING_BUCKETS.includes(bucket)) {
            json(res, 400, { error: `unknown bucket "${bucket}"` })
            return
          }
          const cue = url.searchParams.get('cue') ?? ''
          if (kindName === 'cue' && !CUE_KINDS.includes(cue)) {
            json(res, 400, { error: `unknown cue "${cue}"` })
            return
          }
          /* Adopting a file that already sits in the destination folder would silently
             create `x-2.m4a` next to `x.m4a`. That is never what the click means. */
          const destination = kindName === 'greeting'
            ? join(assetRoot(), spec.dir, bucket)
            : join(assetRoot(), spec.dir)
          if (resolve(dirname(join(dir, name))) === resolve(destination)) {
            json(res, 400, { error: '该文件已经在素材目录里了' })
            return
          }
          let bytes
          try {
            bytes = await readFile(join(dir, name))
          } catch (error) {
            json(res, 400, { error: `cannot read ${name}: ${String(error.code ?? error).slice(0, 80)}` })
            return
          }
          if (bytes.length > spec.max) {
            json(res, 413, { error: `file larger than ${Math.round(spec.max / 1024 / 1024)} MB` })
            return
          }
          try {
            const target = await resolveTarget(kindName, extension, bucket, cue, name)
            await writeFile(join(target.dir, target.name), bytes)
            note(JSON.stringify({
              event: 'adopt',
              kind: kindName,
              name: target.name,
              bytes: bytes.length,
              ok: true,
            }))
            json(res, 200, {
              file: reportedFile(kindName, target.name, bucket),
              bytes: bytes.length,
            })
          } catch (error) {
            note(JSON.stringify({
              event: 'adopt',
              kind: kindName,
              name,
              bytes: bytes.length,
              ok: false,
              error: describe(error),
            }))
            json(res, 500, { error: `写入失败：${describe(error)}` })
          }
        },
      }),
    'hdd-skin-adopt-route',
  )

  /**
   * Open one kind's asset folder in the OS file manager.
   *
   * The target comes from `kind` alone — never from the request — so this cannot be
   * turned into "open an arbitrary path". A single-file kind is selected in place
   * when it exists; the multi-file kinds (greeting, cue) just open their folder.
   */
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: '/hdd/reveal',
        handler: async (req, res) => {
          if (req.method !== 'POST') {
            res.writeHead(405, { allow: 'POST', 'cache-control': 'no-store' }).end()
            return
          }
          const url = new URL(req.url ?? '/', 'http://127.0.0.1')
          const kindName = url.searchParams.get('kind') ?? ''
          const spec = ASSET_KINDS[kindName]
          if (spec === undefined) {
            json(res, 400, { error: `unknown kind "${kindName}"` })
            return
          }
          /* Greetings live one folder per bucket, so "open folder" follows the bucket
             currently selected in the panel. */
          const bucketParam = url.searchParams.get('bucket') ?? ''
          const bucket = GREETING_BUCKETS.includes(bucketParam) ? bucketParam : GREETING_BUCKETS[1]
          const dir = kindName === 'greeting'
            ? join(assetRoot(), spec.dir, bucket)
            : join(assetRoot(), spec.dir)
          await mkdir(dir, { recursive: true })
          let target = dir
          let isFile = false
          if (kindName !== 'greeting' && kindName !== 'cue') {
            const names = await readdir(dir).catch(() => [])
            const current = names.find((name) => {
              const dot = name.lastIndexOf('.')
              if (dot <= 0) return false
              return name.slice(0, dot) === spec.stem && spec.ext.includes(name.slice(dot).toLowerCase())
            })
            if (current !== undefined) {
              target = join(dir, current)
              isFile = true
            }
          }
          const result = await revealPath(target, isFile)
          if (result.ok === false) {
            json(res, 500, { error: `cannot open ${target}: ${result.error}` })
            return
          }
          json(res, 200, { opened: target })
        },
      }),
    'hdd-skin-reveal-route',
  )
}
