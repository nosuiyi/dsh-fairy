#!/usr/bin/env node
/**
 * Generate the greeting/cue audio from a line table.
 *
 *   node tools/render-voice.mjs --backend edge   [--voice zh-CN-XiaoxiaoNeural]
 *   node tools/render-voice.mjs --backend sovits [--speed 1.0] [--gap 0.22]
 *   node tools/render-voice.mjs --only dawn-2,noon-2 --dry-run
 *
 * Two backends, one output contract: an `.m4a` per line at the path the table's
 * `file` field names, 48 kHz mono 48 kbps, fixed tail silence.
 *
 * ── Why the `‖` marker exists ──────────────────────────────────────────────
 * Punctuation does not reliably produce a pause. `dawn-2` written as
 * 「主人，全城数据活跃度此刻仅剩百分之十二点四。」 came back with no silence
 * after 主人 at all; rewriting it with a full stop did not help either. The only
 * dependable way to force a break is to synthesise the pieces separately and join
 * them with a fixed gap, so the table marks those boundaries with `‖` and this
 * script does the joining. Example:
 *
 *   主人‖全城数据活跃度，此刻仅剩百分之十二点四。
 */
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

/* ---------------------------------------------------------------- arguments */

const argv = process.argv.slice(2)
const flag = (name, fallback) => {
  const index = argv.indexOf(`--${name}`)
  if (index === -1) return fallback
  const value = argv[index + 1]
  return value === undefined || value.startsWith('--') ? true : value
}
const has = (name) => argv.includes(`--${name}`)

const backend = flag('backend', 'edge')
const dryRun = has('dry-run')
const keepRaw = has('keep-raw')
const only = String(flag('only', '') || '')
  .split(',')
  .map((item) => item.trim())
  .filter(Boolean)

const dshHome = process.env.DSH_HOME || join(process.env.USERPROFILE || homedir(), '.dsh')
const outRoot = resolve(String(flag('out', join(dshHome, 'hdd-fairy', 'assets'))))
const tablePath = resolve(String(flag('table', 'docs/voice-lines.final.json')))

/* Edge-TTS options. */
const edgeVoice = String(flag('voice', 'zh-CN-XiaoxiaoNeural'))
const edgeRate = String(flag('rate', '+0%'))
const edgePitch = String(flag('pitch', '+0Hz'))

/* GPT-SoVITS options. The reference clip must be an ASCII path: libsndfile cannot
   open non-ASCII names on Windows, which is why refs/fairy_ref.wav exists. */
const sovitsUrl = String(flag('url', 'http://127.0.0.1:9880/tts'))
const sovitsRef = flag('ref', process.env.DSH_SOVITS_REF
  || 'B:/WND/study/Github/GPT-SoVITS/refs/fairy_ref.wav')
const sovitsPrompt = flag('prompt', process.env.DSH_SOVITS_PROMPT
  || '了解我会如同主人使唤我一般使唤它，并且让它不敢有怨言。')
const sovitsSpeed = String(flag('speed', '1.0'))

/** Forced-break marker; see the header comment. */
const BREAK_MARK = '\u2016'
/** Silence inserted wherever the marker appears, in seconds.
 *  0.30 was chosen by ear: at 0.22 「人」 still felt clipped, at 0.30 the syllable
 *  lands in full without the pause reading as a gap in the sentence. */
const BREAK_GAP = String(flag('gap', '0.30'))
/** Trailing silence appended to every clip, in seconds. */
const TAIL_SILENCE = String(flag('tail', '0.2'))
/** Trailing silence for cues: short, because a cue must not linger. */
const CUE_TAIL_SILENCE = '0.05'

/** Strip the silence Edge-TTS and GPT-SoVITS put around short utterances. */
const TRIM_SILENCE = [
  'silenceremove=start_periods=1:start_duration=0:start_threshold=-45dB:detection=peak',
  'areverse',
  'silenceremove=start_periods=1:start_duration=0:start_threshold=-45dB:detection=peak',
  'areverse',
].join(',')

/* ------------------------------------------------------------------ helpers */

const log = (...parts) => console.log(...parts)

async function ensureDir(path) {
  await mkdir(path, { recursive: true })
}

/** Duration of one media file in seconds, via ffprobe. */
async function duration(file) {
  const { stdout } = await run('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=nw=1:nk=1',
    file,
  ])
  const value = Number.parseFloat(stdout.trim())
  return Number.isFinite(value) ? value : 0
}

/**
 * Re-encode any generated file to the shipping format.
 * @param options.trim - strip leading/trailing silence first (cues always do).
 * @param options.tail - silence appended after the speech, in seconds.
 */
async function encode(source, target, options) {
  await ensureDir(join(target, '..'))
  const filters = []
  if (options.trim) filters.push(TRIM_SILENCE)
  filters.push(`apad=pad_dur=${options.tail}`)
  const args = [
    '-v', 'error', '-y',
    '-i', source,
    '-af', filters.join(','),
    '-ac', '1', '-ar', '48000',
    '-c:a', 'aac', '-b:a', '48k',
    target,
  ]
  if (dryRun) {
    log(`  ffmpeg ${args.join(' ')}`)
    return
  }
  await run('ffmpeg', args)
}

/**
 * Split a line at its forced-break markers.
 *
 * Trailing punctuation is stripped from every part except the last. A segment
 * ending in 「，」 tells the model that more words follow, so it under-articulates
 * the final syllable — 「主人，」 came back with a clipped 「人」 even though the
 * pause after it is inserted by us. A bare 「主人」 is read as a finished phrase
 * and the syllable lands in full; the pause is the gap we splice in.
 */
function segments(text) {
  const parts = String(text)
    .split(BREAK_MARK)
    .map((part) => part.trim())
    .filter((part) => part !== '')
  return parts.map((part, position) => (
    position === parts.length - 1 ? part : part.replace(/[，。、；：,.;:]+$/u, '')
  ))
}

/**
 * Join separately synthesised parts with a fixed gap.
 * Each part is silence-trimmed first, so the gap is exactly {@link BREAK_GAP}
 * rather than "gap plus whatever padding the engine left behind".
 */
async function joinSegments(parts, workDir, index) {
  const trimmed = []
  for (const [position, part] of parts.entries()) {
    const out = join(workDir, `${index}-t${position}.wav`)
    await run('ffmpeg', [
      '-v', 'error', '-y', '-i', part,
      '-af', TRIM_SILENCE,
      '-ac', '1', '-ar', '48000',
      out,
    ])
    trimmed.push(out)
  }
  const gap = join(workDir, `${index}-gap.wav`)
  await run('ffmpeg', [
    '-v', 'error', '-y', '-f', 'lavfi',
    '-i', `anullsrc=r=48000:cl=mono:d=${BREAK_GAP}`,
    gap,
  ])
  const list = join(workDir, `${index}-list.txt`)
  const files = []
  for (const [position, file] of trimmed.entries()) {
    files.push(file)
    if (position < trimmed.length - 1) files.push(gap)
  }
  await writeFile(list, files.map((file) => `file '${file.split('\\').join('/')}'`).join('\n') + '\n', 'utf8')
  const joined = join(workDir, `${index}-joined.wav`)
  await run('ffmpeg', ['-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', joined])
  return joined
}

/* ----------------------------------------------------------------- backends */

/** Synthesise one Edge-TTS clip (per segment) and return the joined file. */
async function renderEdge(text, target, workDir, index, entry) {
  const parts = segments(text)
  const produced = []
  for (const [position, part] of parts.entries()) {
    const mp3 = join(workDir, `${index}-${position}.mp3`)
    const wav = join(workDir, `${index}-${position}.wav`)
    const args = ['-m', 'edge_tts', '--text', part, '--voice', edgeVoice, '--rate', edgeRate, '--pitch', edgePitch, '--write-media', mp3]
    if (dryRun) {
      log(`  python ${args.map((piece) => (piece.includes(' ') ? JSON.stringify(piece) : piece)).join(' ')}`)
      produced.push(wav)
      continue
    }
    await run('python', args)
    await run('ffmpeg', ['-v', 'error', '-y', '-i', mp3, '-ac', '1', '-ar', '48000', wav])
    produced.push(wav)
  }
  if (dryRun) return produced[0]
  const raw = parts.length > 1 ? await joinSegments(produced, workDir, index) : produced[0]
  const isCue = entry.file.startsWith('cue/')
  await encode(raw, target, { trim: isCue, tail: isCue ? CUE_TAIL_SILENCE : TAIL_SILENCE })
  return raw
}

/**
 * Synthesise one GPT-SoVITS clip (per segment) and return the joined file.
 *
 * `cut0` keeps each segment whole on purpose: clause-splitting inside a segment
 * changes the timbre, which the earlier project measured at a log-spectral
 * distance of 1.98. Segments are only split where the table asks for a break.
 */
async function renderSovits(text, target, workDir, index, entry) {
  const parts = segments(text)
  const produced = []
  for (const [position, part] of parts.entries()) {
    const body = {
      text: part,
      text_lang: 'zh',
      ref_audio_path: String(sovitsRef),
      prompt_text: String(sovitsPrompt),
      prompt_lang: 'zh',
      text_split_method: 'cut0',
      batch_size: 1,
      speed_factor: Number(sovitsSpeed),
      media_type: 'wav',
      streaming_mode: false,
    }
    const wav = join(workDir, `${index}-${position}.wav`)
    if (dryRun) {
      log(`  POST ${sovitsUrl} ${JSON.stringify(body).slice(0, 140)}…`)
      produced.push(wav)
      continue
    }
    const response = await fetch(sovitsUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!response.ok) {
      throw new Error(`tts ${response.status}: ${(await response.text()).slice(0, 200)}`)
    }
    await writeFile(wav, Buffer.from(await response.arrayBuffer()))
    produced.push(wav)
  }
  if (dryRun) return produced[0]
  const raw = parts.length > 1 ? await joinSegments(produced, workDir, index) : produced[0]
  const isCue = entry.file.startsWith('cue/')
  await encode(raw, target, { trim: isCue, tail: isCue ? CUE_TAIL_SILENCE : TAIL_SILENCE })
  return raw
}

/* --------------------------------------------------------------------- main */

const table = JSON.parse(await readFile(tablePath, 'utf8'))
const entries = [...(table.greeting ?? []), ...(table.cue ?? [])]

const wanted = entries.filter((entry) => {
  if (only.length === 0) return true
  const stem = entry.file.replace(/^.*\//, '').replace(/\.[^.]+$/, '')
  return only.includes(stem) || only.includes(entry.file)
})

if (wanted.length === 0) {
  console.error(`no entries matched --only ${only.join(',')}`)
  process.exit(2)
}

log(`backend : ${backend}`)
log(`table   : ${tablePath} (${entries.length} entries, ${wanted.length} selected)`)
log(`out     : ${outRoot}`)
if (backend === 'edge') log(`voice   : ${edgeVoice} rate ${edgeRate} pitch ${edgePitch}`)
else log(`engine  : ${sovitsUrl} speed ${sovitsSpeed}`)
log(`target  : m4a 48k mono 48kbps, +${TAIL_SILENCE}s tail, break gap ${BREAK_GAP}s${dryRun ? '  [DRY RUN]' : ''}`)
log('')

const workDir = await mkdtemp(join(tmpdir(), 'hdd-voice-'))
const rows = []
let failed = 0

try {
  for (const [index, entry] of wanted.entries()) {
    const target = join(outRoot, entry.file)
    process.stdout.write(`${entry.file.padEnd(30)} ${entry.text}\n`)
    try {
      const raw = backend === 'edge'
        ? await renderEdge(entry.text, target, workDir, index, entry)
        : await renderSovits(entry.text, target, workDir, index, entry)
      if (!dryRun) {
        const seconds = await duration(target)
        const size = (await stat(target)).size
        rows.push({ file: entry.file, seconds, size })
        log(`  → ${seconds.toFixed(2)}s  ${(size / 1024).toFixed(0)} KB`)
        if (keepRaw) {
          await ensureDir(join(outRoot, '_src'))
          await run('cp', [raw, join(outRoot, '_src', `${entry.file.replace(/^.*\//, '').replace(/\.[^.]+$/, '')}.wav`)])
        }
      }
    } catch (error) {
      failed += 1
      log(`  ✗ ${String(error && error.message ? error.message : error).slice(0, 300)}`)
    }
  }
} finally {
  await rm(workDir, { recursive: true, force: true })
}

if (rows.length > 0) {
  const total = rows.reduce((sum, row) => sum + row.seconds, 0)
  const longest = [...rows].sort((left, right) => right.seconds - left.seconds)[0]
  log('')
  log(`generated ${rows.length} clips, ${total.toFixed(1)}s total; longest ${longest.file} ${longest.seconds.toFixed(2)}s`)
  if (longest.seconds > 6) {
    log(`⚠ ${longest.file} is over the 6s splash budget — shorten the line or raise the rate`)
  }
}

if (failed > 0) {
  log(`\n${failed} clip(s) failed`)
  process.exitCode = 1
}
