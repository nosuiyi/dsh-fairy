/**
 * Load smoke test for the skin's client half.
 *
 * `node --check` proves it parses; this proves the module body, `apply(ctx)` and the
 * panel-rule builder actually run. It exists because the skin once shipped a client
 * half that produced no log events at all — a runtime throw inside `apply` looks
 * exactly like "the bundle never loaded" from the outside.
 *
 * The Context is a Proxy: unknown services answer with a callable/instantiable stub
 * instead of throwing, so the harness keeps working when the skin starts using one
 * more service.
 */
import { readFile } from 'node:fs/promises'

const failures = []
const notes = []

/* ------------------------------------------------------------------ browser */

const element = (tag = 'div') => ({
  tag,
  style: { setProperty() {}, getPropertyValue: () => '' },
  dataset: {},
  attrs: {},
  children: [],
  classList: [],
  innerHTML: '',
  textContent: '',
  clientWidth: 1280,
  clientHeight: 820,
  width: 1280,
  height: 820,
  setAttribute(name, value) { this.attrs[name] = String(value) },
  getAttribute(name) { return this.attrs[name] ?? null },
  removeAttribute(name) { delete this.attrs[name] },
  hasAttribute: (name) => Object.hasOwn(this.attrs ?? {}, name),
  appendChild(child) { this.children.push(child); child.parent = this; return child },
  insertBefore(child) { this.children.unshift(child); child.parent = this; return child },
  remove() {
    if (this.parent !== undefined) this.parent.children = this.parent.children.filter((node) => node !== this)
  },
  addEventListener() {},
  removeEventListener() {},
  dispatchEvent() {},
  getBoundingClientRect: () => ({ left: 0, top: 0, width: 1280, height: 820 }),
  getContext: () => ({ drawImage() {}, getImageData: () => ({ data: [12, 24, 38, 255] }) }),
  play: () => Promise.resolve(),
  pause() {},
  load() {},
  offsetWidth: 1280,
  offsetHeight: 820,
})

const body = element('body')
body.children = []

const documentStub = {
  body,
  visibilityState: 'visible',
  documentElement: element('html'),
  head: element('head'),
  createElement: (tag) => element(tag),
  createElementNS: (_ns, tag) => element(tag),
  querySelector: () => null,
  querySelectorAll: () => [],
  styleSheets: [],
  addEventListener() {},
  removeEventListener() {},
}

const timers = []
const windowStub = {
  __ModuleLoader__: { load: (registration) => (moduleRegistration = registration) },
  performance: { now: () => 0 },
  innerWidth: 1280,
  innerHeight: 820,
  devicePixelRatio: 1,
  setTimeout: (fn, ms) => {
    timers.push(ms)
    if (ms > 8000) return timers.length
    try { fn() } catch (error) { failures.push(`setTimeout(${ms}): ${error.stack}`) }
    return timers.length
  },
  clearTimeout() {},
  setInterval: (fn, ms) => { timers.push(ms); return timers.length },
  clearInterval() {},
  requestAnimationFrame: () => 0,
  cancelAnimationFrame() {},
  addEventListener() {},
  removeEventListener() {},
  dispatchEvent() {},
  getComputedStyle: () => ({ position: 'fixed', display: 'grid', backgroundColor: 'rgb(5, 8, 14)', opacity: '1', zIndex: '1' }),
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init?.detail } },
  Audio: class { constructor() {} play() { return Promise.resolve() } pause() {} addEventListener() {} },
}

let moduleRegistration
globalThis.window = windowStub
globalThis.document = documentStub
globalThis.CustomEvent = windowStub.CustomEvent
globalThis.Audio = windowStub.Audio
globalThis.AudioContext = class { constructor() { this.state = 'running'; this.destination = {}; this.currentTime = 0 } resume() { return Promise.resolve() } close() { return Promise.resolve() } decodeAudioData(_b, ok) { ok({ duration: 1 }) } createBufferSource() { return { connect() {}, start() {} } } }
globalThis.fetch = async (url) => ({
  ok: true,
  status: 200,
  json: async () => (String(url).includes('/hdd/info')
    ? { root: 'x', exists: true, backdrop: 'boot.png', video: 'boot.mp4', field: 'boot-field.png', greetings: { morning: ['a.m4a'] }, cues: { thinking: 'thinking.m4a', done: null, failed: null }, buckets: [{ id: 'morning', label: 'm', from: 5, to: 11, count: 1 }, { id: 'evening', label: 'e', from: 18, to: 22, count: 0 }] }
    : String(url).includes('/hdd/greeting') ? { bucket: 'morning', file: 'greeting/a.m4a', url: '/hdd/asset?path=a.m4a' } : { seq: 0, cues: [] }),
  arrayBuffer: async () => new ArrayBuffer(256),
})
globalThis.Blob = Blob
globalThis.URL = URL
const navigatorStub = { userAgent: 'smoke', userActivation: { hasBeenActive: false } }

/* ------------------------------------------------------------------- module */

const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
try {
  new Function('window', 'document', 'navigator', 'fetch', 'Audio', 'AudioContext', 'Blob', 'URL', 'CustomEvent', source)(
    windowStub, documentStub, navigatorStub, globalThis.fetch, globalThis.Audio,
    globalThis.AudioContext, Blob, URL, windowStub.CustomEvent,
  )
} catch (error) {
  failures.push(`module body: ${error.stack}`)
}

if (!moduleRegistration) failures.push('client.js did not call window.__ModuleLoader__.load')
else if (moduleRegistration.id !== 'dsh-skin-hdd-fairy') failures.push(`unexpected module id: ${moduleRegistration.id}`)

const exportsObject = moduleRegistration
  ? moduleRegistration.factory((specifier) => {
      if (specifier === 'react') {
        return {
          createElement: (type, props, ...children) => ({ type, props, children }),
          useRef: (initial) => ({ current: initial }),
          useState: (initial) => [initial, () => {}],
          useEffect: (fn) => { const cleanup = fn(); if (typeof cleanup === 'function') cleanup() },
        }
      }
      throw new Error(`unexpected require: ${specifier}`)
    })
  : undefined

/* ---------------------------------------------------------------------- ctx */

const disposers = []
const slots = []
const makeStub = (name) => {
  const fn = () => makeStub(`${name}()`)
  return new Proxy(fn, {
    get: (target, key) => {
      if (key === 'then') return undefined
      if (key === Symbol.toPrimitive) return () => `[${name}]`
      return makeStub(`${name}.${String(key)}`)
    },
    apply: () => makeStub(`${name}()`),
    construct: () => ({}),
  })
}

const theme = {
  getTheme: () => ({ preference: 'light', active: { colorScheme: 'light' } }),
  setTheme: () => {},
}

const ctx = new Proxy({}, {
  get: (_target, key) => {
    if (key === 'effect') {
      return (callback, label) => {
        try {
          const dispose = callback()
          if (typeof dispose === 'function') disposers.push({ label, dispose })
        } catch (error) {
          failures.push(`effect(${String(label)}): ${error.stack}`)
        }
        return () => {}
      }
    }
    if (key === 'theme') return theme
    if (key === 'slots') {
      return {
        inject: (_name, callback) => callback(),
        register: (options) => { slots.push(options); return () => {} },
      }
    }
    if (key === 'logger') return { info() {}, warn() {}, error() {}, debug() {} }
    if (key === 'on') return () => () => {}
    if (key === 'get') return () => undefined
    return makeStub(String(key))
  },
})

if (exportsObject) {
  try {
    exportsObject.apply(ctx)
  } catch (error) {
    failures.push(`apply: ${error.stack}`)
  }
}

await new Promise((resolve) => setTimeout(resolve, 30))

notes.push(`inject: ${(exportsObject?.inject ?? []).join(', ') || 'none'}`)
notes.push(`slots registered: ${slots.map((s) => `${s.name}#${s.id}`).join(', ') || 'none'}`)
notes.push(`disposers: ${disposers.length}`)
notes.push(`body attr: ${document.body.getAttribute('data-dsh-hdd-fairy') ?? '—'}`)
notes.push(`timers: ${timers.length} steps`)

/* Releasing must not throw: that path runs when the skin manager switches skins. */
for (const { label, dispose } of disposers.reverse()) {
  try {
    dispose()
  } catch (error) {
    failures.push(`dispose(${label}): ${error.stack}`)
  }
}
notes.push(`body attr after release: ${document.body.getAttribute('data-dsh-hdd-fairy') ?? '—'}`)

console.log(notes.join('\n'))
if (failures.length > 0) {
  console.error('\nFAIL')
  for (const failure of failures) console.error(' - ' + failure)
  process.exitCode = 1
} else {
  console.log('\nPASS')
}
