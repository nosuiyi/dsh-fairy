#!/usr/bin/env node
/**
 * Recover the build-hashed CSS class names the panel rules depend on.
 *
 * The shell writes its columns with CSS-module class names whose prefix is a build
 * hash (`an3WzG_root`). The hash changes between releases; the suffix does not,
 * because it comes from the module path. This walks every client bundle in the
 * installed asar, works out which prefix belongs to which suffix, and prints a
 * ready-to-paste `FALLBACK_PREFIXES` block for `lib/client.js`.
 *
 *   node tools/scan-skin-classes.mjs
 *   node tools/scan-skin-classes.mjs --asar "B:/deepseek harness/resources/app.asar"
 *
 * Exit codes: 0 every suffix found, 1 some missing (the skin still runs; the panel
 * texture for the missing columns is simply not emitted).
 */
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { basename } from 'node:path'

const SUFFIXES = ['frame', 'centerCol', 'rightbarCol', 'root', 'composerSeat', 'scrollBody', 'embeddedBody']

const argv = process.argv.slice(2)
const flag = (name, fallback) => {
  const index = argv.indexOf(`--${name}`)
  return index === -1 ? fallback : argv[index + 1]
}

/** Where the desktop shell keeps its asar, most specific first. */
const CANDIDATES = [
  'B:/deepseek harness/resources/app.asar',
  'C:/Program Files/DeepSeek Harness/resources/app.asar',
  `${process.env.LOCALAPPDATA ?? ''}/Programs/DeepSeek Harness/resources/app.asar`,
]

const asarPath = String(flag('asar', '') || '')
  || CANDIDATES.find((candidate) => candidate !== '' && existsSync(candidate))

if (asarPath === undefined || asarPath === '' || !existsSync(asarPath)) {
  console.error('cannot find app.asar — pass --asar "<path to resources/app.asar>"')
  process.exit(2)
}

/* ------------------------------------------------------------------- asar */

const buffer = await readFile(asarPath)
/* Offsets 0-3 are the size of the size pickle; 8 holds the header pickle size and
   12 the header string size, with the JSON itself starting at 16. */
const headerSize = buffer.readUInt32LE(8)
const stringSize = buffer.readUInt32LE(12)
const header = JSON.parse(buffer.subarray(16, 16 + stringSize).toString('utf8'))
const dataStart = 8 + headerSize

/** Every client-bundle entry (lib/client.js) inside @deepseek-ai packages. */
function clientBundles() {
  const out = []
  const walk = (node, prefix) => {
    for (const [name, value] of Object.entries(node.files ?? {})) {
      const path = `${prefix}/${name}`
      if (value.files !== undefined) {
        walk(value, path)
        continue
      }
      if (!/\/@deepseek-ai\/[^/]+\/lib\/client\.js$/.test(path)) continue
      const offset = dataStart + Number(value.offset)
      out.push({ path, bytes: buffer.subarray(offset, offset + Number(value.size)) })
    }
  }
  walk({ files: header.files }, '')
  return out
}

/* --------------------------------------------------------------- analysis */

const bundles = clientBundles()
const pattern = new RegExp(`\\.([A-Za-z0-9-]{4,10})_(${SUFFIXES.join('|')})\\b`, 'g')

/* prefix → which suffixes it was seen with, and how often. */
const seen = new Map()
for (const bundle of bundles) {
  const text = bundle.bytes.toString('utf8')
  for (const match of text.matchAll(pattern)) {
    const key = match[1]
    if (!seen.has(key)) seen.set(key, { suffixes: new Set(), count: 0 })
    seen.get(key).suffixes.add(match[2])
    seen.get(key).count += 1
  }
}

/* Pick, per suffix, the prefix that co-occurs with the most of our suffixes —
   several modules reuse `_root`, but only the shell's conversation module also
   carries composerSeat/scrollBody/embeddedBody. */
const chosen = new Map()
for (const suffix of SUFFIXES) {
  const candidates = [...seen.entries()]
    .filter(([, value]) => value.suffixes.has(suffix))
    .sort((left, right) => (
      right[1].suffixes.size - left[1].suffixes.size
      || right[1].count - left[1].count
      || left[0].localeCompare(right[0])
    ))
  if (candidates.length > 0) chosen.set(suffix, candidates[0][0])
}

console.log(`asar    : ${asarPath}`)
console.log(`bundles : ${bundles.length} scanned`)
console.log('')
for (const suffix of SUFFIXES) {
  const prefix = chosen.get(suffix)
  const others = prefix === undefined
    ? ''
    : `   (also seen: ${[...seen.entries()].filter(([k, v]) => k !== prefix && v.suffixes.has(suffix)).map(([k]) => k).slice(0, 4).join(', ') || 'none'})`
  console.log(`${suffix.padEnd(14)} ${prefix ?? '—'}${others}`)
}

const missing = SUFFIXES.filter((suffix) => !chosen.has(suffix))

const byPrefix = new Map()
for (const [suffix, prefix] of chosen) {
  if (!byPrefix.has(prefix)) byPrefix.set(prefix, [])
  byPrefix.get(prefix).push(suffix)
}

console.log('')
console.log('Paste into lib/client.js (FALLBACK_PREFIXES):')
console.log('')
console.log('    const FALLBACK_PREFIXES = {')
for (const [prefix, suffixes] of byPrefix) {
  console.log(`      '${prefix}': [${suffixes.map((suffix) => `'${suffix}'`).join(', ')}],`)
}
console.log('    }')
console.log('')

if (missing.length > 0) {
  console.error(`missing suffixes: ${missing.join(', ')} — the shell may have renamed them`)
  process.exitCode = 1
}
