/**
 * Load smoke test for the visual client half.
 *
 * The splash is mounted imperatively into `document.body`, so this stubs a body
 * that records children, a `<video>` that records listeners (the harness fires
 * `ended` itself), and timers that run inline. It then asserts the two things a
 * broken splash does: it stays mounted and eats clicks, or it leaves the
 * `data-hdd-splash` marker on <html> and hides the sidebar emblem forever.
 */
import { readFile } from 'node:fs/promises'

const failures = []
const notes = []

const timers = []
const intervals = []
const htmlAttrs = new Map()
let moduleRegistration

/* -------------------------------------------------------------------- stubs */

const element = (tag = 'div') => ({
  tag,
  innerHTML: '',
  textContent: '',
  className: '',
  style: {},
  dataset: {},
  attrs: {},
  listeners: {},
  children: [],
  clientWidth: 1920,
  clientHeight: 1080,
  width: 1920,
  height: 1080,
  muted: false,
  readyState: 4,
  videoWidth: 1920,
  videoHeight: 1080,
  currentTime: 1.2,
  paused: false,
  error: null,
  autoplay: false,
  playsInline: false,
  preload: 'auto',
  setAttribute(name, value) {
    this.attrs[name] = String(value)
  },
  removeAttribute(name) {
    delete this.attrs[name]
  },
  getAttribute(name) {
    return this.attrs[name] ?? null
  },
  appendChild(child) {
    this.children.push(child)
    child.parent = this
    return child
  },
  get firstChild() {
    return this.children[0] ?? null
  },
  insertBefore(child, reference) {
    const index = reference === null || reference === undefined
      ? this.children.length
      : this.children.indexOf(reference)
    this.children.splice(index < 0 ? this.children.length : index, 0, child)
    child.parent = this
    return child
  },
  remove() {
    if (this.parent !== undefined) {
      this.parent.children = this.parent.children.filter((node) => node !== this)
    }
  },
  addEventListener(type, handler) {
    if (this.listeners[type] === undefined) this.listeners[type] = []
    this.listeners[type].push(handler)
  },
  removeEventListener() {},
  getContext: () => ({
    drawImage: () => {},
    getImageData: () => ({ data: [12, 24, 38, 255] }),
  }),
  getBoundingClientRect: () => ({ left: 0, top: 0, width: 26, height: 26 }),
  offsetWidth: 26,
  play: () => Promise.resolve(),
  pause() {},
  load() {},
})

const body = element('body')
body.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1280, height: 820 })
body.clientWidth = 1280
body.clientHeight = 820
const created = []
const documentStub = {
  visibilityState: 'visible',
  body,
  documentElement: {
    ...element('html'),
    setAttribute: (name, value) => htmlAttrs.set(name, String(value)),
    removeAttribute: (name) => htmlAttrs.delete(name),
    hasAttribute: (name) => htmlAttrs.has(name),
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 1280, height: 820 }),
  },
  head: { appendChild() {} },
  createElement: (tag) => {
    const node = element(tag)
    created.push(node)
    return node
  },
  querySelector: (selector) => (selector === '[data-hdd-mark]' ? element('div') : null),
  addEventListener() {},
  removeEventListener() {},
}

const requests = []
const fetchStub = async (url) => {
  requests.push(String(url))
  const bodyValue = (() => {
    if (String(url).startsWith('/hdd/info')) {
      return {
        root: 'C:\\Users\\x\\.dsh\\hdd-fairy\\assets',
        exists: true,
        backdrop: 'boot.png',
        video: 'boot.mp4',
        greetings: { morning: ['morning-1.m4a'] },
        cues: { thinking: 'thinking.m4a', done: 'done.m4a', failed: null },
        buckets: [
          { id: 'dawn', label: '深夜', from: 0, to: 5, count: 0 },
          { id: 'morning', label: '早上', from: 5, to: 11, count: 1 },
          { id: 'noon', label: '中午', from: 11, to: 14, count: 0 },
          { id: 'afternoon', label: '下午', from: 14, to: 18, count: 0 },
          { id: 'evening', label: '晚上', from: 18, to: 22, count: 0 },
          { id: 'night', label: '深夜', from: 22, to: 24, count: 0 },
        ],
      }
    }
    if (String(url).startsWith('/hdd/greeting')) {
      return { bucket: 'morning', file: 'greeting/morning-1.m4a', url: '/hdd/asset?path=greeting%2Fmorning-1.m4a' }
    }
    if (String(url).startsWith('/hdd/cue')) return { seq: 2, cues: [{ seq: 2, kind: 'thinking' }] }
    return null
  })()
  return {
    ok: true,
    status: 200,
    json: async () => bodyValue,
    arrayBuffer: async () => new ArrayBuffer(4096),
  }
}

class AudioStub {
  constructor(src) {
    this.src = src
    this.volume = 1
    this.paused = true
  }

  play() {
    this.paused = false
    return Promise.resolve()
  }

  pause() {
    this.paused = true
  }

  addEventListener() {}
}

class AudioContextStub {
  constructor() {
    this.state = 'running'
    this.destination = {}
    this.currentTime = 0
  }

  decodeAudioData(_bytes, onDone) {
    onDone({ duration: 1.2 })
    return Promise.resolve({ duration: 1.2 })
  }

  createBufferSource() {
    return { buffer: null, connect() {}, start() {} }
  }

  resume() {
    return Promise.resolve()
  }

  close() {
    return Promise.resolve()
  }
}

/** Timers longer than this are recorded but not fired (the 30 s video cap). */
const INLINE_LIMIT_MS = 8000

const windowStub = {
  __ModuleLoader__: { load: (registration) => (moduleRegistration = registration) },
  performance: { now: () => 0 },
  setTimeout: (fn, ms) => {
    timers.push(ms)
    if (ms > INLINE_LIMIT_MS) return timers.length
    try {
      fn()
    } catch (error) {
      failures.push(`setTimeout(${ms}): ${error.stack}`)
    }
    return timers.length
  },
  clearTimeout: () => {},
  setInterval: (fn, ms) => {
    intervals.push(ms)
    return intervals.length
  },
  clearInterval: () => {},
  Audio: AudioStub,
  requestAnimationFrame: () => 0,
  cancelAnimationFrame: () => {},
}

globalThis.window = windowStub
globalThis.document = documentStub
globalThis.Audio = AudioStub
globalThis.AudioContext = AudioContextStub
globalThis.fetch = fetchStub
globalThis.Blob = Blob
globalThis.URL = URL
const navigatorStub = { userAgent: 'smoke', userActivation: { hasBeenActive: false } }

/* ------------------------------------------------------------------- module */

const source = await readFile(new URL('../client.js', import.meta.url), 'utf8')
try {
  new Function('window', 'document', 'navigator', 'fetch', 'Audio', 'AudioContext', 'Blob', 'URL', source)(
    windowStub,
    documentStub,
    navigatorStub,
    fetchStub,
    AudioStub,
    AudioContextStub,
    Blob,
    URL,
  )
} catch (error) {
  failures.push(`module body: ${error.stack}`)
}

if (!moduleRegistration) failures.push('client.js did not call window.__ModuleLoader__.load')
else if (moduleRegistration.id !== 'dsh-hdd-visual') failures.push(`unexpected module id: ${moduleRegistration.id}`)

const exportsObject = moduleRegistration
  ? moduleRegistration.factory((specifier) => {
      if (specifier === 'react') {
        return {
          createElement: (type, props, ...children) => ({ type, props, children }),
          useRef: (initial) => ({ current: initial }),
          useState: (initial) => [initial, () => {}],
          useEffect: (fn) => {
            const cleanup = fn()
            if (typeof cleanup === 'function') cleanup()
          },
        }
      }
      throw new Error(`unexpected require: ${specifier}`)
    })
  : undefined

const registered = []
if (exportsObject) {
  const ctx = {
    effect: (callback) => {
      const dispose = callback()
      return () => (typeof dispose === 'function' ? dispose() : undefined)
    },
    slots: {
      inject: (_name, callback) => callback(),
      register: (options, component) => {
        registered.push({ options, component })
        return () => {}
      },
    },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  }
  try {
    exportsObject.apply(ctx)
  } catch (error) {
    failures.push(`apply: ${error.stack}`)
  }
}

/* Splash mounted? It appends a node whose data-hdd-splash attribute is set. */
const allChildren = () => [...body.children, ...(documentStub.documentElement.children ?? [])]
const splashNode = () => allChildren().find((node) => node.attrs?.['data-hdd-splash'] === 'true')
notes.push(`splash mounted: ${splashNode() === undefined ? 'no' : 'yes'} (parent: ${documentStub.documentElement.children?.includes(splashNode()) ? 'html' : splashNode()?.parent === body ? 'body' : '?'})`)
if (splashNode() === undefined) failures.push('splash did not mount into document.body')

/* Let the inventory → greeting chain settle, then end the clip ourselves. */
await new Promise((resolve) => setTimeout(resolve, 30))
const detachedVideo = created.filter((node) => node.tag === 'video').pop()
const canvasNode = allChildren().flatMap((node) => node.children ?? []).find((node) => node.attrs?.['data-hdd-video-canvas'] === 'true')
notes.push(`video in DOM: ${allChildren().some((node) => (node.children ?? []).some((child) => child.tag === 'video')) ? 'yes' : 'no (expected)'}`)
notes.push(`canvas attached: ${canvasNode === undefined ? 'no' : 'yes'}`)
if (detachedVideo === undefined) failures.push('no video element was ever created')
if (canvasNode === undefined) failures.push('canvas was not attached to the splash')
if (allChildren().some((node) => (node.children ?? []).some((child) => child.tag === 'video'))) {
  failures.push('the video element entered the DOM — that is what promotes to the white plane')
}
for (const handler of detachedVideo?.listeners.ended ?? []) handler()
await new Promise((resolve) => setTimeout(resolve, 30))

notes.push(`requests: ${[...new Set(requests)].join(' | ')}`)
notes.push(`timers: ${timers.length} steps (max ${Math.max(0, ...timers)}ms, inline ≤${INLINE_LIMIT_MS}ms)`)
notes.push(`intervals: ${intervals.join(',') || 'none'}`)
notes.push(`slots registered: ${registered.map((entry) => entry.options.name).join(', ') || 'none'}`)
notes.push(`splash still mounted: ${splashNode() === undefined ? 'no' : 'yes'}`)
notes.push(`html marker: ${htmlAttrs.has('data-hdd-splash') ? 'still set' : 'removed'}`)

if (splashNode() !== undefined) failures.push('splash is still in document.body after its timeline — it would eat every click')
if (htmlAttrs.has('data-hdd-splash')) failures.push('html attribute data-hdd-splash was never removed')

const mark = registered.find((entry) => entry.options.id === 'hdd-mark')
if (mark === undefined) failures.push('sidebar emblem was not registered')

console.log(notes.join('\n'))
if (failures.length > 0) {
  console.error('\nFAIL')
  for (const failure of failures) console.error(' - ' + failure)
  process.exitCode = 1
} else {
  console.log('\nPASS')
}
