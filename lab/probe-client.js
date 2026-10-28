/**
 * TEMPORARY PROBE — replaces `client.js` only for the white-screen investigation.
 *
 * It mounts a small panel in the corner. Nothing happens until the button is
 * pressed; then it runs four short phases in sequence, each reported to
 * `/hdd/report` with its own timestamp, so the recorded frames can be aligned
 * with the phase that produced them:
 *
 *   P1  dark-only      a plain dark overlay, no video, no canvas
 *   P2  video-playing  a detached <video> playing the launch clip, no canvas
 *   P3  canvas-only    an accelerated 2D canvas painting a gradient, no video
 *   P4  video-canvas   detached video painted into the canvas (the shipped path)
 *
 * The original file is backed up in `lab/backups/` and restored afterwards.
 */
window.__ModuleLoader__.load({
  id: 'dsh-hdd-visual',
  factory() {
    const PANEL = 'data-hdd-probe'
    const STAGE = 'data-hdd-probe-stage'
    const AUTO_START_MS = 60000

    function report(event, detail) {
      try {
        void fetch('/hdd/report', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            event,
            detail: detail === undefined ? null : detail,
            perf: typeof performance === 'object' ? Math.round(performance.now()) : -1,
            visibility: typeof document === 'object' ? document.visibilityState : '?',
          }),
        }).catch(() => {})
      } catch {
        /* never break the probe over diagnostics */
      }
    }

    const CSS = `
      [${STAGE}] {
        position: fixed; inset: 0; z-index: 2147483000;
        display: grid; place-items: center;
        background-color: #05080e; color: #e8f2fa;
        font: 600 34px/1.4 system-ui, sans-serif; letter-spacing: 0.06em;
        text-align: center; pointer-events: none;
      }
      [${PANEL}] {
        position: fixed; right: 18px; bottom: 18px; z-index: 2147483001;
        width: 260px; padding: 12px 14px; border-radius: 12px;
        background: rgba(12, 20, 32, 0.96); color: #dbe9f6;
        border: 1px solid rgba(126, 220, 255, 0.35);
        font: 13px/1.6 system-ui, sans-serif; pointer-events: auto;
      }
      [${PANEL}] button {
        margin-top: 8px; width: 100%; padding: 8px 10px; cursor: pointer;
        border-radius: 8px; border: 1px solid rgba(126, 220, 255, 0.6);
        background: rgba(30, 60, 90, 0.9); color: #e8f2fa; font: inherit;
      }
      [${PANEL}] .s { opacity: 0.75; margin-top: 6px; min-height: 18px; }
    `

    return {
      inject: ['slots'],
      apply(ctx) {
        report('probe-apply')

        ctx.effect(() => {
          const style = document.createElement('style')
          style.setAttribute('data-hdd-probe-style', '')
          style.textContent = CSS
          document.head.appendChild(style)
          return () => style.remove()
        }, 'probe stylesheet')

        const panel = document.createElement('div')
        panel.setAttribute(PANEL, 'true')
        panel.innerHTML = [
          '<strong>开屏白屏探针</strong>',
          '<div class="s" data-probe-status>60 秒后自动开始（或点按钮立即开始），共约 20 秒</div>',
          '<button type="button" data-probe-start>开始 20 秒测试</button>',
        ].join('')
        document.body.appendChild(panel)
        const status = panel.querySelector('[data-probe-status]')
        const button = panel.querySelector('[data-probe-start]')

        let disposed = false
        let started = false
        let autoTimer = 0
        let stage = null
        let video = null
        let canvas = null
        let raf = 0
        let cancelled = false

        const teardownStage = () => {
          if (raf !== 0) {
            window.cancelAnimationFrame(raf)
            raf = 0
          }
          if (video !== null) {
            try {
              video.pause()
              video.removeAttribute('src')
              video.load()
            } catch {
              /* discard */
            }
            video.remove()
            video = null
          }
          if (canvas !== null) {
            canvas.remove()
            canvas = null
          }
          if (stage !== null) {
            stage.remove()
            stage = null
          }
        }

        const sleep = (ms) => new Promise((resolve) => {
          const timer = window.setTimeout(resolve, ms)
          void timer
        })

        const makeStage = (label) => {
          const node = document.createElement('div')
          node.setAttribute(STAGE, 'true')
          node.textContent = label
          document.body.appendChild(node)
          return node
        }

        const phases = [
          {
            id: 'P1-dark-only',
            ms: 2000,
            begin: () => {
              stage = makeStage('P1 纯深色遮罩')
            },
          },
          {
            id: 'P2-video-playing-only',
            ms: 6000,
            begin: () => {
              stage = makeStage('P2 视频播放（无 canvas）')
              video = document.createElement('video')
              video.muted = false
              video.playsInline = true
              video.preload = 'auto'
              /* Detached on purpose: the element is never appended to the page. */
              video.src = '/hdd/asset?path=' + encodeURIComponent('boot.mp4')
              void video.play()?.catch?.(() => {})
            },
            end: () => {
              report('probe-video-state', {
                readyState: video === null ? -1 : video.readyState,
                currentTime: video === null ? -1 : Math.round(video.currentTime * 100) / 100,
                paused: video === null ? null : video.paused,
              })
            },
          },
          {
            id: 'P3-canvas-only',
            ms: 5000,
            begin: () => {
              stage = makeStage('P3 只有 canvas（无视频）')
              canvas = document.createElement('canvas')
              canvas.style.position = 'absolute'
              canvas.style.inset = '0'
              canvas.style.width = '100%'
              canvas.style.height = '100%'
              stage.appendChild(canvas)
              const context = canvas.getContext('2d')
              let tick = 0
              const draw = () => {
                if (canvas === null) return
                const width = canvas.clientWidth
                const height = canvas.clientHeight
                if (width > 0 && height > 0) {
                  if (canvas.width !== width || canvas.height !== height) {
                    canvas.width = width
                    canvas.height = height
                  }
                  const gradient = context.createLinearGradient(0, 0, width, height)
                  const shift = (tick % 100) / 100
                  gradient.addColorStop(0, `hsl(${200 + shift * 40}, 70%, 22%)`)
                  gradient.addColorStop(1, `hsl(${220 + shift * 40}, 60%, 8%)`)
                  context.fillStyle = gradient
                  context.fillRect(0, 0, width, height)
                  tick += 2
                }
                raf = window.requestAnimationFrame(draw)
              }
              raf = window.requestAnimationFrame(draw)
            },
          },
          {
            id: 'P4-video-canvas',
            ms: 6000,
            begin: () => {
              stage = makeStage('P4 视频 + canvas')
              canvas = document.createElement('canvas')
              canvas.style.position = 'absolute'
              canvas.style.inset = '0'
              canvas.style.width = '100%'
              canvas.style.height = '100%'
              stage.appendChild(canvas)
              video = document.createElement('video')
              video.muted = false
              video.playsInline = true
              video.preload = 'auto'
              video.src = '/hdd/asset?path=' + encodeURIComponent('boot.mp4')
              void video.play()?.catch?.(() => {})
              const context = canvas.getContext('2d')
              const draw = () => {
                if (canvas === null || video === null) return
                const width = canvas.clientWidth
                const height = canvas.clientHeight
                if (width > 0 && height > 0 && video.readyState >= 2) {
                  if (canvas.width !== width || canvas.height !== height) {
                    canvas.width = width
                    canvas.height = height
                  }
                  const scale = Math.max(width / video.videoWidth, height / video.videoHeight)
                  const drawWidth = video.videoWidth * scale
                  const drawHeight = video.videoHeight * scale
                  context.drawImage(
                    video,
                    (width - drawWidth) / 2,
                    (height - drawHeight) / 2,
                    drawWidth,
                    drawHeight,
                  )
                }
                raf = window.requestAnimationFrame(draw)
              }
              raf = window.requestAnimationFrame(draw)
            },
            end: () => {
              report('probe-video-state', {
                readyState: video === null ? -1 : video.readyState,
                currentTime: video === null ? -1 : Math.round(video.currentTime * 100) / 100,
                paused: video === null ? null : video.paused,
              })
            },
          },
        ]

        const run = async () => {
          button.disabled = true
          report('probe-start')
          for (const phase of phases) {
            if (disposed || cancelled) break
            status.textContent = '进行中：' + phase.id
            report('probe-phase', { id: phase.id, ms: phase.ms })
            try {
              phase.begin()
            } catch (error) {
              report('probe-phase-error', { id: phase.id, error: String(error).slice(0, 200) })
            }
            await sleep(phase.ms)
            try {
              phase.end?.()
            } catch {
              /* best effort */
            }
            teardownStage()
            await sleep(400)
          }
          status.textContent = cancelled ? '已取消' : '测试完成，可以告诉我了'
          report('probe-end', { cancelled })
          button.disabled = false
        }

        button.addEventListener('click', () => {
          if (started) return
          started = true
          if (autoTimer !== 0) {
            window.clearTimeout(autoTimer)
            autoTimer = 0
          }
          cancelled = false
          void run()
        })

        /* Auto-start: the investigation is hands-off, so the sequence must run even
           if nobody touches the panel. The button only starts it sooner. */
        autoTimer = window.setTimeout(() => {
          if (started) return
          started = true
          autoTimer = 0
          void run()
        }, AUTO_START_MS)

        ctx.effect(() => () => {
          disposed = true
          cancelled = true
          if (autoTimer !== 0) {
            window.clearTimeout(autoTimer)
            autoTimer = 0
          }
          teardownStage()
          panel.remove()
        }, 'probe panel')
      },
    }
  },
})
