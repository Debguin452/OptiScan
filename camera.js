'use strict';
/**
 * OptiScan Pro — Camera Module
 * Handles stream, focus locking, frame capture, and live sharpness monitoring.
 */

const Camera = {
  stream: null,
  _canvas: null,
  _track: null,
  _caps: null,
  _pollTimer: null,

  /* ── Lifecycle ────────────────────────────────────────────────── */

  init(canvas) {
    this._canvas = canvas;
    FocusAPI._track = null;
  },

  async start(videoEl) {
    this.stop();
    const constraints = {
      video: {
        facingMode: { ideal: 'environment' },
        width: { ideal: 1920 },
        height: { ideal: 1080 },
        focusMode: { ideal: 'continuous' },
      }
    };
    try {
      this.stream = await navigator.mediaDevices.getUserMedia(constraints);
    } catch (e) {
      // Fallback: minimal constraint
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

  /* ── Frame capture ─────────────────────────────────────────────── */

  capture(videoEl) {
    return captureFrame(videoEl, this._canvas);
  },

  /* ── Focus helpers ─────────────────────────────────────────────── */

  async lockFocus() { return FocusAPI.lock(); },
  async unlockFocus() { return FocusAPI.unlock(); },
  getFocusDist() { return FocusAPI.read(); },

  /**
   * Wait for autofocus to converge after a change event (e.g. lens placed).
   * Polls sharpness until it stops rising.
   * Returns { focusDist, sharpness, shH, shV }
   */
  async waitFocusConverge(videoEl, timeoutMs = 5000, sampleMs = 100) {
    const start = Date.now();
    const history = [];
    let stableCount = 0;

    while (Date.now() - start < timeoutMs) {
      await delay(sampleMs);
      const id = this.capture(videoEl);
      if (!id) continue;
      const sh = Sharpness.compute(id);
      const focDist = this.getFocusDist();
      history.push({ lap: sh.lap, shH: sh.h, shV: sh.v, focDist, t: Date.now() });

      if (history.length >= 5) {
        // Check if sharpness plateau reached (< 1.5% change over last 4 samples)
        const recent = history.slice(-4).map(h => h.lap);
        const maxRecent = Math.max(...recent);
        const minRecent = Math.min(...recent);
        const stability = maxRecent > 0 ? (maxRecent - minRecent) / maxRecent : 1;
        if (stability < 0.015) {
          stableCount++;
          if (stableCount >= 3) {
            const best = history.reduce((a, b) => a.lap > b.lap ? a : b);
            return { ok: true, ...best };
          }
        } else {
          stableCount = 0;
        }
      }
    }
    // Return best we found
    if (history.length) {
      const best = history.reduce((a, b) => a.lap > b.lap ? a : b);
      return { ok: true, ...best };
    }
    return { ok: false, lap: 0, shH: 0, shV: 0, focDist: null };
  },

  /**
   * Estimate focus distance from sharpness when focus API is unavailable.
   * Steps through virtual focus by stepping zoom if available, else
   * returns null (caller falls back to user input).
   */
  estimateFocusFromSharpness(videoEl, refSharpness) {
    // Without API we cannot estimate exact focus distance,
    // but we can return relative sharpness for the on-screen indicator.
    const id = this.capture(videoEl);
    if (!id) return null;
    return Sharpness.compute(id);
  },

  /* ── Polling ────────────────────────────────────────────────────── */

  startPoll(cb, intervalMs = 120) {
    this.stopPoll();
    this._pollTimer = setInterval(cb, intervalMs);
  },

  stopPoll() {
    if (this._pollTimer) { clearInterval(this._pollTimer); this._pollTimer = null; }
  },

  /* ── Specs ──────────────────────────────────────────────────────── */

  get specs() {
    if (!this._track) return {};
    const s = this._track.getSettings?.() ?? {};
    return {
      width: s.width, height: s.height,
      fps: Math.round(s.frameRate ?? 0),
      facing: s.facingMode ?? 'unknown',
      focalLength: s.focalLength ?? null,
      focusDist: s.focusDistance ?? null,
      focusMode: s.focusMode ?? null,
      hasFocusAPI: !!this._caps?.focusDistance,
      focusRange: this._caps?.focusDistance ?? null,
      zoom: s.zoom ?? null,
    };
  },
};
