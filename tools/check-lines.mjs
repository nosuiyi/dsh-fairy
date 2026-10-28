#!/usr/bin/env node
/**
 * Validate a greeting/cue line table before it becomes audio.
 *
 *   node tools/check-lines.mjs docs/voice-lines.json
 *
 * The rules below are the ones that actually bite: a line that names today's
 * schedule is a lie by tomorrow (the clip is static), three numbers in a row read
 * like a recitation, two protocol tags in one sentence sound like a robot reading
 * a form, and an emoji or an ellipsis makes the synthesiser stutter or read the
 * punctuation out loud.
 */
import { readFile } from 'node:fs/promises'

/** Characters that carry no speech and therefore do not count toward length. */
const SILENT = new Set([...'，。、；：！？—…「」『』（）《》""‘’ \n\t'])

/** Protocol openers Fairy is allowed to start a line with. */
const TAGS = ['提示', '警告', '推测', '检测到', '查询完成', '分析显示', '提议', '收到', '很抱歉', '肯定', '否定']

/** Numeric expressions that count as "one number": ASCII digits, 百分之…, and X点Y in Chinese. */
const NUMBER = /\d+(?:\.\d+)?|百分之[零一二三四五六七八九十百千点]+|[零一二三四五六七八九十]+点[零一二三四五六七八九十]+/g

const GREETING_MIN = 12
const GREETING_MAX = 28
const CUE_MIN = 2
const CUE_MAX = 10
const CHARS_PER_SECOND = 4.6

const clean = (text) => text.split('‖').join('')
const printed = (text) => [...clean(text)].filter((character) => !SILENT.has(character)).length
const estimate = (text) => Math.max(0.9, Math.round((printed(text) / CHARS_PER_SECOND + 0.35) * 10) / 10)

const problems = []

const check = (entry, kind, index) => {
  const { file, text } = entry
  const count = printed(text)
  const where = `${kind}[${index}] ${file}`
  const min = kind === 'cue' ? CUE_MIN : GREETING_MIN
  const max = kind === 'cue' ? CUE_MAX : GREETING_MAX
  if (typeof file !== 'string' || !file.startsWith(kind === 'cue' ? 'cue/' : 'greeting/')) {
    problems.push(`${where}: file must live under ${kind === 'cue' ? 'cue/' : 'greeting/'}`)
  }
  if (count < min || count > max) problems.push(`${where}: ${count} characters, expected ${min}–${max}`)
  const tags = TAGS.filter((tag) => text.includes(tag))
  if (tags.length > 1) problems.push(`${where}: ${tags.length} protocol tags (${tags.join('/')}) — at most one`)
  const numbers = text.match(NUMBER) ?? []
  if (numbers.length > 1) problems.push(`${where}: ${numbers.length} numbers (${numbers.join('/')}) — at most one`)
  if (/[（）()【】《》[\]{}*_~`#]/.test(text)) problems.push(`${where}: bracketed markup or markup characters`)
  if (/…|\.\.\./.test(text)) problems.push(`${where}: ellipsis — reads as a pause or as dots`)
  if (/\p{Extended_Pictographic}/u.test(text)) problems.push(`${where}: emoji`)
  return { file, text, count, seconds: estimate(text) }
}

const table = JSON.parse(await readFile(process.argv[2] ?? 'docs/voice-lines.json', 'utf8'))
const greetings = (table.greeting ?? []).map((entry, index) => check(entry, 'greeting', index))
const cues = (table.cue ?? []).map((entry, index) => check(entry, 'cue', index))

if (greetings.length !== 18) problems.push(`expected 18 greetings (6 buckets × 3), found ${greetings.length}`)
if (cues.length < 2) problems.push(`expected at least 2 cues, found ${cues.length}`)

const seen = new Map()
for (const entry of [...greetings, ...cues]) {
  const previous = seen.get(entry.text)
  if (previous !== undefined) problems.push(`${entry.file}: duplicates ${previous}`)
  seen.set(entry.text, entry.file)
}

const buckets = ['dawn', 'morning', 'noon', 'afternoon', 'evening', 'night']
for (const bucket of buckets) {
  const count = greetings.filter((entry) => entry.file.startsWith(`greeting/${bucket}-`)).length
  if (count !== 3) problems.push(`bucket ${bucket}: ${count} lines, expected 3`)
}

const total = greetings.reduce((sum, entry) => sum + entry.seconds, 0)
const longest = [...greetings].sort((left, right) => right.seconds - left.seconds)[0]

for (const entry of [...greetings, ...cues]) {
  console.log(`${entry.seconds.toFixed(1)}s  ${String(entry.count).padStart(2)} 字  ${entry.file}`)
  console.log(`        ${entry.text}`)
}
console.log(`\n问候合计约 ${total.toFixed(1)} 秒；最长一条 ${longest.file} ${longest.seconds.toFixed(1)} 秒`)

if (longest.seconds > 6) {
  problems.push(`longest greeting is ${longest.seconds.toFixed(1)}s — keep every greeting at or under 6s`)
}

if (problems.length > 0) {
  console.error('\nFAIL')
  for (const problem of problems) console.error(' - ' + problem)
  process.exitCode = 1
} else {
  console.log('\nPASS')
}
