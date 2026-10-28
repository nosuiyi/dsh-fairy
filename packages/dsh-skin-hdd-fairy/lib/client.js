/**
 * Client half of `dsh-skin-hdd-fairy` — a DSH skin with a launch splash, a living
 * vector mark and a cue player, managed by the Skin Manager.
 *
 * Four rules shape this file:
 *
 *   1. Slots are taken additively. `sidebar.footer.action` is a `list` seat, so this
 *      skin never competes with the official rows that occupy the `single` seats
 *      (`sidebar.brand.mark` / `.name` / `sidebar.toggle.badge`).
 *   2. The skin announces itself with an attribute on `<body>` (`data-dsh-hdd-fairy`),
 *      never on `<html>`: a bare `[data-…]` selector would then match the document
 *      itself and collapse the application (see
 *      `docs/findings-2026-10-28-narrow-window.md`).
 *   3. Every failure degrades to "less splash", never to "no shell": missing
 *      assets, a missing voice package, a refused AudioContext and a failed route
 *      each have a silent path out.
 *   4. The manager owns persistence and the enabled/disabled row; this file owns
 *      every side effect it creates and releases them in `apply(null)`.
 */
window.__ModuleLoader__.load({
  id: 'dsh-skin-hdd-fairy',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** Set on <html> while the splash owns the screen; hides the sidebar emblem. */
    const SPLASH_ATTR = 'data-hdd-splash'

    /** The skin's identity attribute, carried by <body> while this skin is active. */
    const BODY_ATTR = 'data-dsh-hdd-fairy'

    /** `skin.json#id`; the manager keys stored values by it. */
    const SKIN_ID = 'hdd-fairy'

    /* ------------------------------------------------- skin customization v2 */
    /*
     * The manager is not a runtime dependency: the seam is three window events
     * (`dsh:skin-customization-*-v2`) carrying a definition object. Registering
     * twice is how the ready handshake works — the manager broadcasts `ready` after
     * it mounts, and every skin re-announces itself, so load order never matters.
     */
    const CUSTOMIZATION_EVENTS = {
      register: 'dsh:skin-customization-register-v2',
      unregister: 'dsh:skin-customization-unregister-v2',
      ready: 'dsh:skin-customization-ready-v2',
    }

    /** Live values of the settings this skin exposes. */
    const settings = {
      splash: true,
      /* The shipped default is no splash at all: the skin opens straight into
         the interface, and the sidebar mark / palette / brand seats are all the
         identity a first launch needs. `auto` is one select away for anyone who
         drops a clip in. */
      splashSource: 'none',
      /** 0 = play the user's clip to its end; >0 = cut there. */
      animEndS: 0,
      voice: true,
      cues: true,
      markSize: 60,
      markGlow: true,
    }

    /** Handle of the running cue poller, so a settings change can stop it. */
    let cues = null

    /**
     * Push the geometry settings that can change while the skin runs.
     *
     * The size travels through one custom property on <body>, which the mark reads;
     * it is a *variable* rather than an inline width because the seat also has a rail
     * size and a transition, and those belong to the stylesheet.
     */
    function applyMarkStyle() {
      if (typeof document === 'undefined' || document.body === null) return
      document.body.style.setProperty('--hdd-mark-size-setting', `${settings.markSize}px`)
      document.body.setAttribute('data-hdd-mark-glow', settings.markGlow ? 'on' : 'off')
    }

    function registerCustomization(definition) {
      const token = {}
      const announce = () => {
        window.dispatchEvent(new CustomEvent(CUSTOMIZATION_EVENTS.register, {
          detail: { token, definition },
        }))
      }
      window.addEventListener(CUSTOMIZATION_EVENTS.ready, announce)
      announce()
      return () => {
        window.removeEventListener(CUSTOMIZATION_EVENTS.ready, announce)
        window.dispatchEvent(new CustomEvent(CUSTOMIZATION_EVENTS.unregister, {
          detail: { token, definition },
        }))
        definition.apply(null)
      }
    }

    /**
     * `state === null` means "release everything this skin owns"; the manager calls
     * it when the skin is switched away from or unregistered. Idempotent by design.
     */
    function applySkinState(state) {
      const next = state === null || state === undefined ? {} : (state.values ?? {})
      settings.splash = next.splash !== false
      settings.voice = next.voice !== false
      settings.cues = next.cues !== false
      settings.markGlow = next.markGlow !== false
      settings.markSize = typeof next.markSize === 'number' && Number.isFinite(next.markSize)
        ? Math.min(96, Math.max(32, Math.round(next.markSize)))
        : 60
      /* Three sources: `auto` (clip when present, else the backdrop canvas),
         `novideo` (never play the clip; the backdrop stays available as the canvas) and
         `none` (no splash at all — straight into the shell). `mark` was this option's
         old value and folds into `novideo`, so a stored setting keeps working. */
      const source = next.splashSource === 'mark' ? 'novideo' : next.splashSource
      settings.splashSource = source === 'novideo' || source === 'none' ? source : 'auto'
      /* 0 is a real value here ("no cut"), so it must survive the numeric parse. */
      settings.animEndS = typeof next.animEndS === 'number' && Number.isFinite(next.animEndS) && next.animEndS > 0
        ? Math.min(120, next.animEndS)
        : 0
      applyMarkStyle()
      if (cues !== null) {
        if (settings.cues) cues.start()
        else cues.stop()
      }
    }

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
       * Default cut point, in seconds; `0` means "play the clip to its end".
       *
       * The reference clip's tail is a fade to black, which the reference skin cut at
       * 12.9 s (measured with `blackdetect`). A shipped skin cannot know that about a
       * clip the user supplies, so the default is 0 and the cut is a setting
       * (`animEndS`): the user decides where their own animation stops.
       */
      videoEndS: 0,
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
      const body = JSON.stringify({
        event,
        detail: detail === undefined ? null : detail,
        perf: typeof performance === 'object' ? Math.round(performance.now()) : -1,
        visibility: typeof document === 'object' ? document.visibilityState : '?',
      })
      /* On a fresh start the client can run before the Host half has registered
         `/hdd/report`; those first lines (apply, skin-classes, assets) then 404 and
         vanish, which makes a healthy boot look like a silent one. Retry twice. */
      const send = (attempt) => {
        try {
          void fetch('/hdd/report', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body,
          }).then((response) => {
            if (!response.ok && attempt < 2) window.setTimeout(() => send(attempt + 1), 1200)
          }).catch(() => {})
        } catch {
          /* Diagnostics must never break the thing they observe. */
        }
      }
      send(0)
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

    /* ------------------------------------------------------------------ classes
     *
     * The shell paints its columns with CSS-module class names whose prefix is a
     * build hash (`an3WzG_root`, `mP3x-q_frame`). The hash changes between
     * releases — the reference skin was written against `Dc7zOa_*` / `BynINW_*` —
     * but the *suffix* is stable, because it comes from the module path.
     *
     * So the prefix is resolved at runtime instead of being hardcoded:
     *   1. scan the DOM for an element carrying `<prefix>_<suffix>`;
     *   2. scan `document.styleSheets` rules (the conversation bundle injects them);
     *   3. scan `<style>` text;
     *   4. fall back to the prefixes measured on 0.2.1-rc.3.
     *
     * Step 4 is why a re-hash never breaks the skin: worst case it degrades to the
     * palette-only look, and the log line `skin-classes` says which suffix was not
     * found — `tools/scan-skin-classes.mjs` then regenerates the constants.
     */
    const SKIN_SUFFIXES = ['frame', 'centerCol', 'rightbarCol', 'root', 'composerSeat', 'scrollBody', 'embeddedBody']

    /** Measured on DSH 0.2.1-rc.3 (see tools/scan-skin-classes.mjs). */
    const FALLBACK_PREFIXES = {
      'mP3x-q': ['frame', 'centerCol', 'rightbarCol'],
      'an3WzG': ['root', 'composerSeat', 'scrollBody', 'embeddedBody'],
    }

    /**
     * Resolve the build-hashed class names the panel rules need.
     * @returns `{ classes, source, missing }`; `source` is `live` when every suffix
     *   came from the page, `fallback` when at least one came from the constants.
     */
    function resolveSkinClasses() {
      const found = {}
      const want = new Set(SKIN_SUFFIXES)
      /* One prefix can be *seen* for a suffix without being the right module: five
         different bundles ship a `_frame` in this build. Counting how often each
         prefix/suffix pair appears — every class the module actually renders shows up
         at least once per element and once per rule — keeps the busiest prefix, which
         is the module the skin means. */
      const tally = {}
      const take = (name) => {
        const match = /^([A-Za-z0-9-]{4,10})_([A-Za-z][A-Za-z0-9-]*)$/.exec(name)
        if (match === null || !want.has(match[2])) return
        const suffix = match[2]
        const perPrefix = tally[suffix] ?? (tally[suffix] = {})
        perPrefix[match[1]] = (perPrefix[match[1]] ?? 0) + 1
      }
      const pick = () => {
        /* A prefix that provides several of our suffixes is almost certainly the
           module we mean: the shell frame ships frame+centerCol+rightbarCol, the
           conversation panel ships root+composerSeat+scrollBody+embeddedBody. A
           prefix with a single suffix is some other bundle that happens to reuse the
           name (`hKdVjq_root` was exactly that, and pairing it with
           `an3WzG_composerSeat` produced a rule that could never match). So rank by
           coverage first and by raw frequency second. */
        const coverage = {}
        for (const suffix of SKIN_SUFFIXES) {
          for (const prefix of Object.keys(tally[suffix] ?? {})) {
            coverage[prefix] = (coverage[prefix] ?? 0) + 1
          }
        }
        for (const suffix of SKIN_SUFFIXES) {
          const perPrefix = tally[suffix]
          if (perPrefix === undefined) continue
          let bestPrefix = null
          let bestScore = -1
          for (const [prefix, count] of Object.entries(perPrefix)) {
            const score = (coverage[prefix] ?? 0) * 1000 + count
            if (score > bestScore) {
              bestScore = score
              bestPrefix = prefix
            }
          }
          if (bestPrefix !== null) found[suffix] = `${bestPrefix}_${suffix}`
        }
      }
      const remaining = () => SKIN_SUFFIXES.some((suffix) => found[suffix] === undefined)

      /* 1. DOM: cheapest and most trustworthy, but only once a transcript exists. */
      try {
        for (const element of document.querySelectorAll('[class*="_"]')) {
          const list = element.classList
          for (let index = 0; index < list.length; index += 1) take(list[index])
        }
      } catch {
        /* a hostile document is not worth failing the skin over */
      }
      pick()

      /* 2. Stylesheets, then 3. inline <style> text. */
      if (remaining()) {
        const pattern = new RegExp(`\\.([A-Za-z0-9-]{4,10})_(${SKIN_SUFFIXES.join('|')})\\b`, 'g')
        const scan = (text) => {
          if (typeof text !== 'string') return
          let match
          while ((match = pattern.exec(text)) !== null) take(`${match[1]}_${match[2]}`)
        }
        try {
          for (const sheet of Array.from(document.styleSheets)) {
            let rules
            try {
              rules = sheet.cssRules
            } catch {
              continue
            }
            for (const rule of Array.from(rules ?? [])) scan(rule.cssText)
          }
        } catch {
          /* ignore */
        }
        try {
          for (const style of document.querySelectorAll('style')) scan(style.textContent || '')
        } catch {
          /* ignore */
        }
        pick()
      }

      const missing = SKIN_SUFFIXES.filter((suffix) => found[suffix] === undefined)
      const source = missing.length === 0 ? 'live' : 'fallback'
      for (const prefix of Object.keys(FALLBACK_PREFIXES)) {
        for (const suffix of FALLBACK_PREFIXES[prefix]) {
          if (found[suffix] === undefined) found[suffix] = `${prefix}_${suffix}`
        }
      }
      return { classes: found, source, missing }
    }

    /**
     * Panel rules expressed against the resolved class names.
     *
     * Only classes that resolved are emitted, so a partially-mapped build loses the
     * texture on the affected column instead of breaking the whole sheet. Every
     * selector is scoped to `body[data-dsh-hdd-fairy]`, which keeps the release path
     * (`apply(null)`) working without touching any stylesheet.
     */
    function buildPanelCss(classes) {
      const scope = 'body[data-dsh-hdd-fairy] '
      const has = (...names) => names.every((name) => classes[name] !== undefined)
      const rules = []

      /* Columns clear their own fill so the substrate painted on <html> shows. */
      if (has('frame', 'centerCol')) {
        rules.push(`${scope}.${classes.frame}, ${scope}.${classes.centerCol} { background: transparent !important; }`)
      }

      /* One surface, one mechanism: the veil, the 48px grid and the vignette are
         drawn on the panel only; everything nested inside is cleared to show it. */
      if (has('root', 'embeddedBody', 'rightbarCol')) {
        rules.push([
          `${scope}.${classes.root}, ${scope}.${classes.embeddedBody}, ${scope}.${classes.rightbarCol} {`,
          '  background-color: var(--hdd-panel-veil) !important;',
          '  background-image:',
          '    radial-gradient(130% 100% at 50% 45%, rgba(0, 0, 0, 0) 55%, rgba(4, 10, 20, var(--hdd-fx-vignette)) 100%),',
          '    linear-gradient(var(--hdd-grid-color-veiled) 1.5px, transparent 1.5px),',
          '    linear-gradient(90deg, var(--hdd-grid-color-veiled) 1.5px, transparent 1.5px) !important;',
          '  background-size: auto, 48px 48px, 48px 48px !important;',
          '  background-repeat: no-repeat, repeat, repeat !important;',
          '  background-attachment: scroll, fixed, fixed !important;',
          '  background-position: 0 0, 0 0, 0 0 !important;',
          '}',
        ].join('\n'))
      }

      if (has('centerCol')) {
        rules.push(`${scope}.${classes.centerCol} { box-shadow: inset 1px 0 0 var(--hdd-divider) !important; }`)
      }

      /* The composer seat hides whatever scrolls under it with a gradient in its own
         background. Clearing that removes the fade, so transcript text shows through;
         the plate therefore moves to a pseudo element and the grid is painted on top
         of it, with a mask fading the plate's top edge into the transcript. */
      if (has('root', 'composerSeat', 'embeddedBody')) {
        const root = `${scope}.${classes.root}[data-phase="active"]`
        const embedded = `${scope}.${classes.embeddedBody}[data-content-phase="active"]`
        rules.push(`${root} .${classes.composerSeat}, ${embedded} .${classes.composerSeat} { background: none !important; }`)
        rules.push([
          `${root} .${classes.composerSeat}::after, ${embedded} .${classes.composerSeat}::after {`,
          "  content: ''; position: absolute; inset: 0; z-index: -1; pointer-events: none;",
          '  background-color: rgba(7, 16, 28, 0.94);',
          '  background-image:',
          '    linear-gradient(var(--hdd-grid-color-veiled) 1.5px, rgba(0, 0, 0, 0) 1.5px),',
          '    linear-gradient(90deg, var(--hdd-grid-color-veiled) 1.5px, rgba(0, 0, 0, 0) 1.5px);',
          '  background-size: 48px 48px, 48px 48px;',
          '  background-repeat: repeat, repeat;',
          '  background-attachment: fixed, fixed;',
          '  background-position: 0 0, 0 0;',
          '  -webkit-mask-image: linear-gradient(180deg, rgba(0, 0, 0, 0) 0px, #000 40px);',
          '  mask-image: linear-gradient(180deg, rgba(0, 0, 0, 0) 0px, #000 40px);',
          '}',
        ].join('\n'))
      }

      /* The transcript's scrollbar is the last thing on screen that is not part of
         the surface, so it is removed outright; the gutter goes with it, otherwise an
         empty band stays down the right edge. */
      if (has('scrollBody')) {
        rules.push(`${scope}.${classes.scrollBody} { scrollbar-width: none !important; scrollbar-gutter: auto !important; }`)
        rules.push(`${scope}.${classes.scrollBody}::-webkit-scrollbar { width: 0 !important; height: 0 !important; display: none !important; }`)
      }

      return rules.join('\n')
    }

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
      /* The manager can change this at runtime; it writes `--hdd-mark-size-setting`
         on <body>, and the fallback here is the default 60px. */
      '  --hdd-mark-size: var(--hdd-mark-size-setting, 60px);',
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
      /* "Mark glow" off — written on <body> by the manager's setting. The mark itself
         stays fully visible; only the light around it, the travel of the ring and the
         periodic tear go away. */
      'body[data-hdd-mark-glow="off"] [data-hdd-mark-bloom] { animation: none !important; opacity: 0 !important; }',
      'body[data-hdd-mark-glow="off"] [data-hdd-mark-stage]::before { animation: none !important; opacity: 0 !important; }',
      'body[data-hdd-mark-glow="off"] [data-hdd-mark-whole] { animation: none !important; opacity: 1 !important; }',
      'body[data-hdd-mark-glow="off"] [data-hdd-mark-band] { display: none !important; }',
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
      /* Every transition the skin owns, not just the ones on the splash layer: the
         plate fade, the backdrop and the reveal dissolve are all motion. */
      '  [data-hdd-holder], [data-hdd-backdrop], [data-hdd-field], div[data-hdd-splash],',
      '  div[data-hdd-splash][data-clear="true"] { transition-duration: 1ms !important; }',
      '}',
    ].join('\n')

    /**
     * The interface skin: palette, substrate, type and scrollbars.
     *
     * Ported from the reference HDD skin, with two adaptations:
     *
     *   - everything is scoped to `body[data-dsh-hdd-fairy]` (or
     *     `html:has(> body[data-dsh-hdd-fairy])` for the document root). The
     *     reference could write bare `:root`/`html` rules because its bundle
     *     unloads with the skin; scoping here keeps a stale sheet from ever
     *     touching a page it does not own, which is exactly the mistake behind
     *     `docs/findings-2026-10-28-narrow-window.md`;
     *   - the reference's substrate rules name hashed CSS-module classes
     *     (`.BynINW_frame`, `.Dc7zOa_root`, …). Those hashes are generated at
     *     runtime and are *absent* from this build (checked against the shipped
     *     CSS and JS), so those rules are not ported: the grid texture will only
     *     appear once the real container selectors are known. The palette below
     *     still reaches the sidebar and the header through the tokens they read.
     */
    const SKIN_CSS = [
      /* ---- palette ----
         Declared on the root (via :has, because the marker lives on body) and on
         body itself: the application declares its own palette on body, and a
         body-level declaration cannot be overridden from :root. */
      'html:has(> body[data-dsh-hdd-fairy]), body[data-dsh-hdd-fairy] {',
      '  color-scheme: dark;',
      '  --hdd-base: #07101c;',
      '  --hdd-grid-color: rgba(100, 210, 255, 0.075);',
      '  --hdd-glow-a: rgba(96, 212, 255, 0.17);',
      '  --hdd-glow-a-fade: rgba(54, 184, 255, 0.085);',
      '  --hdd-glow-b: rgba(157, 132, 255, 0.14);',
      '  --hdd-glow-b-fade: rgba(119, 91, 255, 0.07);',
      '  --hdd-glow-c: rgba(174, 112, 255, 0.14);',
      '  --hdd-glow-c-fade: rgba(143, 94, 255, 0.07);',
      '  --hdd-cyan: #62d4ff;',
      '  --hdd-chip-bg: rgba(10, 24, 40, 0.72);',
      '  --hdd-chip-fg: #cfe8f7;',
      '  --hdd-chip-border: rgba(126, 220, 255, 0.30);',
      '  --hdd-divider: rgba(126, 220, 255, 0.10);',
      '  --hdd-grid-color-veiled: rgba(100, 210, 255, 0.044);',
      '  --hdd-fx-vignette: 0.5;',
      '  --hdd-panel-veil: rgba(10, 24, 40, 0.42);',
      '  --dsw-alias-bg-base: #07101c !important;',
      '  --dsw-alias-bg-layer-1: #0a1828 !important;',
      '  --dsw-alias-bg-layer-2: #0e243d !important;',
      '  --dsw-alias-bg-overlay: #102944 !important;',
      '  --dsw-alias-border-l1: rgba(126, 220, 255, 0.30) !important;',
      '  --dsw-alias-border-l2: rgba(126, 220, 255, 0.20) !important;',
      '  --dsw-alias-brand-primary: #62d4ff !important;',
      '  --dsw-alias-label-primary: #e8f2fa !important;',
      '  --dsw-alias-label-secondary: #a8bac9 !important;',
      '  --dsw-alias-state-idle-primary: #7f93a5 !important;',
      /* The sidebar fill goes transparent so the substrate reads through it; the
         nav states take the reference's blue steps. */
      '  --dsw-specific-sidebar-fill: transparent !important;',
      '  --dsw-specific-sidebar-nav-item-hover: #0e243d !important;',
      '  --dsw-specific-sidebar-nav-item-active: #143553 !important;',
      '  --dsw-specific-sidebar-nav-item-active-accent: #267fc4 !important;',
      '  --dsw-specific-input-major: #0a1c30 !important;',
      '  --dsw-specific-menu: #0e243d !important;',
      '  --dsw-specific-selector: #0e243d !important;',
      '  --dsw-specific-bubble: #103052 !important;',
      '  --dsw-specific-tip: #0e243d !important;',
      '  --dsw-alias-button-elevated-fill: #103052 !important;',
      '  --dsw-alias-button-floating-fill: #103052 !important;',
      '  --dsw-alias-markdown-code-block: #0a1c30 !important;',
      '  --dsw-alias-markdown-code-block-banner: #0a1c30 !important;',
      '  --dsw-alias-markdown-inline-code: #103052 !important;',
      '  --dsw-alias-scrollbar-bg-l1: rgba(126, 200, 255, 0.18) !important;',
      '  --dsw-alias-scrollbar-bg-l2: rgba(126, 200, 255, 0.24) !important;',
      '  --dsw-alias-scrollbar-hover-l1: rgba(126, 200, 255, 0.34) !important;',
      '  --dsw-alias-scrollbar-hover-l2: rgba(126, 200, 255, 0.44) !important;',
      '  scrollbar-color: rgba(126, 200, 255, 0.22) transparent;',
      '}',
      /* The rail stated on the pseudo elements as well: the token path is how the
         application styles it, this is the belt to that braces, and it is also
         what colours the corner, which the tokens never reach. Track and corner
         stay transparent so the column's own surface shows through. */
      'body[data-dsh-hdd-fairy] ::-webkit-scrollbar { width: 10px; height: 10px; }',
      'body[data-dsh-hdd-fairy] ::-webkit-scrollbar-track { background: transparent !important; }',
      'body[data-dsh-hdd-fairy] ::-webkit-scrollbar-thumb {',
      '  background-color: rgba(126, 200, 255, 0.24) !important;',
      '  border: 2px solid transparent !important;',
      '  border-radius: 999px !important;',
      '  background-clip: content-box !important;',
      '}',
      'body[data-dsh-hdd-fairy] ::-webkit-scrollbar-thumb:hover { background-color: rgba(126, 200, 255, 0.46) !important; }',
      'body[data-dsh-hdd-fairy] ::-webkit-scrollbar-corner { background: transparent !important; }',
      /* The document's own scrollbar is NOT a descendant of body, so the selectors
         above never reach it — it kept the platform's light track and showed as a
         16px grey strip down the right edge of a dark window. */
      'html:has(> body[data-dsh-hdd-fairy])::-webkit-scrollbar { width: 10px; height: 10px; }',
      'html:has(> body[data-dsh-hdd-fairy])::-webkit-scrollbar-track { background: transparent !important; }',
      'html:has(> body[data-dsh-hdd-fairy])::-webkit-scrollbar-thumb {',
      '  background-color: rgba(126, 200, 255, 0.24) !important;',
      '  border: 2px solid transparent !important;',
      '  border-radius: 999px !important;',
      '  background-clip: content-box !important;',
      '}',
      'html:has(> body[data-dsh-hdd-fairy])::-webkit-scrollbar-corner { background: transparent !important; }',

      /* ---- brand seats ----
         Three single seats carry the skin's identity: the mark beside the sidebar
         title, the title itself, and the mark above a blank session's headline.
         `sidebar.brand.mark` / `sidebar.brand.name` shadow the shipped occupants
         (`replaceRisk: "shadows-shipped-ui"`), `conversation.hero.brand.mark` was
         empty. All three are disposers, so `apply(null)` hands them straight back. */
      'body[data-dsh-hdd-fairy] [data-hdd-brand-mark] {',
      '  display: block;',
      '  width: 26px; height: 26px;',
      '  flex: 0 0 auto;',
      '  pointer-events: none;',
      '}',
      'body[data-dsh-hdd-fairy] [data-hdd-brand-name] {',
      '  display: flex;',
      '  flex-direction: column;',
      '  align-items: flex-start;',
      '  justify-content: center;',
      '  gap: 2px;',
      '  min-width: 0;',
      '  line-height: 1;',
      '  text-align: left;',
      '}',
      'body[data-dsh-hdd-fairy] [data-hdd-brand-title] {',
      '  color: var(--dsw-alias-label-primary);',
      '  font-size: 16px;',
      '  font-weight: 900;',
      '  font-family: "Poppins Black", "Century Gothic", "Arial Black", "Microsoft YaHei UI", sans-serif;',
      '  letter-spacing: 0.01em;',
      '  line-height: 1.15;',
      '  white-space: nowrap;',
      '}',
      'body[data-dsh-hdd-fairy] [data-hdd-brand-sub] {',
      '  color: var(--dsw-alias-label-secondary);',
      '  font-size: 10px;',
      '  font-weight: 700;',
      '  letter-spacing: 0.01em;',
      '  line-height: 1.15;',
      '  white-space: nowrap;',
      '  overflow: hidden;',
      '  text-overflow: ellipsis;',
      '  transform: scaleX(1.06);',
      '  transform-origin: left center;',
      '}',
      'body[data-dsh-hdd-fairy] [data-hdd-hero-mark] {',
      '  display: block;',
      '  flex: 0 0 auto;',
      '  pointer-events: none;',
      '}',
      /* Fallback for the shipped wordmark. `sidebar.brand.name` is a single seat whose
         occupant ships with the shell, and a second registration does not take it in
         this build, so the wordmark is replaced in place: hide the shipped inline SVG
         and print the skin's two lines. The `:not(:has([data-hdd-brand-name]))` guard
         turns this off the moment the seat renders our own markup, so the two paths can
         never both show.
         ::before carries the title and ::after the role line, which is the order a
         column flex box paints them in. The row is given room for the second line: the
         shell sizes it for one. */
      'body[data-dsh-hdd-fairy] [data-slot="sidebar.brand.name"]:has(svg):not(:has([data-hdd-brand-name])) {',
      /* The shell's own rule for this cell sets a display too, and it wins at equal
         specificity — without `!important` the two pseudo-elements stay inline and the
         title and the role line end up side by side. */
      '  display: flex !important;',
      '  flex-direction: column !important;',
      '  align-items: flex-start !important;',
      '  justify-content: center !important;',
      '  gap: 2px !important;',
      '  line-height: 1 !important;',
      '  text-align: left !important;',
      '}',
      'body[data-dsh-hdd-fairy] [data-slot="sidebar.brand.name"]:has(svg):not(:has([data-hdd-brand-name]))::before,',
      'body[data-dsh-hdd-fairy] [data-slot="sidebar.brand.name"]:has(svg):not(:has([data-hdd-brand-name]))::after {',
      '  display: block !important;',
      '  width: 100%;',
      '}',
      'body[data-dsh-hdd-fairy] :has(> [data-slot="sidebar.brand.name"]),',
      'body[data-dsh-hdd-fairy] :has(> * > [data-slot="sidebar.brand.name"]) {',
      '  min-height: 56px;',
      '}',
      'body[data-dsh-hdd-fairy] [data-slot="sidebar.brand.name"]:has(svg):not(:has([data-hdd-brand-name])) svg {',
      '  display: none !important;',
      '}',
      'body[data-dsh-hdd-fairy] [data-slot="sidebar.brand.name"]:has(svg):not(:has([data-hdd-brand-name]))::before {',
      '  content: "Fairy";',
      '  color: var(--dsw-alias-label-primary);',
      '  font-size: 16px;',
      '  font-weight: 900;',
      '  font-family: "Poppins Black", "Century Gothic", "Arial Black", "Microsoft YaHei UI", sans-serif;',
      '  letter-spacing: 0.01em;',
      '  line-height: 1.15;',
      '  white-space: nowrap;',
      '}',
      'body[data-dsh-hdd-fairy] [data-slot="sidebar.brand.name"]:has(svg):not(:has([data-hdd-brand-name]))::after {',
      '  content: "Ⅲ型总序式集成泛用人工智能";',
      '  color: var(--dsw-alias-label-secondary);',
      '  font-size: 10px;',
      '  font-weight: 700;',
      '  letter-spacing: 0.01em;',
      '  line-height: 1.15;',
      '  white-space: nowrap;',
      '  overflow: hidden;',
      '  text-overflow: ellipsis;',
      '  transform: scaleX(1.06);',
      '  transform-origin: left center;',
      '}',

      /* ---- substrate ----
         Painted by the root element, behind every column. `body` keeps the
         theme's own background, which would hide it, so that one is turned off
         here — the only host surface this skin clears without knowing its class
         names. */
      'html:has(> body[data-dsh-hdd-fairy]) {',
      '  background-color: var(--hdd-base) !important;',
      '  background-image:',
      '    radial-gradient(ellipse 50vmax 26vh at 5.4vmax 17.65vh, var(--hdd-glow-c), var(--hdd-glow-c-fade) 53%, transparent 100%),',
      '    radial-gradient(ellipse 53vmax 37vh at calc(100vw - 7.15vmax) 73.2vh, var(--hdd-glow-b), var(--hdd-glow-b-fade) 53%, transparent 100%),',
      '    radial-gradient(ellipse 56vmax 29vh at calc(100vw - 13.26vmax) 12.8vh, var(--hdd-glow-a), var(--hdd-glow-a-fade) 52%, transparent 100%),',
      '    linear-gradient(var(--hdd-grid-color) 1.5px, transparent 1.5px),',
      '    linear-gradient(90deg, var(--hdd-grid-color) 1.5px, transparent 1.5px) !important;',
      '  background-repeat: no-repeat, no-repeat, no-repeat, repeat, repeat !important;',
      '  background-size: auto, auto, auto, 48px 48px, 48px 48px !important;',
      '  background-attachment: fixed !important;',
      '}',
      'html:has(> body[data-dsh-hdd-fairy]) body {',
      '  background-color: transparent !important;',
      '  background-image: none !important;',
      '}',

      /* ---- type ----
         The game's own face (印品鸿蒙体) is licensed and deliberately not
         embedded; the heaviest condensed faces Windows ships carry the
         impression, with Chinese falling through to YaHei. */
      'body[data-dsh-hdd-fairy], body[data-dsh-hdd-fairy] button, body[data-dsh-hdd-fairy] input,',
      'body[data-dsh-hdd-fairy] textarea, body[data-dsh-hdd-fairy] select,',
      'body[data-dsh-hdd-fairy] [contenteditable="true"] {',
      '  font-family: "Bahnschrift SemiCondensed", Bahnschrift, "Arial Narrow", "Microsoft YaHei UI", "Microsoft YaHei", system-ui, sans-serif !important;',
      '  font-weight: 600 !important;',
      '  letter-spacing: -0.004em !important;',
      '}',
      'body[data-dsh-hdd-fairy] button, body[data-dsh-hdd-fairy] [role="button"],',
      'body[data-dsh-hdd-fairy] [role="tab"], body[data-dsh-hdd-fairy] [role="menuitem"],',
      'body[data-dsh-hdd-fairy] summary {',
      '  font-weight: 800 !important;',
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
      /* The manager can switch the greeting off; the splash then simply holds for
         `holdAfter` and flies, which is the same path as "no greeting available". */
      if (settings.voice === false) return Promise.resolve()
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

    /**
     * The greeting for a start with no splash.
     *
     * With `splashSource: 'none'` (the shipped default) there is no timeline to hold
     * the clip, so the same fetch → preload → play path runs on its own a moment after
     * the shell appears. Guarded by a window flag: a re-applied module must not say
     * hello twice.
     */
    function playStandaloneGreeting() {
      if (settings.voice === false) return
      if (window.__hddGreetingPlayed === true) return
      window.__hddGreetingPlayed = true
      const hour = new Date().getHours()
      fetch(`/hdd/greeting?hour=${hour}`)
        .then((response) => (response.ok ? response.json() : null))
        .then((picked) => {
          if (picked === null || picked.url === null) {
            report('greeting-standalone', { reason: 'no-clips' })
            return undefined
          }
          report('greeting-standalone', {
            bucket: picked.bucket,
            file: picked.file,
            fallback: picked.fallback,
          })
          /* Without a splash there is no earlier gesture to unlock audio; resume the
             context if the platform left it suspended, then play. */
          const context = audioContext()
          if (context !== null && context.state === 'suspended') {
            void context.resume().catch(() => {})
          }
          return preloadGreeting(picked.url).then(() => playGreeting())
        })
        .catch(() => {
          /* A missing voice package is a normal state, not an error worth surfacing. */
        })
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

    /* ------------------------------------------------------------ brand seats
     *
     * Three single seats carry the identity, the same three the reference skin takes:
     *
     *   sidebar.brand.mark            the vector beside the title (shadows shipped UI)
     *   sidebar.brand.name            "Fairy" + a role line (shadows shipped UI)
     *   conversation.hero.brand.mark  the vector above a blank session's headline (empty)
     *
     * They are ordinary slot registrations inside `apply`, so `apply(null)` or an
     * unloaded plugin hands all three back to the shell automatically.
     */
    const BRAND_TITLE = 'Fairy'
    /* The role line the reference skin prints under the title. */
    const BRAND_ROLE = 'Ⅲ型总序式集成泛用人工智能'

    /** Static vector for the sidebar title: same emblem, no bloom/ripple/tear. */
    function BrandMark() {
      return h('div', {
        'data-hdd-brand-mark': 'true',
        'data-hdd-brand-static': 'true',
        'aria-hidden': 'true',
        dangerouslySetInnerHTML: { __html: fairyMarkup({ size: '100%', full: false }) },
      })
    }

    /** The seat owns its own content and width; the role line is our own copy. */
    function BrandName() {
      return h('span', { 'data-hdd-brand-name': 'true', title: BRAND_ROLE }, [
        h('span', { key: 'title', 'data-hdd-brand-title': 'true' }, BRAND_TITLE),
        h('span', { key: 'sub', 'data-hdd-brand-sub': 'true' }, BRAND_ROLE),
      ])
    }

    /** The hero seat asks for a square edge; it sits inline before the headline. */
    function HeroBrandMark(props) {
      const edge = props !== null && props !== undefined && typeof props.size === 'number' && Number.isFinite(props.size)
        ? Math.max(16, Math.min(160, Math.round(props.size)))
        : 44
      return h('div', {
        'data-hdd-hero-mark': 'true',
        'aria-hidden': 'true',
        className: props !== null && props !== undefined ? props.className : undefined,
        style: { width: `${edge}px`, height: `${edge}px` },
        dangerouslySetInnerHTML: { __html: fairyMarkup({ size: '100%', full: false }) },
      })
    }

    /** The time-of-day bucket the current local hour falls into. */
    function bucketOf(inventory) {      const hour = new Date().getHours()
      const match = (inventory.buckets || []).find((item) => hour >= item.from && hour < item.to)
      return match === undefined ? 'morning' : match.id
    }

    /* ------------------------------------------------------------ media panel */
    /*
     * The shipped skin carries no media: the clip, the backdrop and the voice clips
     * are the user's own files under `$DSH_HOME/hdd-fairy/assets`. That convention
     * already existed, but nothing in the UI said so — the first launch just showed a
     * mark and no explanation. This page makes the convention visible: where the
     * folder is, what was detected in it, and a rescan button.
     */
    function MediaPanel() {
      const [inventory, setInventory] = React.useState(null)
      const [status, setStatus] = React.useState('loading')
      const [busy, setBusy] = React.useState(false)
      const [message, setMessage] = React.useState('')
      const [bucket, setBucket] = React.useState('morning')
      const [cue, setCue] = React.useState('thinking')
      const [browse, setBrowse] = React.useState(null)
      const pending = React.useRef(null)
      const fileInput = React.useRef(null)

      const load = () => {
        setBusy(true)
        fetch('/hdd/info')
          .then((response) => (response.ok ? response.json() : null))
          .then((body) => {
            setInventory(body)
            setStatus(body === null ? 'missing' : 'ok')
            setBusy(false)
          })
          .catch(() => {
            setInventory(null)
            setStatus('missing')
            setBusy(false)
          })
      }

      React.useEffect(() => { load() }, [])

      /** Open the picker for one kind; the actual upload happens on `change`. */
      const pick = (kind, accept, extra) => {
        pending.current = { kind, extra: extra ?? {} }
        const input = fileInput.current
        if (input === null) return
        input.setAttribute('accept', accept)
        input.value = ''
        input.click()
      }

      const upload = (target, file) => {
        const params = new URLSearchParams({ kind: target.kind, name: file.name, ...target.extra })
        setMessage(`正在导入 ${file.name}…`)
        fetch(`/hdd/import?${params.toString()}`, {
          method: 'POST',
          headers: { 'content-type': file.type || 'application/octet-stream' },
          body: file,
        })
          .then(async (response) => {
            const body = await response.json().catch(() => ({}))
            if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`)
            setMessage(`已导入：${body.file}`)
            load()
          })
          .catch((error) => setMessage(`导入失败：${String(error.message ?? error).slice(0, 120)}`))
      }

      const onFileChange = (event) => {
        const file = event.target.files === null ? undefined : event.target.files[0]
        const target = pending.current
        pending.current = null
        if (file === undefined || target === null) return
        upload(target, file)
      }

      /* ---- browsing a folder, per kind ----
       *
       * The browser's own file dialog always reopens the last folder it used for the
       * whole profile, and a page cannot tell it otherwise — that is why every
       * "replace" used to land in the same place. So the desktop build picks a folder
       * through the shell's native dialog (`__DSH_DIRECTORY_PICKER__`) once per kind,
       * remembers it, and lists that folder here instead. A browser build without the
       * preload falls back to the plain file input. */
      /* One remembered folder per *target*, so "早上" and "中午" can live in different
         places instead of sharing the single folder the browser would remember. */
      const storageKey = (kind, extra) => {
        const bucket = extra !== undefined && typeof extra.bucket === 'string' ? `:${extra.bucket}` : ''
        return `hdd-fairy:media:${kind}${bucket}`
      }
      const storedDir = (key) => {
        try {
          return window.localStorage.getItem(key) ?? ''
        } catch {
          return ''
        }
      }
      const rememberDir = (key, dir) => {
        try {
          window.localStorage.setItem(key, dir)
        } catch {
          /* private mode: the folder is simply asked for again next time */
        }
      }

      const listDir = (kind, dir, extra) => {
        setBrowse({ kind, dir, extra, parent: '', files: null })
        fetch(`/hdd/list?dir=${encodeURIComponent(dir)}`)
          .then(async (response) => {
            const body = await response.json().catch(() => ({}))
            if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`)
            rememberDir(storageKey(kind, extra), body.dir)
            setBrowse({ kind, dir: body.dir, parent: body.parent, extra, files: body.files })
          })
          .catch((error) => {
            setBrowse(null)
            /* A remembered folder can disappear (moved, unplugged). Forget it so the
               next click asks for one again instead of failing forever. */
            try {
              window.localStorage.removeItem(storageKey(kind, extra))
            } catch {
              /* private mode */
            }
            setMessage(`读取目录失败：${String(error.message ?? error).slice(0, 110)}`)
          })
      }

      const chooseFolder = async (kind, extra) => {
        const picker = window.__DSH_DIRECTORY_PICKER__
        if (picker === undefined || typeof picker.pick !== 'function') return false
        const picked = await picker.pick()
        if (typeof picked !== 'string' || picked === '') return true
        rememberDir(storageKey(kind, extra), picked)
        listDir(kind, picked, extra)
        return true
      }

      const startBrowse = async (kind, accept, extra) => {
        const dir = storedDir(storageKey(kind, extra))
        if (dir !== '') {
          listDir(kind, dir, extra)
          return
        }
        const handled = await chooseFolder(kind, extra)
        if (!handled) pick(kind, accept, extra)
      }

      const adopt = (kind, dir, name, extra) => {
        const params = new URLSearchParams({ kind, dir, name, ...extra })
        setMessage(`正在导入 ${name}…`)
        fetch(`/hdd/adopt?${params.toString()}`, { method: 'POST' })
          .then(async (response) => {
            const body = await response.json().catch(() => ({}))
            if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`)
            setMessage(`已导入：${body.file}`)
            setBrowse(null)
            load()
          })
          .catch((error) => setMessage(`导入失败：${String(error.message ?? error).slice(0, 120)}`))
      }

      /* Open one kind's folder in Explorer. The target comes from `kind` (+ the bucket
         for greetings) on the Host side, so this button cannot point the OS at an
         arbitrary path. */
      const reveal = (kind, extra) => {
        const params = new URLSearchParams({ kind, ...(extra ?? {}) })
        setMessage('正在打开文件夹…')
        fetch(`/hdd/reveal?${params.toString()}`, { method: 'POST' })
          .then(async (response) => {
            const body = await response.json().catch(() => ({}))
            if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`)
            setMessage(`已打开：${body.opened}`)
          })
          .catch((error) => setMessage(`打开失败：${String(error.message ?? error).slice(0, 120)}`))
      }

      const button = (key, label, disabled, run) => h('button', {
        key,
        type: 'button',
        disabled,
        onClick: run,
        style: {
          padding: '4px 10px', borderRadius: '7px', cursor: disabled ? 'default' : 'pointer',
          border: '1px solid var(--dsw-alias-border-l1)',
          background: 'var(--dsw-alias-bg-overlay)', color: 'var(--dsw-alias-label-primary)',
          fontSize: '11px', fontWeight: 700, whiteSpace: 'nowrap',
        },
      }, label)

      const select = (key, value, onChange, options) => h('select', {
        key,
        value,
        onChange: (event) => onChange(event.target.value),
        style: {
          padding: '4px 8px', borderRadius: '7px', fontSize: '11px',
          border: '1px solid var(--dsw-alias-border-l1)',
          background: 'var(--dsw-alias-bg-overlay)', color: 'var(--dsw-alias-label-primary)',
        },
      }, options.map(([optionValue, optionLabel]) => h('option', { key: optionValue, value: optionValue }, optionLabel)))

      /** The inline file list for one kind; empty unless that row is browsing. */
      const browser = (kind) => {
        if (browse === null || browse.kind !== kind) return null
        const files = browse.files
        const fileRow = {
          padding: '4px 8px', borderRadius: '6px', textAlign: 'left', cursor: 'pointer',
          border: '1px solid transparent', background: 'transparent',
          color: 'var(--dsw-alias-label-primary)', fontSize: '11px',
        }
        return h('div', {
          key: `${kind}-browse`,
          style: {
            display: 'flex', flexDirection: 'column', gap: '6px',
            margin: '2px 0 8px 92px', padding: '8px 10px', borderRadius: '10px',
            border: '1px dashed var(--dsw-alias-border-l1)', background: 'var(--dsw-alias-bg-base)',
          },
        }, [
          h('div', { key: 'head', style: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' } }, [
            h('span', { key: 'dir', style: { flex: '1 1 200px', fontSize: '11px', opacity: 0.72, wordBreak: 'break-all' } },
              browse.dir),
            button('up', '上一级', browse.parent === '', () => listDir(kind, browse.parent, browse.extra)),
            button('other', '换个文件夹…', false, () => { void chooseFolder(kind, browse.extra) }),
            button('close', '收起', false, () => setBrowse(null)),
          ]),
          files === null
            ? h('span', { key: 'loading', style: { fontSize: '11px', opacity: 0.6 } }, '读取中…')
            : files.length === 0
              ? h('span', { key: 'empty', style: { fontSize: '11px', opacity: 0.6 } }, '这个文件夹里没有可用文件')
              : h('div', {
                key: 'list',
                style: { display: 'flex', flexDirection: 'column', gap: '2px', maxHeight: '190px', overflowY: 'auto' },
              }, files.map((file) => h('button', {
                key: file.name,
                type: 'button',
                onClick: () => adopt(kind, browse.dir, file.name, browse.extra),
                style: fileRow,
              }, `${file.name}  ·  ${Math.round(file.size / 1024)} KB`))),
        ])
      }

      const row = (label, value, actions, kind) => h('div', {
        key: label,
        style: { display: 'flex', flexDirection: 'column' },
      }, [
        h('div', {
          key: 'line',
          style: { display: 'flex', gap: '10px', alignItems: 'center', padding: '4px 0', fontSize: '13px', flexWrap: 'wrap' },
        }, [
          h('span', { key: 'l', style: { flex: '0 0 82px', opacity: 0.62 } }, label),
          h('span', { key: 'v', style: { flex: '1 1 140px', wordBreak: 'break-all', fontSize: '12px' } }, value),
          ...(actions ?? []),
        ]),
        kind === undefined ? null : browser(kind),
      ])

      const greetings = inventory === null ? 0 : Object.values(inventory.greetings || {}).reduce(
        (total, list) => total + (Array.isArray(list) ? list.length : 0),
        0,
      )
      const cues = inventory === null ? 0 : Object.values(inventory.cues || {}).filter((file) => typeof file === 'string').length

      /* Which bucket a greeting belongs to is decided by its file name prefix alone
         (`morning-*.m4a`), so showing the counts per bucket is the only way to see at
         a glance what the plugin will actually play at a given hour. */
      const greetingBreakdown = () => {
        if (inventory === null) return '素材包未就绪'
        const parts = []
        for (const item of inventory.buckets || []) {
          const list = (inventory.greetings || {})[item.id]
          parts.push(`${item.label} ${Array.isArray(list) ? list.length : 0}`)
        }
        return parts.join(' · ')
      }

      return h('section', {
        style: {
          display: 'flex', flexDirection: 'column', gap: '8px',
          padding: '18px 20px', borderRadius: '14px',
          background: 'var(--dsw-alias-bg-layer-1)', border: '1px solid var(--dsw-alias-border-l1)',
          color: 'var(--dsw-alias-label-primary)',
        },
      }, [
        h('h2', { key: 'h', style: { margin: 0, fontSize: '15px', fontWeight: 800 } }, 'HDD Fairy 素材'),
        h('p', { key: 'p', style: { margin: 0, fontSize: '12px', opacity: 0.72, lineHeight: 1.7 } }, [
          '发布版不含任何素材。可以直接在这里导入，也可以把文件放进下面这个目录（点「重新扫描」刷新）：',
          h('br', { key: 'b1' }),
          h('code', { key: 'c', style: { fontSize: '12px', wordBreak: 'break-all' } },
            inventory === null ? '%USERPROFILE%\\.dsh\\hdd-fairy\\assets' : inventory.root),
        ]),
        row('开屏动画', inventory !== null && typeof inventory.video === 'string' ? inventory.video : '未放置（.mp4 / .webm）', [
          button('video', '选择…', false, () => { void startBrowse('video', '.mp4,.webm,video/mp4,video/webm') }),
          button('open-video', '打开文件夹', false, () => reveal('video')),
        ], 'video'),
        row('开屏背景图', inventory !== null && typeof inventory.backdrop === 'string' ? inventory.backdrop : '未放置（.png / .jpg / .webp）', [
          button('backdrop', '选择…', false, () => { void startBrowse('backdrop', '.png,.jpg,.jpeg,.webp,image/png,image/jpeg,image/webp') }),
          button('open-backdrop', '打开文件夹', false, () => reveal('backdrop')),
        ], 'backdrop'),
        row('高光板', inventory !== null && typeof inventory.field === 'string' ? inventory.field : '未放置（可选）', [
          button('field', '选择…', false, () => { void startBrowse('field', '.png,.jpg,.jpeg,.webp,image/png,image/jpeg,image/webp') }),
          button('open-field', '打开文件夹', false, () => reveal('field')),
        ], 'field'),
        row('问候语音', status === 'missing'
          ? '素材包未就绪'
          : `${greetings} 条 — ${greetingBreakdown()}`, [
          select('bucket', bucket, setBucket, [
            ['dawn', '深夜 0–5'], ['morning', '早上 5–11'], ['noon', '中午 11–14'],
            ['afternoon', '下午 14–18'], ['evening', '晚上 18–22'], ['night', '深夜 22–24'],
          ]),
          button('add-greeting', '导入…', false, () => { void startBrowse('greeting', '.m4a,.mp3,.ogg,.opus,.wav,audio/*', { bucket }) }),
          button('open-greeting', '打开文件夹', false, () => reveal('greeting', { bucket })),
        ], 'greeting'),
        row('回合提示音', status === 'missing' ? '素材包未就绪' : `${cues} 条`, [
          select('cue', cue, setCue, [['thinking', '思考'], ['done', '完成'], ['failed', '失败']]),
          button('set-cue', '更换…', false, () => { void startBrowse('cue', '.m4a,.mp3,.ogg,.opus,.wav,audio/*', { cue }) }),
          button('open-cue', '打开文件夹', false, () => reveal('cue')),
        ], 'cue'),
        h('div', { key: 'actions', style: { display: 'flex', gap: '8px', marginTop: '4px', alignItems: 'center' } }, [
          button('rescan', busy ? '扫描中…' : '重新扫描', busy, () => load()),
          message === '' ? null : h('span', { key: 'msg', style: { fontSize: '11px', opacity: 0.72, wordBreak: 'break-all' } }, message),
        ]),
        h('input', {
          key: 'file',
          ref: fileInput,
          type: 'file',
          onChange: onFileChange,
          style: { display: 'none' },
        }),
        h('p', { key: 'note', style: { margin: 0, fontSize: '11px', opacity: 0.55, lineHeight: 1.6 } },
          '动画与背景图是"替换"（同一时间只保留一个）；问候语音是"添加"（同名档位自动编号）；提示音是"覆盖"。'
          + '没有放动画时，开屏就是「徽记居中 → 飞向侧栏」；放了动画则先播动画再飞。'),
      ])
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
          report('assets-missing', { reason: 'the skin host is not answering /hdd/info' })
          hint.textContent = '未检测到素材包：本次仅显示徽记。'
          root.appendChild(hint)
        } else if (settings.splashSource !== 'novideo'
          && typeof inventory.video === 'string' && inventory.video !== '') {
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
            let cutTimer = 0
            const settleAndStop = (why) => {
              if (cutTimer !== 0) {
                window.clearInterval(cutTimer)
                cutTimer = 0
              }
              settle(why)
            }
            video.addEventListener('ended', () => settleAndStop('ended'), { once: true })
            video.addEventListener('error', () => settleAndStop('error'), { once: true })
            /* Cut where the user says, when the user says it. `animEndS = 0` means
               the clip decides: the 'ended' listener settles the promise instead.
               Polled at 80ms because `timeupdate` only fires 3–4 times a second, which
               is coarser than the 0.1s the setting offers. */
            const onTime = () => {
              /* The splash can be torn down (backstop, settings change) while the clip
                 is paused; stop polling then, or the interval would outlive the node. */
              if (disposed) {
                if (cutTimer !== 0) {
                  window.clearInterval(cutTimer)
                  cutTimer = 0
                }
                return
              }
              const cut = settings.animEndS > 0 ? settings.animEndS : TIMING.videoEndS
              if (cut > 0 && video.currentTime >= cut) {
                video.pause()
                settleAndStop('cut')
              }
            }
            cutTimer = window.setInterval(onTime, 80)
            after(TIMING.videoMaxMs, () => settleAndStop('timeout'))
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
          /* The backdrop is the canvas in both `auto` (when there is no clip) and
             `novideo` (when the clip is deliberately skipped). */
          backdrop.style.backgroundImage = `url("/hdd/asset?path=${encodeURIComponent(inventory.backdrop)}")`
          backdrop.setAttribute('data-on', 'true')
          root.appendChild(backdrop)
        } else {
          /* No clip, no backdrop: this is the SHIPPED default, not a failure. The mark
             below is the whole splash, so nothing is added here — a "file not found"
             line on every first launch would read as a broken skin. The asset status
             belongs in the log and in the settings page. */
          report('media-absent', { root: inventory.root })
        }
        if (disposed) return
        /* The drawn highlight plate goes under the emblem. It fades in with the
           emblem, holds while she speaks, then fades out before the flight — the
           order the reference implementation uses. */
        /* `inventory` is null when the Host half is not answering, and the branch
           above has already reported that. Everything below must stay null-safe: an
           unguarded `inventory.field` used to throw here, which aborted this whole
           callback — no emblem, no timeline, and the splash sat until the 15s
           backstop tore it down (a hint with no mark, then a long dark wait). */
        const fieldName = inventory !== null && typeof inventory.field === 'string' ? inventory.field : null
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
      /** False until the first poll has aligned `seq` with the server's history. */
      let primed = false
      /** True while a poll request is open; see `poll`. */
      let inFlight = false
      let timer = undefined
      let playing = null
      /** Last time each kind played, so a burst of events cannot machine-gun the user. */
      const lastPlayed = new Map()
      const MIN_GAP_MS = 900

      /**
       * Cue sequence numbers already played in this document.
       *
       * Kept on `window` rather than in the closure: a re-applied module (hot reload,
       * or a second injection of the same bundle) starts a *new* poller with its own
       * cursor, and both would fetch and play the same cue — the repetition the user
       * hears. The host logs one cue per run, so the doubling is here, not there.
       */
      const played = window.__hddCuePlayed instanceof Set
        ? window.__hddCuePlayed
        : (window.__hddCuePlayed = new Set())

      /** Only one poller per document; a new instance takes over from the old one. */
      const previousPoller = window.__hddCuePoller
      if (previousPoller !== null && previousPoller !== undefined && typeof previousPoller.stop === 'function') {
        try {
          previousPoller.stop()
        } catch {
          /* the old instance may already be disposed */
        }
      }

      const playCue = (kind) => {
        const inventory = info.value
        if (inventory === null || inventory.cues === undefined) return
        const file = inventory.cues[kind]
        if (file === undefined || file === null) return
        if (playing !== null && playing.paused === false) return
        const now = Date.now()
        const previous = lastPlayed.get(kind) ?? 0
        if (now - previous < MIN_GAP_MS) return
        lastPlayed.set(kind, now)
        const element = new Audio(`/hdd/asset?path=${encodeURIComponent(`cue/${file}`)}`)
        element.volume = CUE_VOLUME
        playing = element
        const playback = element.play()
        if (playback && typeof playback.catch === 'function') playback.catch(() => {})
      }

      /** Identity of this document in the cue feed, so the Host can count clients. */
      const CLIENT_ID = Math.random().toString(36).slice(2, 8)

      const poll = async () => {
        if (document.visibilityState === 'hidden') return
        /* One request at a time: a slow response used to let the next interval fire,
           and both polls then returned the same cue — the sound played twice. */
        if (inFlight) return
        inFlight = true
        try {
          const response = await fetch(`/hdd/cue?since=${seq}&client=${CLIENT_ID}`)
          if (!response.ok) return
          const body = await response.json()
          if (typeof body.seq === 'number') {
            /* A smaller cursor than ours means the Host restarted and its sequence
               started over; the remembered numbers belong to the previous epoch. */
            if (body.seq < seq) played.clear()
            seq = body.seq
          }
          /* The server keeps the last handful of cues for a client that polls late.
             On a fresh page that would replay them all as a burst of stale sound, so
             the first poll only aligns the cursor and stays silent. */
          if (!primed) {
            primed = true
            return
          }
          for (const cue of body.cues || []) {
            if (cue.kind !== 'thinking' && cue.kind !== 'done' && cue.kind !== 'failed') continue
            /* One sound per cue, no matter how many pollers are alive. */
            if (typeof cue.seq === 'number') {
              if (played.has(cue.seq)) continue
              played.add(cue.seq)
              if (played.size > 256) {
                const oldest = played.values().next()
                if (oldest.done !== true) played.delete(oldest.value)
              }
            }
            playCue(cue.kind)
          }
        } catch {
          /* A missing voice package is a normal state, not an error worth surfacing. */
        } finally {
          inFlight = false
        }
      }

      const start = () => {
        if (timer !== undefined) return
        timer = window.setInterval(() => {
          void poll()
        }, CUE_POLL_MS)
      }
      let handle = null
      const stop = () => {
        if (window.__hddCuePoller === handle) window.__hddCuePoller = null
        if (timer === undefined) return
        window.clearInterval(timer)
        timer = undefined
      }
      handle = { stop }

      const onVisibility = () => {
        if (document.visibilityState === 'hidden') stop()
        else start()
      }

      window.__hddCuePoller = handle
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
      /* Handed back so a settings change can start or stop the poller live. */
      return { start, stop }
    }

    return {
      inject: ['slots', 'theme'],
      apply(ctx) {
        report('apply')

        /* Appearance: the palette is built for dark, so turning the skin on makes dark
           the default instead of leaving the shell on a light preference where the
           parts this skin does not override look out of place.
           One shot, and reversible: a later manual switch stays the user's choice, and
           on release the previous preference comes back only when it is still the value
           this effect set. */
        const previousPreference = ctx.theme.getTheme().preference
        if (previousPreference !== 'dark') {
          ctx.effect(() => {
            ctx.theme.setTheme('dark')
            report('theme-forced', { from: previousPreference, to: 'dark' })
            return () => {
              if (ctx.theme.getTheme().preference === 'dark') {
                ctx.theme.setTheme(previousPreference)
                report('theme-restored', { to: previousPreference })
              }
            }
          }, 'hdd-skin dark default')
        }

        /* Skin identity on <body>, restored exactly on release. Never on <html>:
           a bare `[data-…]` selector there styles the document element itself. */
        ctx.effect(() => {
          const previous = document.body.getAttribute(BODY_ATTR)
          document.body.setAttribute(BODY_ATTR, 'true')
          return () => {
            if (previous === null) document.body.removeAttribute(BODY_ATTR)
            else document.body.setAttribute(BODY_ATTR, previous)
          }
        }, 'hdd-skin body attribute')

        /* Geometry settings are variables on <body>, so the mark reacts immediately
           on the next paint — no re-registration, no React re-render. */
        applyMarkStyle()

        /* Announce the settings this skin exposes; the manager renders them under
           Settings → Skins and calls `apply` with the stored values. */
        ctx.effect(
          () => registerCustomization({
            protocol: 2,
            skinId: SKIN_ID,
            title: 'HDD Fairy',
            titleEn: 'HDD Fairy',
            settings: [
              {
                key: 'splash',
                type: 'boolean',
                label: '开机动画',
                labelEn: 'Launch animation',
                description: '开屏视频、徽记与飞向侧栏的完整时间轴。关闭后各设置仍保留，下次启动不再播放。',
                descriptionEn: 'The splash clip, the mark and the flight to the sidebar. Turning it off skips the whole timeline on the next launch.',
                defaultValue: true,
              },
              {
                key: 'splashSource',
                type: 'select',
                label: '开屏内容',
                labelEn: 'Splash content',
                description: '自动 = 有动画播动画，没有动画就用背景图；不播视频 = 跳过动画，背景图与高光板照常；直接进入 = 不播开屏，连徽记动画也省掉。',
                descriptionEn: 'Auto plays the clip, else the backdrop; no-video skips the clip but keeps the backdrop and the plate; direct opens straight into the shell with no splash.',
                defaultValue: 'none',
                visibleWhen: { key: 'splash', values: [true] },
                options: [
                  { value: 'auto', label: '自动（有动画就播动画）', labelEn: 'Auto (clip first)' },
                  { value: 'novideo', label: '不播视频（用背景图）', labelEn: 'Skip the clip' },
                  { value: 'none', label: '直接进入界面（不播开屏）', labelEn: 'Direct, no splash' },
                ],
              },
              {
                key: 'animEndS',
                type: 'range',
                label: '动画结束点',
                labelEn: 'Animation end',
                description: '自定义动画播到第几秒结束（换自己的片段后，片尾多余的部分可以在这里截掉）。0 = 播完整段。',
                descriptionEn: 'Where your own clip stops, in seconds. 0 plays it to the end.',
                defaultValue: 0,
                min: 0,
                max: 40,
                step: 0.1,
                unit: 's',
                visibleWhen: { key: 'splash', values: [true] },
              },
              {
                key: 'voice',
                type: 'boolean',
                label: '问候语音',
                labelEn: 'Greeting voice',
                description: '开屏时播放当前时段的问候语（需要用户自备素材，见「HDD Fairy 素材」页）。',
                descriptionEn: 'Plays the hour-appropriate greeting during the splash (needs the user\'s own clips, see the "HDD Fairy 素材" page).',
                defaultValue: true,
              },
              {
                key: 'cues',
                type: 'boolean',
                label: '回合提示音',
                labelEn: 'Turn cues',
                description: '思考、完成、失败时的提示音。',
                descriptionEn: 'Cues for thinking, done and failed turns.',
                defaultValue: true,
              },
              {
                key: 'markSize',
                type: 'range',
                label: '徽记尺寸',
                labelEn: 'Mark size',
                description: '侧栏左下角徽记的边长。收起成 rail 时另有 30px 的小尺寸。',
                descriptionEn: 'Edge length of the mark in the sidebar foot. The collapsed rail keeps its own 30px size.',
                defaultValue: 60,
                min: 40,
                max: 80,
                step: 2,
                unit: 'px',
              },
              {
                key: 'markGlow',
                type: 'boolean',
                label: '徽记光效',
                labelEn: 'Mark glow',
                description: '呼吸光晕、向外扩散的涟漪，以及每 3.6 秒一次的"撕裂"。',
                descriptionEn: 'The breathing bloom, the travelling ripple and the tear every 3.6 seconds.',
                defaultValue: true,
              },
            ],
            apply: applySkinState,
          }),
          'hdd-skin customization',
        )

        /* Resolved once per document; the constants carry a re-hashed build. */
        let resolved = resolveSkinClasses()
        report('skin-classes', {
          source: resolved.source,
          missing: resolved.missing,
          classes: resolved.classes,
        })

        let skinStyle = null
        let panelCss = buildPanelCss(resolved.classes)

        /**
         * Re-resolve once the shell has actually mounted.
         *
         * At `apply` time nothing exists yet — the measurement above is 2.6s into the
         * document and the conversation bundle has not injected its classes — so the
         * first pass always lands on the constants. The purpose of resolving at
         * runtime is the *next* DSH release, and that only pays off if the pass runs
         * when there is something to look at.
         */
        const refreshPanelCss = () => {
          if (skinStyle === null) return false
          const next = resolveSkinClasses()
          if (next.source !== 'live') return false
          const css = buildPanelCss(next.classes)
          if (css !== panelCss) {
            panelCss = css
            skinStyle.textContent = CSS + '\n' + SKIN_CSS + '\n' + css
            resolved = next
            report('skin-classes', {
              source: next.source,
              missing: next.missing,
              classes: next.classes,
              refreshed: true,
            })
          }
          return true
        }

        ctx.effect(() => {
          const style = document.createElement('style')
          style.setAttribute('data-hdd-skin', '')
          style.textContent = CSS + '\n' + SKIN_CSS + '\n' + panelCss
          document.head.appendChild(style)
          skinStyle = style
          /* A <style> inserted into <head> is also the signal the Desktop preload
             listens for to re-measure native caption colours; no action needed. */
          return () => {
            skinStyle = null
            style.remove()
          }
        }, 'hdd-skin stylesheet')

        /* Give the shell up to ~12s to mount, then stop asking. Never keeps the page
           awake: the interval is cleared on the first live resolution or on dispose. */
        let tries = 0
        const refreshTimer = window.setInterval(() => {
          tries += 1
          if (refreshPanelCss() || tries >= 24) window.clearInterval(refreshTimer)
        }, 500)
        ctx.effect(() => () => window.clearInterval(refreshTimer), 'hdd-skin class refresh')

        void loadInfo()
        cues = installCues(ctx)
        if (settings.cues === false) cues.stop()

        /* The manager can turn the whole timeline off; the mark and the cues are
           independent of it, so the skin still identity-marks the sidebar.
           `splashSource: 'none'` is the other way to want no splash: it skips the
           timeline entirely, mark included, and opens straight into the shell.
           With no timeline the greeting has nowhere to live, so it is played on its
           own shortly after the shell appears (same fetch/preload/play path). */
        if (settings.splash && settings.splashSource !== 'none') {
          mountSplash()
        } else {
          ctx.effect(() => {
            const timer = window.setTimeout(() => playStandaloneGreeting(), 900)
            return () => window.clearTimeout(timer)
          }, 'hdd-skin standalone greeting')
        }

        /* Brand identity: the two sidebar seats and the blank-session hero mark.
           The hero seat was empty and took the registration; the two sidebar seats are
           already occupied by the shipped wordmark and did not change on screen, so
           each attempt reports its outcome and the error when one is thrown — otherwise
           "did nothing" and "was refused" look identical from the outside. */
        const claimSeat = (slot, component) => {
          ctx.slots.inject(slot, () => {
            try {
              const dispose = ctx.slots.register({ name: slot }, component)
              return dispose
            } catch (error) {
              report('brand-seat', {
                slot,
                ok: false,
                error: String(error !== null && error !== undefined && error.message ? error.message : error).slice(0, 200),
              })
              return () => {}
            }
          })
        }
        claimSeat('sidebar.brand.mark', BrandMark)
        claimSeat('sidebar.brand.name', BrandName)
        claimSeat('conversation.hero.brand.mark', HeroBrandMark)

        /* The mark seat likewise keeps its shipped glyph in this build, so while it is
           still the shell's own SVG the skin paints its vector as the seat's
           background and hides that glyph. The data URI is built at runtime because
           the vector is code, not a file; the `:not(:has(…))` guard stops the moment
           the seat renders our component. */
        ctx.effect(() => {
          const seat = 'body[data-dsh-hdd-fairy] [data-slot="sidebar.brand.mark"]:not(:has([data-hdd-brand-mark]))'
          /* Give the SVG an intrinsic size: an SVG without width/height paints as a
             0×0 image when it is used as generated content. */
          const sized = FAIRY_EMBLEM.replace('<svg ', '<svg width="26" height="26" ')
          const uri = `data:image/svg+xml,${encodeURIComponent(sized)}`
          const style = document.createElement('style')
          style.setAttribute('data-hdd-brand-fallback', '')
          style.textContent = [
            `${seat} > svg, ${seat} svg { display: none !important; }`,
            /* Painted as a sized pseudo-element rather than as the seat's own
               background: the seat's box is the shell's, and a zero-sized seat would
               paint nothing. */
            `${seat}::before {`,
            "  content: '';",
            '  display: block;',
            '  width: 26px;',
            '  height: 26px;',
            `  background-image: url("${uri}");`,
            '  background-size: 26px 26px;',
            '  background-repeat: no-repeat;',
            '  background-position: center;',
            '  flex: 0 0 auto;',
            '}',
          ].join('\n')
          document.head.appendChild(style)
          return () => style.remove()
        }, 'hdd-skin brand mark fallback')

        ctx.slots.inject('sidebar.footer.action', () =>
          ctx.slots.register(
            { name: 'sidebar.footer.action', id: 'hdd-mark', order: 60, label: 'Fairy' },
            Mark,
          ),
        )

        /* A settings page, not a manager control: it reports the asset folder and what
           is in it, which is exactly what the manager's protocol cannot express. The
           seat is additive (`settings.section` is a list), so it never competes with a
           shipped page. */
        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            { name: 'settings.section', id: 'hdd-fairy-media', order: 80, label: 'HDD Fairy 素材' },
            MediaPanel,
          ),
        )
      },
    }
  },
})
