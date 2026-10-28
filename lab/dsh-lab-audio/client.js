/**
 * Client half of the lab probe. Runs four checks as early as the bundle can run
 * — before any user gesture, which is exactly the condition the boot greeting
 * needs — then both paints the result and posts it to the Host log.
 *
 *   1. range request against the static audio route (206 + content-range)
 *   2. plain fetch of the same file (200 + length)
 *   3. `<audio>` play() with no gesture  → resolves or rejects, and why
 *   4. `new AudioContext()` + resume()   → 'running' or 'suspended'
 *
 * Everything is caught: a probe must never take the shell down with it.
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-lab-audio',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const state = {
      rows: [],
      done: false,
      listeners: new Set(),
    }

    /* Captured synchronously in the module body: this is the only moment that
       proves what the shell looked like BEFORE the probe or any of our timers ran.
       A gesture that happened while the page was already open would make a later
       reading meaningless. */
    const cold = (() => {
      let hasBeenActive = 'n/a'
      try {
        hasBeenActive = navigator.userActivation.hasBeenActive
      } catch {}
      let visibility = 'n/a'
      try {
        visibility = document.visibilityState
      } catch {}
      let contextState = 'not created'
      let probeContext = null
      try {
        probeContext = new AudioContext()
        contextState = probeContext.state
      } catch (error) {
        contextState = 'construct failed: ' + ((error && error.name) || 'Error')
      }
      return { hasBeenActive, visibility, contextState, probeContext }
    })()

    const publish = () => {
      for (const listener of state.listeners) listener()
    }

    const record = (label, ok, detail) => {
      state.rows = [...state.rows, { label, ok, detail }]
      publish()
    }

    const describe = (error) => {
      if (!error) return 'unknown error'
      const name = error.name || 'Error'
      const message = error.message || String(error)
      return `${name}: ${message}`.slice(0, 200)
    }

    const rangeProbe = async () => {
      const response = await fetch('/lab-audio/file', { headers: { range: 'bytes=0-99' } })
      const buffer = await response.arrayBuffer()
      record(
        'range 请求',
        response.status === 206 && buffer.byteLength === 100,
        `status=${response.status} bytes=${buffer.byteLength} ` +
          `content-range=${response.headers.get('content-range') || '-'} ` +
          `type=${response.headers.get('content-type') || '-'}`,
      )
    }

    const fullProbe = async () => {
      const response = await fetch('/lab-audio/file')
      const buffer = await response.arrayBuffer()
      record(
        '整文件请求',
        response.status === 200 && buffer.byteLength > 1000,
        `status=${response.status} bytes=${buffer.byteLength}`,
      )
    }

    const autoplayProbe = async () => {
      const audio = new Audio('/lab-audio/file')
      audio.volume = 0.2
      const gesture = cold.hasBeenActive
      try {
        await audio.play()
        /* play() resolving is not proof of sound: sample the play head and see
           whether it actually advances, which is what a driver or a mute policy
           would stop. */
        await new Promise((resolve) => window.setTimeout(resolve, 500))
        const advanced = audio.currentTime > 0.1
        record(
          'audio.play() 无手势',
          advanced,
          `已播放 · currentTime=${audio.currentTime.toFixed(2)}s ` +
            `paused=${audio.paused} · 载入时 hasBeenActive=${gesture}`,
        )
        window.setTimeout(() => {
          try {
            audio.pause()
          } catch {}
        }, 1200)
      } catch (error) {
        record('audio.play() 无手势', false, `${describe(error)} · 载入时 hasBeenActive=${gesture}`)
      }
    }

    const contextProbe = async () => {
      const context = cold.probeContext
      if (!context) {
        record('AudioContext', false, `构造阶段即失败 · 载入时=${cold.contextState}`)
        return
      }
      const before = context.state
      let after = before
      try {
        await context.resume()
        after = context.state
      } catch (error) {
        record('AudioContext', false, `resume 失败 · ${describe(error)}`)
        void context.close?.()
        return
      }
      record(
        'AudioContext',
        after === 'running',
        `模块体阶段=${cold.contextState} 探测前=${before} resume 后=${after} ` +
          `· 载入时 hasBeenActive=${cold.hasBeenActive} visibility=${cold.visibility}`,
      )
      if (after !== 'running') void context.close?.()
    }

    const report = async () => {
      const payload = {
        probe: 'lab-audio',
        ua: navigator.userAgent.slice(0, 160),
        visibility: document.visibilityState,
        cold: {
          hasBeenActive: cold.hasBeenActive,
          visibility: cold.visibility,
          contextState: cold.contextState,
        },
        rows: state.rows,
      }
      try {
        await fetch('/lab-audio/report', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        })
      } catch {}
    }

    const runProbe = async () => {
      if (state.done) return
      state.done = true
      for (const step of [rangeProbe, fullProbe, autoplayProbe, contextProbe]) {
        try {
          await step()
        } catch (error) {
          record(step.name || '步骤', false, describe(error))
        }
      }
      await report()
    }

    function Panel() {
      const [rows, setRows] = React.useState(state.rows)
      const [hidden, setHidden] = React.useState(false)
      React.useEffect(() => {
        const listener = () => setRows(state.rows)
        state.listeners.add(listener)
        listener()
        return () => state.listeners.delete(listener)
      }, [])
      if (hidden) return null
      return h(
        'div',
        {
          'data-lab-audio-panel': 'true',
          style: {
            position: 'fixed',
            top: '12px',
            right: '12px',
            zIndex: 2147483001,
            maxWidth: '520px',
            padding: '10px 12px',
            borderRadius: '10px',
            border: '1px solid rgba(126, 220, 255, 0.45)',
            background: 'rgba(6, 14, 24, 0.92)',
            color: '#e8f2fa',
            font: '12px/1.5 ui-monospace, Consolas, monospace',
            pointerEvents: 'auto',
            boxShadow: '0 0 24px rgba(98, 212, 255, 0.25)',
          },
        },
        h(
          'div',
          { style: { display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '6px' } },
          h('strong', { style: { fontSize: '12px', letterSpacing: '0.08em' } }, 'LAB · AUDIO PROBE'),
          h(
            'button',
            {
              onClick: () => setHidden(true),
              style: {
                marginLeft: 'auto',
                cursor: 'pointer',
                border: 0,
                borderRadius: '6px',
                padding: '2px 8px',
                background: 'rgba(126, 220, 255, 0.16)',
                color: '#e8f2fa',
                font: 'inherit',
              },
            },
            '收起',
          ),
        ),
        rows.length === 0
          ? h('div', { style: { opacity: 0.6 } }, '探测中…')
          : rows.map((row, index) =>
              h(
                'div',
                { key: index, style: { display: 'flex', gap: '6px' } },
                h('span', { style: { color: row.ok ? '#5ff2a8' : '#ff7b8a' } }, row.ok ? '✓' : '✗'),
                h('span', { style: { opacity: 0.85 } }, row.label + ' · '),
                h('span', { style: { opacity: 0.7 } }, row.detail),
              ),
            ),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('shell.overlay', () =>
          ctx.slots.register({ name: 'shell.overlay', id: 'lab-audio', order: 999 }, Panel),
        )
        window.setTimeout(() => {
          void runProbe()
        }, 300)
      },
    }
  },
})
