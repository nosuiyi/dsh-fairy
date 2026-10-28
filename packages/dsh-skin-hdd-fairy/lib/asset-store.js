/**
 * Asset convention for the HDD greeting: where files live, what may be served,
 * and which greeting belongs to the current hour.
 *
 * The package ships no media, so everything here is derived from a directory the
 * user fills in. Nothing in this module reads a machine-specific absolute path
 * from the package itself: the root comes from `DSH_HDD_ASSETS`, else from
 * `$DSH_HOME/hdd-fairy/assets`.
 */
import { readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { extname, join, resolve, sep } from 'node:path'

/** Media types the routes will serve, keyed by the lowercase extension with its dot. */
export const MEDIA_TYPES = new Map([
  ['.m4a', 'audio/mp4'],
  ['.mp3', 'audio/mpeg'],
  ['.ogg', 'audio/ogg'],
  ['.opus', 'audio/ogg'],
  ['.wav', 'audio/wav'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
  ['.svg', 'image/svg+xml'],
  ['.mp4', 'video/mp4'],
  ['.webm', 'video/webm'],
])

/** Extensions accepted for a greeting or cue clip. */
const CLIP_EXTENSIONS = new Set(['.m4a', '.mp3', '.ogg', '.opus', '.wav'])

/** Extensions accepted for the launch backdrop, in preference order. */
const BACKDROP_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp']

/** Extensions accepted for the launch animation, in preference order. */
const VIDEO_EXTENSIONS = ['.mp4', '.webm']

/**
 * Time-of-day buckets. Boundaries are half-open `[from, to)` on the local hour,
 * so every hour belongs to exactly one bucket and the last one closes the day.
 */
export const BUCKETS = Object.freeze([
  Object.freeze({ id: 'dawn', from: 0, to: 5, label: '深夜' }),
  Object.freeze({ id: 'morning', from: 5, to: 11, label: '早上' }),
  Object.freeze({ id: 'noon', from: 11, to: 14, label: '中午' }),
  Object.freeze({ id: 'afternoon', from: 14, to: 18, label: '下午' }),
  Object.freeze({ id: 'evening', from: 18, to: 22, label: '晚上' }),
  Object.freeze({ id: 'night', from: 22, to: 24, label: '深夜' }),
])

/** Cue kinds the shell may play, and the file stem each expects under `cue/`. */
export const CUE_KINDS = Object.freeze(['thinking', 'done', 'failed'])

/**
 * The asset root for this machine.
 * @param environment - process environment, injected for tests.
 * @param home - user home directory, injected for tests.
 * @returns absolute asset directory.
 */
export function resolveAssetRoot(environment = process.env, home = homedir()) {
  const explicit = environment.DSH_HDD_ASSETS
  if (typeof explicit === 'string' && explicit.trim() !== '') return resolve(explicit)
  const dshHome = environment.DSH_HOME || join(environment.USERPROFILE || home, '.dsh')
  return resolve(join(dshHome, 'hdd-fairy', 'assets'))
}

/**
 * Resolve a bucket by its id.
 * @param id - candidate id from a request; anything unknown is rejected.
 * @returns the bucket entry, or undefined.
 */
export function bucketById(id) {
  if (typeof id !== 'string') return undefined
  return BUCKETS.find((bucket) => bucket.id === id)
}

/**
 * Parse an optional `hour` query parameter.
 *
 * `Number(null)` is `0`, which is finite — reading the parameter without this
 * guard turns "absent" into "midnight" and pins the greeting to one bucket.
 * @param raw - the parameter as the request carried it.
 * @returns 0–23, or undefined when absent or unusable.
 */
export function readHour(raw) {
  if (raw === null || raw.trim() === '') return undefined
  const value = Number(raw)
  return Number.isFinite(value) ? value : undefined
}

/**
 * The bucket one local hour belongs to.
 * @param hour - 0–23; values outside the range are clamped into the day.
 * @returns the matching bucket entry.
 */
export function bucketForHour(hour) {
  const clamped = Number.isFinite(hour) ? Math.min(23, Math.max(0, Math.trunc(hour))) : 0
  return BUCKETS.find((bucket) => clamped >= bucket.from && clamped < bucket.to) ?? BUCKETS[0]
}

/** Whether a path segment list tries to leave the root. */
function escapesRoot(relativePath) {
  if (relativePath === '' || relativePath.includes('\0')) return true
  if (relativePath.startsWith('/') || relativePath.startsWith('\\')) return true
  if (/^[a-zA-Z]:/.test(relativePath)) return true
  return relativePath.split(/[/\\]/).some((segment) => segment === '..')
}

/**
 * Resolve one client-supplied relative path inside the asset root.
 * @param root - absolute asset root.
 * @param relativePath - path as the client sent it, always `/`-separated.
 * @returns `{ absolute, relative, mediaType }`, or undefined when the path
 *   escapes the root, has no supported extension, or does not exist.
 */
export async function resolveAssetFile(root, relativePath) {
  if (typeof relativePath !== 'string' || escapesRoot(relativePath)) return undefined
  const normalised = relativePath.split('/').filter(Boolean).join(sep)
  const absolute = resolve(root, normalised)
  if (absolute !== root && !absolute.startsWith(root + sep)) return undefined
  const mediaType = MEDIA_TYPES.get(extname(absolute).toLowerCase())
  if (mediaType === undefined) return undefined
  const info = await stat(absolute).catch(() => undefined)
  if (info === undefined || !info.isFile()) return undefined
  return {
    absolute,
    relative: relativePath.split('/').filter(Boolean).join('/'),
    mediaType,
    size: info.size,
  }
}

/** Sorted clip files in one directory, filtered by extension. */
async function clipsIn(directory) {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
  return entries
    .filter((entry) => entry.isFile() && CLIP_EXTENSIONS.has(extname(entry.name).toLowerCase()))
    .map((entry) => entry.name)
    .sort()
}

/**
 * Group greeting clips by bucket.
 *
 * Two layouts are accepted, and they combine:
 *
 *   greeting/morning/x.m4a     one folder per bucket — drop a file in, nothing to rename
 *   greeting/morning-1.m4a     flat files, recognised by their name prefix (legacy)
 *
 * Entries are returned as paths relative to `greeting/` so a subfolder clip keeps its
 * folder in the `/hdd/asset` URL.
 *
 * @param directory - the `greeting/` directory.
 * @returns one sorted file list per bucket id, empty when a bucket has none.
 */
export async function readGreetings(directory) {
  const flat = await clipsIn(directory)
  const greetings = {}
  for (const bucket of BUCKETS) {
    const fromFolder = await clipsIn(join(directory, bucket.id))
    const legacy = flat.filter((name) => {
      const stem = name.slice(0, name.length - extname(name).length)
      return stem === bucket.id || stem.startsWith(`${bucket.id}-`)
    })
    greetings[bucket.id] = [
      ...fromFolder.map((name) => `${bucket.id}/${name}`),
      ...legacy,
    ].sort()
  }
  return greetings
}

/**
 * Read the cue clips.
 * @param directory - the `cue/` directory.
 * @returns `{ thinking, done, failed }`, each a file name or null.
 */
export async function readCues(directory) {
  const files = await clipsIn(directory)
  const cues = {}
  for (const kind of CUE_KINDS) {
    const match = files.find((name) => name.slice(0, name.length - extname(name).length) === kind)
    cues[kind] = match ?? null
  }
  return cues
}

/**
 * Find the launch backdrop in the asset root.
 * @param root - absolute asset root.
 * @returns the relative file name, or null when the user supplied none.
 */
export async function readBackdrop(root) {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => [])
  for (const extension of BACKDROP_EXTENSIONS) {
    const match = entries.find(
      (entry) => entry.isFile() && entry.name.slice(0, entry.name.length - extname(entry.name).length) === 'boot'
        && extname(entry.name).toLowerCase() === extension,
    )
    if (match !== undefined) return match.name
  }
  return null
}

/**
 * Find the drawn highlight plate shown after the animation is cut.
 * @param root - absolute asset root.
 * @returns the relative file name, or null.
 */
export async function readField(root) {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => [])
  for (const extension of BACKDROP_EXTENSIONS) {
    const match = entries.find(
      (entry) => entry.isFile() && entry.name.slice(0, entry.name.length - extname(entry.name).length) === 'boot-field'
        && extname(entry.name).toLowerCase() === extension,
    )
    if (match !== undefined) return match.name
  }
  return null
}

/**
 * Find the launch animation in the asset root.
 *
 * The clip is user-supplied and never shipped, so its presence decides the splash
 * shape: with a clip the splash plays it and then places the emblem over its last
 * frame; without one it fades in the still backdrop instead.
 * @param root - absolute asset root.
 * @returns the relative file name, or null.
 */
export async function readVideo(root) {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => [])
  for (const extension of VIDEO_EXTENSIONS) {
    const match = entries.find(
      (entry) => entry.isFile() && entry.name.slice(0, entry.name.length - extname(entry.name).length) === 'boot'
        && extname(entry.name).toLowerCase() === extension,
    )
    if (match !== undefined) return match.name
  }
  return null
}

/**
 * Inventory the asset root for the client.
 * @param root - absolute asset root.
 * @returns everything the client needs to decide what it can show and play.
 */
export async function readInventory(root) {
  const info = await stat(root).catch(() => undefined)
  const exists = info !== undefined && info.isDirectory()
  const greetings = exists ? await readGreetings(join(root, 'greeting')) : {}
  const cues = exists ? await readCues(join(root, 'cue')) : { thinking: null, done: null, failed: null }
  const backdrop = exists ? await readBackdrop(root) : null
  const video = exists ? await readVideo(root) : null
  const field = exists ? await readField(root) : null
  return {
    root,
    exists,
    backdrop,
    video,
    field,
    greetings,
    cues,
    buckets: BUCKETS.map((bucket) => ({
      id: bucket.id,
      label: bucket.label,
      from: bucket.from,
      to: bucket.to,
      count: (greetings[bucket.id] ?? []).length,
    })),
  }
}

/**
 * Choose one greeting for a bucket.
 *
 * Falls back to any bucket that has clips when the requested one is empty, so a
 * user who only recorded "morning" still hears something at noon. Avoids
 * repeating the previous pick when the pool has more than one clip.
 * @param greetings - inventory as {@link readGreetings} returns it.
 * @param bucketId - bucket whose clips are preferred.
 * @param previous - file name played last time, if known.
 * @param random - number source in [0, 1), injected for tests.
 * @returns `{ bucket, file, fallback }`, or undefined when nothing is available.
 */
export function pickGreeting(greetings, bucketId, previous, random = Math.random) {
  const preferred = greetings[bucketId] ?? []
  const pool = preferred.length > 0
    ? preferred
    : BUCKETS.flatMap((bucket) => greetings[bucket.id] ?? [])
  if (pool.length === 0) return undefined
  const candidates = pool.length > 1 && previous !== undefined ? pool.filter((name) => name !== previous) : pool
  const chosen = candidates[Math.min(candidates.length - 1, Math.floor(random() * candidates.length))]
  return {
    bucket: preferred.length > 0 ? bucketId : 'any',
    file: chosen,
    fallback: preferred.length === 0,
  }
}
