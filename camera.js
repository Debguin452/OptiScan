'use strict';
/**
 * OptiScan Pro -- Camera Module
 * Handles stream, focus locking, frame capture, and live sharpness monitoring.
 *
 * FIX 5:  waitFocusConverge now uses shared ConvergenceDetector (optics.js)
 *         instead of a local stability-check duplicate.
 * FIX 10: start() accepts an options object { facingMode } instead of relying
 *         on the mutable Camera._overrideFacing field set by the caller.
 */

const Camera = {
  stream: null,
  _canvas: null,
  _track: null,
  _caps: null,
  _pollTimer: null,
  _currentFacing: 'environment',   /* track which side we are using */

  /* ---- Lifecycle -------------------------------------------------------- */

  init(canvas) {
    this._canvas = canvas;
    FocusAPI._track = null;
  },

  /* FIX 10: accept { facingMode } option so callers don't mutate private fields */
  async start(videoEl, { facingMode } = {}) {
    this.stop();
    const facing = facingMode ?? this._currentFacing ?? 'environment';
    this._currentFacing = facing;

    const constraints = {
      video: {
        facingMode: { ideal: facing },
        width:      { ideal: 1920 },
        height:     { ideal: 1080 },
        focusMode:  { ideal: 'continuous' },
      }
    };
    try {
      this.stream = await navigator.mediaDevices.getUserMedia(constraints);
    } catch (e) {
      try {
        this.stream = await navigator.mediaDevices.getUserMedia({ video: true });
      } catch (e2) {
        return { ok: false, err: 'Camera access denied: ' + (e2.message || e2) };
      }
    }

    videoEl.srcObject = this.stream;
    await new Promise((res, rej) => {
      videoEl.onloadedmetadata = res;
      videoEl.onerror = rej;
      setTimeout(res, 4000);
    });
    videoEl.play();

    this._track = this.stream.getVideoTracks()[0] ?? null;
    try { this._caps = this._track?.getCapabilities?.() ?? {}; } catch (_) { this._caps = {}; }
    FocusAPI.attach(this.stream);

    return { ok: true, caps: this._caps };
  },

  stop() {
    this.stopPoll();
    if (this.stream) {
      this.stream.getTracks().forEach(t => t.stop());
      this.stream = null;
    }
    this._track = null;
  },

  /* ---- Frame capture ---------------------------------------------------- */

  capture(videoEl) {
    return captureFrame(videoEl, this._canvas);
  },

  /* ---- Focus helpers ---------------------------------------------------- */

  async lockFocus()   { return FocusAPI.lock();   },
  async unlockFocus() { return FocusAPI.unlock(); },
  getFocusDist()      { return FocusAPI.read();   },

  /**
   * probeFocusControl -- verify that focus lock AND unlock actually work.
   *
   * Many devices accept applyConstraints({focusMode}) without error but
   * silently ignore it (Android Chrome on certain Qualcomm ISPs, older
   * Safari, some PWA wrappers). This probe:
   *
   *   1. Attempts to lock.  Waits 300 ms, checks focusMode in getSettings().
   *      If it stayed 'continuous', lock is broken.
   *
   *   2. Attempts to unlock.  Waits 400 ms and samples sharpness variance
   *      over five frames.  Real unlock triggers AF hunting => sharpness
   *      moves >= 2%. A stuck camera shows < 0.5% variance.
   *
   * Returns { lockWorks, unlockWorks, focusControlWorks }
   * Call once after Camera.start() -- stored in Camera.focusProbe.
   */
  async probeFocusControl(videoEl) {
    const result = { lockWorks: false, unlockWorks: false, focusControlWorks: false };
    if (!this._track) return result;

    /* Test 1: lock */
    try {
      await this._track.applyConstraints({ advanced: [{ focusMode: 'manual' }] });
      await delay(300);
      const s = this._track.getSettings?.() ?? {};
      result.lockWorks = (s.focusMode === 'manual');
    } catch (_) { result.lockWorks = false; }

    /* Test 2: unlock + sharpness variance to confirm AF started hunting */
    try {
      await this._track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] });
      await delay(250);
      const s = this._track.getSettings?.() ?? {};
      const modeOk = (s.focusMode === 'continuous' || !s.focusMode);

      const sharpSamples = [];
      for (let i = 0; i < 5; i++) {
        await delay(90);
        const id = this.capture(videoEl);
        if (id) sharpSamples.push(Sharpness.compute(id).fused);
      }
      let huntingDetected = false;
      if (sharpSamples.length >= 3) {
        const max = Math.max(...sharpSamples), min = Math.min(...sharpSamples);
        huntingDetected = max > 0 && (max - min) / max > 0.02;
      }
      result.unlockWorks = modeOk && huntingDetected;
    } catch (_) { result.unlockWorks = false; }

    /* Test 3: focus DISTANCE range sanity.
     * hasFocusAPI = true only means the capability exists in getCapabilities().
     * Many Android devices report sentinel values (2^63, FLT_MAX, Infinity)
     * from getSettings().focusDistance even when the capability is listed.
     * Sample 4 frames and check if ANY returned value is in the physical range
     * 0.02 – 20 m.  If all are out of range, mark focusDistanceReliable = false
     * so callers know not to trust focus-shift measurements. */
    result.focusDistanceReliable = false;
    try {
      const FOCUS_MIN = 0.02, FOCUS_MAX = 20;
      for (let i = 0; i < 4; i++) {
        await delay(80);
        const s  = this._track.getSettings?.() ?? {};
        const fd = s.focusDistance ?? null;
        if (fd !== null && isFinite(fd) && fd >= FOCUS_MIN && fd <= FOCUS_MAX) {
          result.focusDistanceReliable = true;
          break;
        }
      }
      if (!result.focusDistanceReliable) {
        console.warn('[OptiScan] probeFocusControl: focusDistance out of physical range -- ' +
          'camera HAL returning sentinel. Focus-shift measurements will fall back to blur-profile.');
      }
    } catch (_) { result.focusDistanceReliable = false; }

    result.focusControlWorks = result.lockWorks && result.unlockWorks;
    this.focusProbe = result;
    console.log('[OptiScan] Focus control probe:', result);
    return result;
  },

  focusProbe: null,   /* cached result of probeFocusControl() */

  /**
   * FIX 5: Wait for autofocus to converge.
   * Uses the shared ConvergenceDetector from optics.js so the stability
   * thresholds are defined in exactly one place.
   */
  async waitFocusConverge(videoEl, timeoutMs = 5000, sampleMs = 100) {
    const start   = Date.now();
    const history = [];
    /* FIX 5: shared detector -- same thresholds as _monitorAndConverge */
    const conv    = new ConvergenceDetector({ windowSize:5, stabilityThreshold:0.013, requiredCount:3 });

    while (Date.now() - start < timeoutMs) {
      await delay(sampleMs);
      const id = this.capture(videoEl);
      if (!id) continue;
      const sh      = Sharpness.compute(id);
      const focDist = this.getFocusDist();
      history.push({ lap: sh.fused, shH: sh.h, shV: sh.v, focDist, t: Date.now() });

      if (conv.feed(sh.fused)) {
        const best = history.reduce((a, b) => a.lap > b.lap ? a : b);
        return { ok: true, ...best };
      }
    }
    if (history.length) {
      const best = history.reduce((a, b) => a.lap > b.lap ? a : b);
      return { ok: true, ...best };
    }
    return { ok: false, lap: 0, shH: 0, shV: 0, focDist: null };
  },

  estimateFocusFromSharpness(videoEl) {
    const id = this.capture(videoEl);
    if (!id) return null;
    return Sharpness.compute(id);
  },

  /* ---- Polling ---------------------------------------------------------- */

  startPoll(cb, intervalMs = 120) {
    this.stopPoll();
    this._pollTimer = setInterval(cb, intervalMs);
  },

  stopPoll() {
    if (this._pollTimer) { clearInterval(this._pollTimer); this._pollTimer = null; }
  },

  /* ---- Specs ------------------------------------------------------------ */

  get specs() {
    if (!this._track) return {};
    const s = this._track.getSettings?.() ?? {};
    return {
      width:      s.width,
      height:     s.height,
      fps:        Math.round(s.frameRate ?? 0),
      facing:     s.facingMode ?? 'unknown',
      focalLength:s.focalLength ?? null,
      focusDist:  s.focusDistance ?? null,
      focusMode:  s.focusMode ?? null,
      hasFocusAPI:!!this._caps?.focusDistance,
      focusRange: this._caps?.focusDistance ?? null,
      zoom:       s.zoom ?? null,
    };
  },
};
