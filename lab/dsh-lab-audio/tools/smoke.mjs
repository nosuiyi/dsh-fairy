/**
 * Load smoke test for the probe bundle's client half.
 *
 * `node --check` only proves the file parses. This stubs just enough browser to
 * run the module body and its `apply()`, which is where a ReferenceError or a
 * missing global actually shows up. Node 22+ has fetch, but every browser global
 * the probe touches is replaced here so the run is deterministic and silent.
 */
import { readFile } from 'node:fs/promises'

const failures = []
const rows = []

const listeners = new Set()
const reactStub = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState: (initial) => [initial, () => {}],
  useEffect: (fn) => {
    try {
      const cleanup = fn()
      if (typeof cleanup === 'function') listeners.add(cleanup)
    } catch (error) {
      failures.push(`useEffect: ${error.message}`)
    }
  },
}

const documentStub = {
  visibilityState: 'visible',
  createElement: () => ({ setAttribute() {}, appendChild() {}, remove() {}, style: {} }),
  head: { appendChild() {}, removeChild() {} },
  documentElement: { setAttribute() {}, removeAttribute() {}, hasAttribute: () => false },
  addEventListener() {},
  removeEventListener() {},
}

const audioInstances = []
class AudioStub {
  constructor(src) {
    this.src = src
    this.volume = 1
    audioInstances.push(this)
  }

  play() {
    return Promise.resolve()
  }

  pause() {}
}

class AudioContextStub {
  constructor() {
    this.state = 'running'
  }

  resume() {
    return Promise.resolve()
  }

  close() {
    return Promise.resolve()
  }
}

const fetchCalls = []
const fetchStub = async (url, init = {}) => {
  fetchCalls.push({ url, init })
  const ranged = Boolean(init.headers && init.headers.range)
  return {
    status: ranged ? 206 : 200,
    arrayBuffer: async () => new ArrayBuffer(ranged ? 100 : 8727),
    headers: { get: (name) => (name === 'content-range' ? 'bytes 0-99/8727' : 'audio/mp4') },
  }
}

const registered = []
let moduleRegistration

globalThis.window = {
  __ModuleLoader__: { load: (registration) => (moduleRegistration = registration) },
  setTimeout: (fn) => {
    try {
      fn()
    } catch (error) {
      failures.push(`setTimeout: ${error.message}`)
    }
    return 0
  },
  clearTimeout: () => {},
  performance: { now: () => 0 },
  Audio: AudioStub,
}
globalThis.document = documentStub
/* Node 22 exposes a read-only `navigator`; the stub is passed as a parameter instead. */
const navigatorStub = { userAgent: 'smoke', userActivation: { hasBeenActive: false } }
globalThis.Audio = AudioStub
globalThis.AudioContext = AudioContextStub
globalThis.AudioContext.prototype.state = 'running'
globalThis.fetch = fetchStub
globalThis.URL = URL
globalThis.Blob = Blob

const source = await readFile(new URL('../client.js', import.meta.url), 'utf8')
try {
  new Function('window', 'document', 'navigator', 'fetch', 'Audio', 'AudioContext', source)(
    globalThis.window,
    documentStub,
    navigatorStub,
    fetchStub,
    AudioStub,
    AudioContextStub,
  )
} catch (error) {
  failures.push(`module body: ${error.stack}`)
}

if (!moduleRegistration) failures.push('client.js did not call window.__ModuleLoader__.load')
else if (moduleRegistration.id !== '@local/dsh-lab-audio') {
  failures.push(`unexpected module id: ${moduleRegistration.id}`)
}

const exportsObject = moduleRegistration
  ? moduleRegistration.factory((specifier) => {
      if (specifier === 'react') return reactStub
      throw new Error(`unexpected require: ${specifier}`)
    })
  : undefined

if (exportsObject) {
  for (const key of exportsObject.inject || []) rows.push(`inject: ${key}`)
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

/* The probe defers work through window.setTimeout, which the stub runs inline. */
await new Promise((resolve) => setTimeout(resolve, 60))

rows.push(`slots registered: ${registered.map((entry) => `${entry.options.name}#${entry.options.id}`).join(', ') || 'none'}`)
rows.push(`fetch calls: ${fetchCalls.map((call) => `${call.init.method || 'GET'} ${call.url}`).join(', ') || 'none'}`)
rows.push(`audio instances: ${audioInstances.length}`)

console.log(rows.join('\n'))
if (failures.length > 0) {
  console.error('\nFAIL')
  for (const failure of failures) console.error(' - ' + failure)
  process.exitCode = 1
} else {
  console.log('\nPASS')
}
