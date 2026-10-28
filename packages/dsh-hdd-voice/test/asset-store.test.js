import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  bucketById,
  bucketForHour,
  readHour,
  pickGreeting,
  readCues,
  readGreetings,
  readInventory,
  resolveAssetFile,
  resolveAssetRoot,
} from '../lib/asset-store.js'

const withAssets = async (build) => {
  const root = await mkdtemp(join(tmpdir(), 'hdd-voice-'))
  try {
    await build(root)
    return root
  } catch (error) {
    await rm(root, { recursive: true, force: true })
    throw error
  }
}

test('DSH_HDD_ASSETS wins over the DSH home default', () => {
  assert.equal(
    resolveAssetRoot({ DSH_HDD_ASSETS: 'C:\\media' }, 'C:\\Users\\x'),
    'C:\\media',
  )
  assert.equal(
    resolveAssetRoot({ DSH_HOME: 'C:\\home\\dsh' }, 'C:\\Users\\x'),
    'C:\\home\\dsh\\hdd-fairy\\assets',
  )
  assert.equal(
    resolveAssetRoot({ USERPROFILE: 'C:\\Users\\x' }, 'C:\\Users\\x'),
    'C:\\Users\\x\\.dsh\\hdd-fairy\\assets',
  )
})

test('buckets cover every hour exactly once and clamp out-of-range input', () => {
  const seen = new Set()
  for (let hour = 0; hour < 24; hour += 1) seen.add(bucketForHour(hour).id)
  assert.deepEqual([...seen].sort(), ['afternoon', 'dawn', 'evening', 'morning', 'night', 'noon'])
  assert.equal(bucketForHour(4).id, 'dawn')
  assert.equal(bucketForHour(5).id, 'morning')
  assert.equal(bucketForHour(23).id, 'night')
  assert.equal(bucketForHour(-3).id, 'dawn')
  assert.equal(bucketForHour(99).id, 'night')
  assert.equal(bucketForHour(Number.NaN).id, 'dawn')
})

test('reads clips by bucket and cue kind', async () => {
  const root = await withAssets(async (dir) => {
    await mkdir(join(dir, 'greeting'), { recursive: true })
    await mkdir(join(dir, 'cue'), { recursive: true })
    for (const name of ['morning-1.m4a', 'morning-2.m4a', 'noon-1.m4a', 'notes.txt']) {
      await writeFile(join(dir, 'greeting', name), 'x')
    }
    for (const name of ['thinking.m4a', 'done.m4a']) {
      await writeFile(join(dir, 'cue', name), 'x')
    }
  })
  try {
    const greetings = await readGreetings(join(root, 'greeting'))
    assert.deepEqual(greetings.morning, ['morning-1.m4a', 'morning-2.m4a'])
    assert.deepEqual(greetings.noon, ['noon-1.m4a'])
    assert.deepEqual(greetings.afternoon, [])
    const cues = await readCues(join(root, 'cue'))
    assert.deepEqual(cues, { thinking: 'thinking.m4a', done: 'done.m4a', failed: null })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('one folder per bucket picks up any file name, and merges with the flat layout', async () => {
  const root = await withAssets(async (dir) => {
    await mkdir(join(dir, 'greeting', 'morning'), { recursive: true })
    await mkdir(join(dir, 'greeting', 'noon'), { recursive: true })
    for (const [folder, name] of [
      ['morning', '早安.m4a'],
      ['morning', 'second.mp3'],
      ['noon', '吃饭啦.m4a'],
    ]) {
      await writeFile(join(dir, 'greeting', folder, name), 'x')
    }
    await writeFile(join(dir, 'greeting', 'morning-legacy.m4a'), 'x')
  })
  try {
    const greetings = await readGreetings(join(root, 'greeting'))
    assert.deepEqual(greetings.morning, ['morning-legacy.m4a', 'morning/second.mp3', 'morning/早安.m4a'])
    assert.deepEqual(greetings.noon, ['noon/吃饭啦.m4a'])
    assert.deepEqual(greetings.night, [])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('inventory reports an absent directory without throwing', async () => {  const inventory = await readInventory(join(tmpdir(), 'hdd-voice-does-not-exist'))
  assert.equal(inventory.exists, false)
  assert.equal(inventory.backdrop, null)
  assert.equal(inventory.buckets.length, 6)
  assert.deepEqual(inventory.cues, { thinking: null, done: null, failed: null })
})

test('inventory finds a backdrop and reports bucket counts', async () => {
  const root = await withAssets(async (dir) => {
    await mkdir(join(dir, 'greeting'), { recursive: true })
    await writeFile(join(dir, 'boot.webp'), 'x')
    await writeFile(join(dir, 'greeting', 'evening-1.m4a'), 'x')
  })
  try {
    const inventory = await readInventory(root)
    assert.equal(inventory.exists, true)
    assert.equal(inventory.backdrop, 'boot.webp')
    assert.equal(inventory.buckets.find((bucket) => bucket.id === 'evening').count, 1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('pickGreeting prefers the bucket, falls back, and avoids repeating', () => {
  const greetings = { morning: ['a.m4a', 'b.m4a'], noon: [] }
  assert.equal(pickGreeting(greetings, 'morning', undefined, () => 0).file, 'a.m4a')
  assert.equal(pickGreeting(greetings, 'morning', 'a.m4a', () => 0).file, 'b.m4a')
  const fallback = pickGreeting(greetings, 'noon', undefined, () => 0)
  assert.equal(fallback.fallback, true)
  assert.equal(fallback.bucket, 'any')
  assert.equal(fallback.file, 'a.m4a')
  assert.equal(pickGreeting({ morning: [], noon: [] }, 'morning'), undefined)
})

test('resolveAssetFile refuses traversal, foreign extensions, and missing files', async () => {
  const root = await withAssets(async (dir) => {
    await mkdir(join(dir, 'greeting'), { recursive: true })
    await writeFile(join(dir, 'boot.png'), 'png')
    await writeFile(join(dir, 'greeting', 'morning-1.m4a'), 'm4a')
    await writeFile(join(dir, 'secret.txt'), 'txt')
  })
  try {
    const ok = await resolveAssetFile(root, 'greeting/morning-1.m4a')
    assert.equal(ok.relative, 'greeting/morning-1.m4a')
    assert.equal(ok.mediaType, 'audio/mp4')
    assert.equal(ok.size, 3)

    assert.equal(await resolveAssetFile(root, '../boot.png'), undefined)
    assert.equal(await resolveAssetFile(root, 'greeting/../../boot.png'), undefined)
    assert.equal(await resolveAssetFile(root, '/etc/passwd'), undefined)
    assert.equal(await resolveAssetFile(root, 'C:/Windows/win.ini'), undefined)
    assert.equal(await resolveAssetFile(root, 'secret.txt'), undefined)
    assert.equal(await resolveAssetFile(root, 'missing.png'), undefined)
    assert.equal(await resolveAssetFile(root, ''), undefined)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('bucketById rejects unknown ids and readHour does not turn absence into midnight', () => {
  assert.equal(bucketById('night')?.id, 'night')
  assert.equal(bucketById('nope'), undefined)
  assert.equal(bucketById(undefined), undefined)
  /* Number(null) is 0 and finite: the bug that pinned every greeting to dawn. */
  assert.equal(readHour(null), undefined)
  assert.equal(readHour(''), undefined)
  assert.equal(readHour('  '), undefined)
  assert.equal(readHour('9'), 9)
  assert.equal(readHour('abc'), undefined)
})
