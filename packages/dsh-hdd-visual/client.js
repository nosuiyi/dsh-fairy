/**
 * Client half of `dsh-hdd-visual` — launch splash, sidebar emblem, cue player.
 *
 * Three rules shape this file:
 *
 *   1. Slots are taken additively. `shell.overlay` and `sidebar.footer.action` are
 *      `list` slots, so this bundle never competes with the official brand rows
 *      that occupy the `single` seats (`sidebar.brand.mark` / `.name`). A skin that
 *      registers into a single seat throws when someone else already sits there.
 *   2. No theme tokens are redefined. The splash paints its own surfaces and lets
 *      `ui-theme` own everything else, so the shell keeps its palette.
 *   3. Every failure degrades to "less splash", never to "no shell": missing
 *      assets, a missing voice package, a refused AudioContext and a failed route
 *      each have a silent path out.
 */
window.__ModuleLoader__.load({
  id: 'dsh-hdd-visual',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** Set on <html> while the splash owns the screen; hides the sidebar emblem. */
    const SPLASH_ATTR = 'data-hdd-splash'

    const TIMING = {
      fadeIn: 260,
      emblemIn: 420,
      emblemInMs: 560,
      greetingAt: 700,
      /** Hold after the greeting ends, or after `greetingAt` when there is none. */
      holdAfter: 900,
      /** Upper bound on the greeting wait, so a long clip cannot trap the shell. */
      maxHold: 6000,
      /** Safety cap on the launch animation; the clip itself decides the real end. */
      videoMaxMs: 30000,
      /**
       * Where the launch animation is cut, in seconds.
       *
       * The clip's tail is a fade to black: the reference implementation measured
       * the white-to-black boundary with `blackdetect` and stopped there (12.9 s),
       * which is also where this file goes fully black. Playing the remaining
       * 1.6 s only delays the emblem.
       */
      videoEndS: 12.9,
      /** How long the highlight plate stays before it starts fading out. */
      fieldHoldMs: 1700,
      /** Plate fade-out duration; the flight starts when it finishes. */
      fieldOutMs: 1150,
      gather: 430,
      fly: 1400,
      fadeOut: 520,
      /** Backstop when the splash has no animation to wait for. */
      hardStop: 12000,
      /** Backstop while waiting for the asset inventory (/hdd/info). */
      infoTimeout: 15000,
    }

    const CUE_POLL_MS = 1500
    const CUE_VOLUME = 0.45

    /**
     * Fire-and-forget diagnostics.
     *
     * The splash is the one feature whose failure mode is "nothing happens", so it
     * reports each phase to the Host, which appends to `$DSH_HOME/hdd-visual.log`.
     * Without this, a skipped splash and a broken bundle look identical from the
     * outside.
     */
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
        /* Diagnostics must never break the thing they observe. */
      }
    }

    /* Emblem geometry from the reference HDD skin (Chengzhibense/Fairy-DSH,
       Apache-2.0): the mark is one vector, redrawn here for the splash and the
       sidebar seat. Reused with attribution; see THIRD_PARTY notices. */
    const FAIRY_EMBLEM = [
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="-1 -1 162 162" role="img" aria-label="Fairy">',
      '<defs>',
      '<linearGradient id="hddFairyOuter" x1=".2" y1="0" x2=".8" y2="1">',
      '<stop stop-color="#4053f0"/><stop offset=".54" stop-color="#3045dc"/><stop offset="1" stop-color="#3d50c8"/>',
      '</linearGradient>',
      '<radialGradient id="hddFairyScleraHalo" gradientUnits="userSpaceOnUse" cx="80" cy="80" r="56" color-interpolation="linearRGB">',
      '<stop offset=".82" stop-color="#fff" stop-opacity="0"/><stop offset=".875" stop-color="#fff" stop-opacity=".28"/>',
      '<stop offset=".91" stop-color="#fff" stop-opacity=".11"/><stop offset=".96" stop-color="#fff" stop-opacity=".035"/>',
      '<stop offset="1" stop-color="#fff" stop-opacity="0"/>',
      '</radialGradient>',
      '<radialGradient id="hddFairyOuterHalo" gradientUnits="userSpaceOnUse" cx="80" cy="80" r="79" color-interpolation="linearRGB">',
      '<stop offset=".80" stop-color="#fff" stop-opacity="0"/><stop offset=".868" stop-color="#fff" stop-opacity=".28"/>',
      '<stop offset=".90" stop-color="#fff" stop-opacity=".18"/><stop offset=".95" stop-color="#fff" stop-opacity=".06"/>',
      '<stop offset="1" stop-color="#fff" stop-opacity="0"/>',
      '</radialGradient>',
      '<radialGradient id="hddFairyCatchHalo" gradientUnits="userSpaceOnUse" cx="98" cy="100.5" r="18" color-interpolation="linearRGB">',
      '<stop offset=".53" stop-color="#f5f8fd" stop-opacity="0"/><stop offset=".611" stop-color="#f5f8fd" stop-opacity=".43"/>',
      '<stop offset=".72" stop-color="#f5f8fd" stop-opacity=".19"/><stop offset=".83" stop-color="#f5f8fd" stop-opacity=".055"/>',
      '<stop offset="1" stop-color="#f5f8fd" stop-opacity="0"/>',
      '</radialGradient>',
      '</defs>',
      '<circle cx="80" cy="80" r="79" fill="url(#hddFairyOuterHalo)"/>',
      '<circle cx="80" cy="80" r="68" fill="none" stroke="#dceaff" stroke-width="1.8"/>',
      '<circle cx="80" cy="80" r="68" fill="url(#hddFairyOuter)" stroke="#f2fbff" stroke-width="1.2"/>',
      '<g id="hddFairyCorners" fill="#2b3388" transform="rotate(0 80 80)">',
      '<circle cx="80" cy="80" r="51.75"/><rect x="37" y="37" width="86" height="86" rx="2" transform="rotate(3 80 80)"/>',
      '</g>',
      '<g id="hddFairySclera" transform="translate(80 80) scale(1) translate(-80 -80)">',
      '<circle cx="80" cy="80" r="48" fill="#eef0f5"/><circle cx="80" cy="80" r="56" fill="url(#hddFairyScleraHalo)"/>',
      '<circle cx="80" cy="80" r="48" fill="none" stroke="#fff" stroke-width=".8" stroke-opacity=".16"/>',
      '</g>',
      '<g id="hddFairyIrisOuter" transform="translate(80 80) scale(1) translate(-80 -80)"><circle cx="80" cy="80" r="33" fill="#9daee0"/></g>',
      '<g id="hddFairyIrisBlue" transform="translate(80 80) scale(1) translate(-80 -80)">',
      '<circle cx="80" cy="80" r="24.15" fill="#eef0f5"/><circle cx="80" cy="80" r="23.5" fill="#317bcf"/></g>',
      '<g id="hddFairyPupil" transform="translate(80 80) scale(1) translate(-80 -80)">',
      '<circle cx="80" cy="80" r="16.6" fill="none" stroke="#f5f8fd" stroke-width=".1"/><circle cx="80" cy="80" r="16" fill="#3b3d8a"/></g>',
      '<g id="hddFairyHighlight" transform="translate(80 80) scale(1) translate(-80 -80)">',
      '<circle cx="98" cy="100.5" r="18" fill="url(#hddFairyCatchHalo)"/><circle cx="98" cy="100.5" r="11" fill="#f5f8fd"/></g>',
      '</svg>',
    ].join('');

    const CSS = [
      /* `div[data-hdd-splash]`, never a bare `[data-hdd-splash]`: the marker is also
         written onto <html> (so the sidebar emblem can hide), and a bare attribute
         selector then styles the document element itself — `position: fixed`,
         `display: grid`, `pointer-events: none` and a dark fill on <html>, which
         collapses the whole application into a narrow centred column that cannot be
         clicked. That was the "narrow window" bug. */
      'div[data-hdd-splash] {',
      '  position: fixed; inset: 0; z-index: 2147483000;',
      '  display: grid; place-items: center;',
      '  background-color: #05080e;',
      /* Decorative, never interactive: a splash that swallows clicks is worse
         than no splash at all. */
      '  pointer-events: none;',
      /* No opacity animation on this layer. A full-screen fading layer whose child
         canvas is painted from decoded video frames composites as a white sheet on
         this build (probe P5), while the same canvas without the fade paints
         normally (probe P4). The splash therefore cuts in and out instantly. */
      '}',
      /* The overlay's own dark fill leaves with the plate. It animates
         `background-color`, not `opacity`: an opacity animation on a full-screen
         layer is what failed as a white sheet on this build, while a colour
         transition takes a different path. The app is revealed as a dissolve from
         black rather than the plate alone fading over an already-lit window. */
      'div[data-hdd-splash][data-clear="true"] {',
      '  background-color: transparent;',
      '  transition: background-color 1150ms ease-out;',
      '}',
      '[data-hdd-backdrop] {',
      '  position: absolute; inset: 0;',
      '  background-position: center; background-size: cover; background-repeat: no-repeat;',
      '  opacity: 0; transition: opacity 620ms ease-out;',
      '}',
      '[data-hdd-backdrop][data-on="true"] { opacity: 1; }',
      /* The launch animation fills the splash while it plays and stays as the
         splash background after it ends: the emblem then rises over its last frame.
         There is no `[data-hdd-video]` rule any more: the <video> never enters the
         document (see the splash branch in `mountSplash`). */
      '[data-hdd-video-canvas] {',
      '  position: absolute; inset: 0; width: 100%; height: 100%;',
      '  display: block; background: #05080e;',
      '}',
      /* The drawn highlight plate the emblem sits on after the animation is cut.
         It fades in with the emblem and fades out before the emblem flies away. */
      '[data-hdd-field] {',
      '  position: absolute; inset: 0;',
      '  background-position: center; background-size: cover; background-repeat: no-repeat;',
      '  opacity: 0; transition: opacity 620ms ease-out;',
      '}',
      '[data-hdd-field][data-on="true"] { opacity: 1; }',
      '[data-hdd-field][data-on="false"] { opacity: 0; transition: opacity 1150ms ease-in; }',
      '[data-hdd-holder] {',
      '  position: relative;',
      '  width: min(300px, 42vw);',
      '  aspect-ratio: 1 / 1;',
      '  height: auto;',
      /* Rises from small to full size once the animation is cut. Starting at 0.86
         and dropping back to it before the flight read as a bounce. */
      '  transform: scale(0.42);',
      '  transition: transform 620ms cubic-bezier(0.22, 0.61, 0.36, 1);',
      /* No `filter` on anything inside the splash: a filtered layer that holds
         video-derived content is a second suspect for the white sheet (probe P5),
         and the glow is not worth the risk. */
      '}',
      '[data-hdd-holder][data-on="true"] { transform: scale(1); }',
      '[data-hdd-holder][data-gather="true"] { transform: scale(0.86); transition-duration: 430ms; }',
      '[data-hdd-holder] svg { width: 100%; height: 100%; display: block; }',
      '[data-hdd-hint] {',
      '  position: absolute; bottom: 6vh; left: 50%; transform: translateX(-50%);',
      '  max-width: min(520px, 80vw); text-align: center;',
      '  color: rgba(232, 242, 250, 0.5); font-size: 12px; line-height: 1.7;',
      '  letter-spacing: 0.04em; white-space: pre-line;',
      '}',
      /* The emblem that lives in the sidebar foot. Circles need an explicit
         corner-shape on this build: the default radius is a squircle.

         Size is one variable, flipped by `data-rail` (the slot's `wide` prop): the
         wide sidebar gets 44px, the 56px rail gets 30px. `max-width: 100%` is the
         backstop so a future padding change can only shrink it, never let it spill;
         `flex: 0 0 auto` stops a narrow row from squeezing the WIDTH while the height
         stays put, which is what once turned the round mark into a rounded rectangle.
         `pointer-events: none` because this is decoration: clicks must reach the
         workspace list and the Settings row underneath, whatever the glow covers. */
      '[data-hdd-mark] {',
      '  --hdd-mark-size: 60px;',
      /* Ring thickness is tied to the seat size instead of the reference's fixed 5px:
         that value was measured for a 224px mark, and 5px around a 60px mark is a
         heavy outline rather than light. */
      '  --hdd-mark-ring: 3px;',
      '  display: inline-grid; place-items: center;',
      '  width: var(--hdd-mark-size); aspect-ratio: 1 / 1; height: auto;',
      '  max-width: 100%; flex: 0 0 auto;',
      '  pointer-events: none;',
      '  transition: width 220ms ease-out;',
      '}',
      '[data-hdd-mark][data-rail="true"] { --hdd-mark-size: 30px; --hdd-mark-ring: 2px; }',
      '[data-hdd-mark] svg { display: block; }',
      '[data-hdd-mark] circle { corner-shape: round; }',
      `html[${SPLASH_ATTR}="true"] [data-hdd-mark] { opacity: 0; transition: opacity 200ms linear; }`,

      /* ---- the vector's own motion (ported from the reference skin) ----
         Everything is scoped to `[data-hdd-mark-scope]`, which the markup puts on
         the stage wrapper, so the same rules drive the 26px sidebar copy and the
         splash copy without touching anything else on the page.

         `transform-box: view-box` is what makes `transform-origin: 80px 80px` mean
         "the centre of the drawing" for an SVG child; without it the origin is the
         element's own bounding box and the layered eye drifts. */
      '[data-hdd-mark-scope] #hddFairyCorners {',
      '  transform-box: view-box; transform-origin: 80px 80px;',
      /* Quarter turn: the corner brackets are 90° symmetric, so 3s reads as a full
         revolution of the shape. */
      '  animation: hdd-mark-turn 3s linear infinite;',
      '}',
      '[data-hdd-mark-scope] #hddFairySclera,',
      '[data-hdd-mark-scope] #hddFairyIrisOuter,',
      '[data-hdd-mark-scope] #hddFairyIrisBlue,',
      '[data-hdd-mark-scope] #hddFairyPupil,',
      '[data-hdd-mark-scope] #hddFairyHighlight {',
      '  transform-box: view-box; transform-origin: 80px 80px;',
      '  animation-duration: 1.5s; animation-iteration-count: infinite;',
      '  animation-timing-function: cubic-bezier(0.72, 0, 0.28, 1);',
      '}',
      /* Negative delays start each layer part-way through its own cycle, which is
         what produces the nested, slightly lagging contract instead of one pulse. */
      '[data-hdd-mark-scope] #hddFairySclera { animation-name: hdd-mark-sclera; }',
      '[data-hdd-mark-scope] #hddFairyIrisOuter { animation-name: hdd-mark-iris-outer; animation-delay: -47ms; }',
      '[data-hdd-mark-scope] #hddFairyIrisBlue { animation-name: hdd-mark-iris-blue; animation-delay: -94ms; }',
      '[data-hdd-mark-scope] #hddFairyHighlight { animation-name: hdd-mark-iris-blue; animation-delay: -94ms; }',
      '[data-hdd-mark-scope] #hddFairyPupil { animation-name: hdd-mark-pupil; animation-delay: -188ms; }',
      '@keyframes hdd-mark-turn { from { transform: rotate(0deg); } to { transform: rotate(90deg); } }',
      '@keyframes hdd-mark-sclera { 0%, 100% { transform: scale(0.985); } 50% { transform: scale(0.91); } }',
      '@keyframes hdd-mark-iris-outer { 0%, 100% { transform: scale(1); } 50% { transform: scale(0.90); } }',
      '@keyframes hdd-mark-iris-blue { 0%, 100% { transform: scale(1); } 50% { transform: scale(0.87); } }',
      '@keyframes hdd-mark-pupil { 0%, 100% { transform: scale(1); } 50% { transform: scale(0.85); } }',

      /* The stage is the drawing's box; the bloom, the ripple and the slices all
         position against it. */
      '[data-hdd-mark-stage] { position: relative; }',
      '[data-hdd-mark-whole] { position: absolute; inset: 0; }',
      '[data-hdd-mark-stage] svg, [data-hdd-mark-whole] svg, [data-hdd-mark-band] svg {',
      '  width: 100%; height: 100%; display: block;',
      '}',
      /* The bloom gives off light instead of drawing a frame, so it is a radial
         gradient measured from the inscribed circle (`closest-side`); the default
         radial sizing measures to the farthest CORNER and pushes the fade outside
         the element. */
      '[data-hdd-mark-bloom] {',
      '  position: absolute; inset: -14%; border-radius: 50%;',
      '  corner-shape: round;',
      '  background: radial-gradient(circle closest-side, rgba(150, 200, 255, 0.30) 0%, rgba(80, 150, 255, 0.18) 32%, rgba(56, 116, 255, 0.07) 55%, rgba(0, 0, 0, 0) 74%);',
      '  opacity: 0.85;',
      '}',
      /* The parts that carry the "wow" — breathing light, a travelling ring, the
         tear — are gated on `data-hdd-mark-full`: the splash copy always sets it, and
         the sidebar copy sets it while the column is wide. The 30px rail copy leaves
         them off, because a 5px ring and twenty slices read as noise at that size. */
      '[data-hdd-mark-full] [data-hdd-mark-bloom] { animation: hdd-mark-bloom 3s ease-in-out infinite; }',
      /* One ring at a time, thrown outward from under the mark. The 17% inset keeps
         the ring inside the stage at full scale; `corner-shape: round` is required
         or this build draws it as a rounded square. */
      '[data-hdd-mark-full]::before {',
      "  content: ''; position: absolute; inset: 17%; border-radius: 50%;",
      '  corner-shape: round;',
      '  border: var(--hdd-mark-ring, 3px) solid rgba(236, 246, 255, 0.85);',
      '  box-shadow: 0 0 24px rgba(198, 230, 255, 0.72), inset 0 0 18px rgba(198, 230, 255, 0.5);',
      /* Visible-but-faint at rest: anything that stops the animation (reduced
         motion, a paused document) should leave light, not a hole. */
      '  opacity: 0.52;',
      '  animation: hdd-mark-ripple 3.4s ease-out infinite;',
      '}',
      /* The whole copy is always painted; the slices sit on top, invisible, and are
         switched in only for the ~86ms of the tear. */
      '[data-hdd-mark-full] [data-hdd-mark-whole] { animation: hdd-mark-whole 3.6s steps(1, end) infinite; }',
      '[data-hdd-mark-bands] { position: absolute; inset: 0; }',
      '[data-hdd-mark-band] {',
      '  position: absolute; inset: 0;',
      '  opacity: 0;',
      '  animation: hdd-mark-slice 3.6s steps(1, end) infinite, hdd-mark-slices 3.6s steps(1, end) infinite;',
      '}',
      '@keyframes hdd-mark-bloom {',
      '  0%, 100% { opacity: 0.7; transform: scale(1); }',
      '  50% { opacity: 1; transform: scale(1.06); }',
      '}',
      '@keyframes hdd-mark-ripple {',
      '  0% { transform: scale(1.02); opacity: 0.38; }',
      '  18% { opacity: 1; }',
      '  66% { opacity: 0.58; }',
      '  100% { transform: scale(1.72); opacity: 0.15; }',
      '}',
      '@keyframes hdd-mark-whole {',
      '  0%, 96% { opacity: 1; }',
      '  96.2%, 98.3% { opacity: 0; }',
      '  98.5%, 100% { opacity: 1; }',
      '}',
      '@keyframes hdd-mark-slices {',
      '  0%, 96% { opacity: 0; }',
      '  96.2%, 98.3% { opacity: 1; }',
      '  98.5%, 100% { opacity: 0; }',
      '}',
      /* The tear itself: one frame out, a partial recovery, then back. No `filter`
         here on purpose — a filtered layer inside the splash is a suspect for the
         white-sheet bug (`docs/findings-2026-10-28-white-splash.md`), and the lateral
         jump is what reads as damage anyway. */
      '@keyframes hdd-mark-slice {',
      '  0%, 96% { transform: translateX(0); }',
      '  96.2% { transform: translateX(var(--hdd-shift, 0px)); }',
      '  97.4% { transform: translateX(calc(var(--hdd-shift, 0px) * -0.35)); }',
      '  98.4%, 100% { transform: translateX(0); }',
      '}',
      /* The slices only need the picture, not its inner life: twenty copies of the
         eye animations would run for nothing. */
      '[data-hdd-mark-band] svg * { animation: none !important; }',
      '@media (prefers-reduced-motion: reduce) {',
      '  [data-hdd-mark-scope] #hddFairyCorners,',
      '  [data-hdd-mark-scope] #hddFairySclera,',
      '  [data-hdd-mark-scope] #hddFairyIrisOuter,',
      '  [data-hdd-mark-scope] #hddFairyIrisBlue,',
      '  [data-hdd-mark-scope] #hddFairyPupil,',
      '  [data-hdd-mark-scope] #hddFairyHighlight,',
      '  [data-hdd-mark-full]::before,',
      '  [data-hdd-mark-full] [data-hdd-mark-bloom],',
      '  [data-hdd-mark-full] [data-hdd-mark-whole],',
      '  [data-hdd-mark-band] { animation: none !important; }',
      '  [data-hdd-mark] { transition: none !important; }',
      '}',
      '@media (prefers-reduced-motion: reduce) {',
      '  [data-hdd-holder], [data-hdd-backdrop], div[data-hdd-splash] { transition-duration: 1ms !important; }',
      '}',
    ].join('\n')

    /* ---------------------------------------------------------------- assets */

    const info = { value: null, promise: null }

    /** Load the voice package's inventory once per page. */
    function loadInfo() {
      if (info.promise === null) {
        info.promise = fetch('/hdd/info')
          .then((response) => (response.ok ? response.json() : null))
          .then((body) => {
            info.value = body
            return body
          })
          .catch(() => null)
      }
      return info.promise
    }

    const greeting = { context: null, buffer: null, blobUrl: null, requested: false }

    /** Shared AudioContext; a refused one is simply "no decoded playback". */
    function audioContext() {
      if (greeting.context !== null) return greeting.context
      try {
        greeting.context = new AudioContext()
      } catch {
        greeting.context = null
      }
      return greeting.context
    }

    /** Fetch and decode one clip ahead of the moment it is needed. */
    function preloadGreeting(url) {
      if (greeting.requested) return Promise.resolve()
      greeting.requested = true
      return fetch(url)
        .then((response) => (response.ok ? response.arrayBuffer() : null))
        .then((bytes) => {
          if (bytes === null) return
          greeting.blobUrl = URL.createObjectURL(new Blob([bytes], { type: 'audio/mp4' }))
          const context = audioContext()
          if (context === null) return
          return new Promise((resolve) => {
            const done = (buffer) => {
              if (buffer) greeting.buffer = buffer
              resolve()
            }
            try {
              const pending = context.decodeAudioData(bytes.slice(0), done, () => done(null))
              if (pending && typeof pending.then === 'function') pending.then(done, () => done(null))
            } catch {
              done(null)
            }
          })
        })
        .catch(() => {})
    }

    /**
     * Start the greeting.
     * @returns a promise for "playback finished or gave up", never rejected.
     */
    function playGreeting() {
      const context = audioContext()
      if (greeting.buffer !== null && context !== null) {
        const node = context.createBufferSource()
        node.buffer = greeting.buffer
        node.connect(context.destination)
        node.start(context.currentTime + 0.02)
        const seconds = greeting.buffer.duration
        return new Promise((resolve) => window.setTimeout(resolve, Math.max(0, seconds) * 1000))
      }
      if (greeting.blobUrl !== null) {
        const element = new Audio(greeting.blobUrl)
        element.volume = 0.85
        const playback = element.play()
        if (playback && typeof playback.then === 'function') {
          return playback.then(
            () => new Promise((resolve) => {
              element.addEventListener('ended', () => resolve(), { once: true })
              window.setTimeout(resolve, 8000)
            }),
            () => undefined,
          )
        }
      }
      return Promise.resolve()
    }

    /* --------------------------------------------------------------- emblem */

    /* The mark's motion, ported from the reference skin. It is not one animation
       but four layered ones, and the interesting part is the tear:

         - the whole vector is always drawn once (`[data-hdd-mark-whole]`), so it can
           never show a seam;
         - the same vector is drawn again as 20 horizontal slices
           (`[data-hdd-mark-band]`), each clipped to its own band and invisible
           except for ~2% of a 3.6s cycle;
         - when that window opens every slice jumps sideways AT THE SAME INSTANT,
           each by its own fixed offset, which is what reads as a shatter. Staggering
           the slices turns it into a travelling wave instead, so there is no delay.

       Sizes come from the reference: 20 bands over the rendered height, ~86ms of
       visible tear, and a 0.7px overlap on every band because abutting percentage
       clips leave hairline seams that show as bright bars across the ring. */
    const MASCOT_BANDS = 20
    const MASCOT_SHIFTS = [0, -22, 11, -13, 25, -7, 16, -25, 5, -16, 20, -11, 9, -20, 14, -5, 23, -14, 7, -27]

    /** The 20 slices that only exist for the tear. */
    function bandMarkup() {
      const bands = []
      for (let index = 0; index < MASCOT_BANDS; index += 1) {
        const top = (index * 100) / MASCOT_BANDS
        const bottom = ((MASCOT_BANDS - 1 - index) * 100) / MASCOT_BANDS
        const shift = MASCOT_SHIFTS[index % MASCOT_SHIFTS.length]
        bands.push(
          `<div data-hdd-mark-band style="--hdd-shift:${shift}px;clip-path:inset(calc(${top}% - 0.7px) 0 calc(${bottom}% - 0.7px) 0)">${FAIRY_EMBLEM}</div>`,
        )
      }
      return bands.join('')
    }

    /**
     * Mark markup shared by the sidebar seat and the launch splash.
     *
     * `full` turns on the layers that only read at size: the pulsing bloom behind
     * the mark, the travelling ripple ring (a stage pseudo-element, so no extra
     * node) and the twenty tear slices. The 30px rail copy leaves them off, since a
     * 5px ring and twenty slices of a 30px drawing read as noise.
     */
    function fairyMarkup(options) {
      const full = options.full === true
      const size = options.size
      return '<div data-hdd-mark-scope="true" data-hdd-mark-stage="true"'
        + (full ? ' data-hdd-mark-full="true"' : '')
        + ` style="width:${size};height:${size}">`
        + '<span data-hdd-mark-bloom="true"></span>'
        + `<div data-hdd-mark-whole="true">${FAIRY_EMBLEM}</div>`
        + (full ? `<div data-hdd-mark-bands="true">${bandMarkup()}</div>` : '')
        + '</div>'
    }

    /**
     * The seat in the sidebar foot.
     *
     * The slot hands every action its owner props, and the only one there is `wide`
     * (`false` while the sidebar renders as its 56px rail). So the size follows the
     * sidebar's own state directly — no media query, no ResizeObserver, and no frame
     * where the drawing is still the old size after the sidebar has moved.
     */
    function Mark(props) {
      const wide = !(props !== null && props !== undefined && props.wide === false)
      return h('div', {
        'data-hdd-mark': 'true',
        'data-rail': wide ? 'false' : 'true',
        'aria-hidden': 'true',
        /* The wide seat gets the full treatment — that is where the reference skin's
           presence comes from. The 30px rail copy keeps only the vector's own
           motion. */
        dangerouslySetInnerHTML: { __html: fairyMarkup({ size: '100%', full: wide }) },
      })
    }

    /** The time-of-day bucket the current local hour falls into. */
    function bucketOf(inventory) {
      const hour = new Date().getHours()
      const match = (inventory.buckets || []).find((item) => hour >= item.from && hour < item.to)
      return match === undefined ? 'morning' : match.id
    }

    /* ---------------------------------------------------------------- splash */


    /** Emblem markup for the imperative splash; the sidebar mark renders via React. */
    function emblemMarkup(size) {
      return fairyMarkup({ size, full: true })
    }

    /**
     * Mount the launch splash **into `document.body`**, outside every slot.
     *
     * Two conditions made this window paint as one white sheet
     * (`docs/findings-2026-10-28-white-splash.md`):
     *
     *   - a playing `<video>` that owns a compositing quad, even a 2x2 one: the
     *     decoded frames are promoted to a window-sized white plane, so the clip
     *     is decoded and heard but never seen;
     *   - an opacity-animated full-screen layer whose child canvas is painted from
     *     those frames.
     *
     * The splash therefore keeps the video element out of the document, samples it
     * into a canvas, and never animates the opacity of the layer holding that
     * canvas.
     */
    function mountSplash() {
      if (typeof document === 'undefined' || typeof document.body === 'undefined') return
      if (window.__hddVisualApplied === true) {
        report('splash-skip', { reason: 'module re-applied in this document' })
        return
      }
      window.__hddVisualApplied = true
      window.__hddSplashShown = true

      const root = document.createElement('div')
      root.setAttribute(SPLASH_ATTR, 'true')
      root.setAttribute('data-phase', 'in')

      const video = document.createElement('video')
      video.setAttribute('data-hdd-video', 'true')
      video.autoplay = true
      video.playsInline = true
      video.preload = 'auto'

      const backdrop = document.createElement('div')
      backdrop.setAttribute('data-hdd-backdrop', 'true')

      const canvas = document.createElement('canvas')
      canvas.setAttribute('data-hdd-video-canvas', 'true')

      const field = document.createElement('div')
      field.setAttribute('data-hdd-field', 'true')

      const holder = document.createElement('div')
      holder.setAttribute('data-hdd-holder', 'true')
      holder.innerHTML = emblemMarkup('100%')

      const hint = document.createElement('div')
      hint.setAttribute('data-hdd-hint', 'true')

      /* Mounted on <html>, not on <body>: the web shell boots by watching its own
         document and only leaves the boot layout (`html{display:grid}` + a white
         `body`) once body looks stable. A splash element parked inside body keeps
         it in that state for the whole splash, and the interface then shows as a
         narrow column — see `docs/findings-2026-10-28-white-splash.md`. */
      document.documentElement.appendChild(root)
      document.documentElement.setAttribute(SPLASH_ATTR, 'true')
      report('splash-start', { perf: typeof performance === 'object' ? Math.round(performance.now()) : -1 })

      let disposed = false
      const timers = []
      const after = (ms, run) => {
        timers.push(window.setTimeout(() => {
          if (!disposed) run()
        }, ms))
      }

      /* Exactly one backstop at a time: two of them once raced, the earlier one
         firing 130 ms after a 14.7 s animation and tearing the splash down. */
      let backstopTimer
      const backstop = (ms) => {
        if (backstopTimer !== undefined) window.clearTimeout(backstopTimer)
        backstopTimer = window.setTimeout(() => {
          if (!disposed) cleanup()
        }, ms)
        timers.push(backstopTimer)
      }

      const cleanup = () => {
        if (disposed) return
        disposed = true
        for (const timer of timers) window.clearTimeout(timer)
        document.documentElement.removeAttribute(SPLASH_ATTR)
        root.remove()
        if (typeof paintStop === 'function') paintStop()
        try {
          video.pause()
          video.removeAttribute('src')
          video.load()
        } catch {
          /* the node is being discarded */
        }
        report('splash-end')
      }

      const finish = () => {
        root.setAttribute('data-phase', 'leaving')
        after(TIMING.fadeOut, cleanup)
      }

      /* Give the window back to the application. The splash owns a full-bleed
         background and the canvas still holds the animation's last frame; leaving
         either in place makes every fade end in our own dark rectangle instead of
         the loaded shell behind it. */
      const revealApp = () => {
        /* Attribute, not an inline colour: the transition lives in the stylesheet.
           Reverting is a one-line change back to `root.style.backgroundColor`. */
        root.setAttribute('data-clear', 'true')
        if (canvas.parentNode !== null && canvas.parentNode !== undefined) canvas.remove()
      }

      /* Is the shell laid out yet? `body` is a grid item of the boot layout until
         the web shell leaves it, so it only fills the window once the shell is up. */
      const shellIsWhole = () => {
        try {
          return document.body.getBoundingClientRect().width >= window.innerWidth - 1
        } catch {
          return true
        }
      }

      const revealWhenHealthy = (onHealthy, onGiveUp) => {
        let ticks = 0
        const check = () => {
          if (disposed) return
          if (shellIsWhole()) {
            onHealthy()
            return
          }
          if (ticks >= 8) {
            onGiveUp()
            return
          }
          ticks += 1
          /* Some shells only re-measure on a resize; ask once per tick. */
          try {
            window.dispatchEvent(new Event('resize'))
          } catch {
            /* ignore */
          }
          after(200, check)
        }
        check()
      }

      let flew = false
      const flyAway = () => {
        if (disposed || flew) return
        flew = true
        revealApp()
        root.setAttribute('data-phase', 'gather')
        holder.style.transition = `transform ${TIMING.gather}ms cubic-bezier(0.72, 0, 0.28, 1)`
        holder.style.transform = 'scale(0.86)'
        after(TIMING.gather, () => {
          const seat = document.querySelector('[data-hdd-mark]')
          if (seat === null) {
            finish()
            return
          }
          const from = holder.getBoundingClientRect()
          const to = seat.getBoundingClientRect()
          /* `offsetWidth` is the layout width; a rect already includes the gather
             scale and would land the emblem too large. */
          const scale = to.width > 0 && holder.offsetWidth > 0 ? to.width / holder.offsetWidth : 0.1
          const shiftX = to.left + to.width / 2 - (from.left + from.width / 2)
          const shiftY = to.top + to.height / 2 - (from.top + from.height / 2)
          root.setAttribute('data-phase', 'flying')
          holder.style.transition = `transform ${TIMING.fly}ms cubic-bezier(0.32, 0, 0.24, 1)`
          holder.style.transform = `translate(${shiftX}px, ${shiftY}px) scale(${scale})`
          after(TIMING.fly, finish)
        })
      }

      backstop(TIMING.infoTimeout)

      /**
       * Paint decoded frames onto the canvas, one per animation frame.
       *
       * `drawImage` reads the decoded surface directly, so it is unaffected by the
       * overlay problem that makes the element itself invisible-but-white.
       * The first successful frame is sampled and reported: a dark sample proves
       * pixels exist, which separates "decode is broken" from "paint is broken".
       */
      let paintStop
      const startPainting = () => {
        const context = canvas.getContext('2d')
        if (context === null) {
          report('canvas-missing-context', {})
          return
        }
        let sampled = false
        const draw = () => {
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
            if (!sampled) {
              sampled = true
              try {
                const pixel = context.getImageData(
                  Math.floor(width / 2), Math.floor(height / 2), 1, 1,
                ).data
                report('canvas-sample', {
                  canvas: { w: width, h: height },
                  rgb: [pixel[0], pixel[1], pixel[2], pixel[3]],
                  style: {
                    present: document.querySelector('style[data-hdd-visual]') !== null,
                    background: window.getComputedStyle(root).backgroundColor,
                    opacity: window.getComputedStyle(root).opacity,
                    zIndex: window.getComputedStyle(root).zIndex,
                  },
                })
              } catch (error) {
                report('canvas-sample-failed', { error: String(error).slice(0, 120) })
              }
            }
          }
          paintStop = window.requestAnimationFrame(draw)
        }
        paintStop = window.requestAnimationFrame(draw)
      }

      const greetingReady = (async () => {
        const inventory = await loadInfo()
        if (inventory === null) return { inventory: null, greeting: null }
        const bucket = bucketOf(inventory)
        report('assets', { backdrop: inventory.backdrop, video: inventory.video, bucket })
        const picked = await fetch(`/hdd/greeting?bucket=${encodeURIComponent(bucket)}`)
          .then((response) => (response.ok ? response.json() : null))
          .catch(() => null)
        if (picked === null || picked.url === null) {
          report('greeting-missing', picked)
          return { inventory, greeting: null }
        }
        report('greeting-picked', { file: picked.file, bucket, fallback: picked.fallback })
        await preloadGreeting(picked.url)
        return { inventory, greeting: picked }
      })()

      const beginEmblem = () => {
        after(60, () => holder.setAttribute('data-on', 'true'))
        after(TIMING.emblemIn, () => root.setAttribute('data-phase', 'held'))
      }

      void greetingReady.then(async ({ inventory, greeting }) => {
        if (disposed) return
        if (inventory === null) {
          report('assets-missing', { reason: 'hdd-voice package not answering /hdd/info' })
          hint.textContent = '语音包未安装：开屏只显示徽记。'
          root.appendChild(hint)
        } else if (typeof inventory.video === 'string' && inventory.video !== '') {
          video.src = `/hdd/asset?path=${encodeURIComponent(inventory.video)}`
          /* The video element stays out of the document: a playing video with a
             compositing quad is what promotes to the white overlay plane on this
             build (probe P2/P5), while a detached one that is only sampled by the
             canvas keeps the window painting normally (probe P4). */
          root.appendChild(canvas)
          report('video-start', { file: inventory.video })
          startPainting()
          backstop(TIMING.videoMaxMs + 15000)
          const startedAt = typeof performance === 'object' ? performance.now() : Date.now()
          const reason = await new Promise((resolve) => {
            let settled = false
            const settle = (why) => {
              if (settled) return
              settled = true
              resolve(why)
            }
            video.addEventListener('ended', () => settle('ended'), { once: true })
            video.addEventListener('error', () => settle('error'), { once: true })
            /* Cut at the white-to-black boundary instead of waiting for the tail. */
            const onTime = () => {
              if (video.currentTime >= TIMING.videoEndS) {
                video.pause()
                settle('cut')
              }
            }
            video.addEventListener('timeupdate', onTime)
            after(TIMING.videoMaxMs, () => settle('timeout'))
            after(1200, () => {
              const rect = video.getBoundingClientRect()
              report('video-state', {
                readyState: video.readyState,
                width: video.videoWidth,
                height: video.videoHeight,
                currentTime: Math.round(video.currentTime * 100) / 100,
                paused: video.paused,
                muted: video.muted,
                error: video.error === null || video.error === undefined ? null : video.error.code,
                rect: { w: Math.round(rect.width), h: Math.round(rect.height) },
              })
            })
            const playback = video.play()
            if (playback && typeof playback.catch === 'function') {
              playback.catch(() => {
                video.muted = true
                void video.play()?.catch?.(() => {})
              })
            }
          })
          if (disposed) return
          const now = typeof performance === 'object' ? performance.now() : Date.now()
          report('video-end', { reason, elapsedMs: Math.round(now - startedAt) })
          /* The clip is over: the last painted frame stays on the canvas, and the
             loop stops. Keeping it running means a full-screen 1920x1080
             `drawImage` every frame for the rest of the splash, which starves the
             shell's own deferred layout work — the reason the application only
             re-measured itself when the splash was finally torn down. */
          if (typeof paintStop === 'function') {
            paintStop()
            paintStop = undefined
          }
        } else if (inventory.backdrop) {
          backdrop.style.backgroundImage = `url("/hdd/asset?path=${encodeURIComponent(inventory.backdrop)}")`
          backdrop.setAttribute('data-on', 'true')
          root.appendChild(backdrop)
        } else {
          hint.textContent = `未找到开屏动画或背景图。\n把 boot.mp4 或 boot.png 放到：\n${inventory.root}`
          root.appendChild(hint)
        }
        if (disposed) return
        /* The drawn highlight plate goes under the emblem. It fades in with the
           emblem, holds while she speaks, then fades out before the flight — the
           order the reference implementation uses. */
        const fieldName = typeof inventory.field === 'string' ? inventory.field : null
        if (fieldName !== null) {
          field.style.backgroundImage = `url("/hdd/asset?path=${encodeURIComponent(fieldName)}")`
          root.appendChild(field)
          after(30, () => field.setAttribute('data-on', 'true'))
        }
        root.appendChild(holder)
        beginEmblem()
        after(TIMING.greetingAt, () => {
          if (disposed) return
          if (greeting === null) {
            after(TIMING.holdAfter, flyAway)
            return
          }
          const spoken = playGreeting().then(() => {
            if (disposed) return
            after(TIMING.holdAfter, flyAway)
          })
          after(TIMING.maxHold, flyAway)
          void spoken
          /* With a highlight plate the flight follows the plate's fade, not the end
             of the greeting: the image is what leaves, the emblem is what stays. */
          if (fieldName !== null) {
            after(TIMING.fieldHoldMs, () => {
              /* The point of the fade is to uncover the shell, so the shell has to be
                 whole first. It is not: while the splash is up the web shell is still
                 in its boot layout (`html{display:grid}`), its body shrinks to the
                 content width and the interface shows as a narrow column. Wait for it
                 to fill the window; if it will not, keep the plate opaque and let the
                 hard cut at cleanup do the job — never uncover a half-built shell. */
              revealWhenHealthy(
                () => {
                  revealApp()
                  field.setAttribute('data-on', 'false')
                  after(TIMING.fieldOutMs, flyAway)
                },
                () => {
                  report('reveal-skipped', { reason: 'shell narrower than the window' })
                  field.setAttribute('data-on', 'false')
                  after(TIMING.fieldOutMs, flyAway)
                },
              )
            })
          }
        })
      })
    }

    /* ------------------------------------------------------------------ cues */

    function installCues(ctx) {
      let seq = 0
      let timer = undefined
      let playing = null

      const playCue = (kind) => {
        const inventory = info.value
        if (inventory === null || inventory.cues === undefined) return
        const file = inventory.cues[kind]
        if (file === undefined || file === null) return
        if (playing !== null && playing.paused === false) return
        const element = new Audio(`/hdd/asset?path=${encodeURIComponent(`cue/${file}`)}`)
        element.volume = CUE_VOLUME
        playing = element
        const playback = element.play()
        if (playback && typeof playback.catch === 'function') playback.catch(() => {})
      }

      const poll = async () => {
        if (document.visibilityState === 'hidden') return
        try {
          const response = await fetch(`/hdd/cue?since=${seq}`)
          if (!response.ok) return
          const body = await response.json()
          if (typeof body.seq === 'number') seq = body.seq
          for (const cue of body.cues || []) {
            if (cue.kind === 'thinking' || cue.kind === 'done' || cue.kind === 'failed') playCue(cue.kind)
          }
        } catch {
          /* A missing voice package is a normal state, not an error worth surfacing. */
        }
      }

      const start = () => {
        if (timer !== undefined) return
        timer = window.setInterval(() => {
          void poll()
        }, CUE_POLL_MS)
      }
      const stop = () => {
        if (timer === undefined) return
        window.clearInterval(timer)
        timer = undefined
      }

      const onVisibility = () => {
        if (document.visibilityState === 'hidden') stop()
        else start()
      }

      start()
      document.addEventListener('visibilitychange', onVisibility)
      ctx.effect(
        () => () => {
          stop()
          document.removeEventListener('visibilitychange', onVisibility)
          if (playing !== null) {
            try {
              playing.pause()
            } catch {
              /* Nothing to do: the element is being discarded anyway. */
            }
          }
        },
        'hdd-visual cue-poll',
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        report('apply')
        ctx.effect(() => {
          const style = document.createElement('style')
          style.setAttribute('data-hdd-visual', '')
          style.textContent = CSS
          document.head.appendChild(style)
          /* A <style> inserted into <head> is also the signal the Desktop preload
             listens for to re-measure native caption colours; no action needed. */
          return () => style.remove()
        }, 'hdd-visual stylesheet')

        void loadInfo()
        installCues(ctx)

        /* The splash is mounted into <html>, not into a slot: see mountSplash. */
        mountSplash()
        ctx.slots.inject('sidebar.footer.action', () =>
          ctx.slots.register(
            { name: 'sidebar.footer.action', id: 'hdd-mark', order: 60, label: 'Fairy' },
            Mark,
          ),
        )
      },
    }
  },
})
