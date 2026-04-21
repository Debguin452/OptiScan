'use strict';
/**
 * OptiScan Pro — App Controller
 * Orchestrates the 10-cycle focus-shift lens power measurement.
 *
 * Cycle flow (per reading):
 *   1. WITHOUT LENS: camera focuses on distant object, AF converges → record d_ref
 *   2. WITH LENS:    user places lens in front, AF re-converges → record d_lens
 *   3. Power = 1/d_lens − 1/d_ref
 *   Repeat 10×, then compute weighted median.
 */

const App = {
  /* ── State ──────────────────────────────────────────────────────── */
  st: {
    phase: 'idle',          // idle | calibrating | ready | placing | measuring | done
    currentEye: 'right',
    results: { right: null, left: null },
    cycles: [],             // per-cycle readings for current eye
    cycleNum: 0,
    dRef: null,             // calibrated reference focus distance (m)
    dRefSharpness: null,    // sharpness at calibration
    hasFocusAPI: false,
    isCapturing: false,
    manualDistM: 2.0,       // fallback if no focus API (meters to distant object)
    lensDistMM: 50,         // distance from lens to camera
    sharpnessHistory: [],   // rolling for HUD
    sharpnessRef: null,     // calibration sharpness (no lens)
  },

  /* ── Init ───────────────────────────────────────────────────────── */

  init() {
    Camera.init(document.getElementById('capCanvas'));
    UI.init(this);
    this._bind();
    UI.show('welcome');
    UI.status('STANDBY');
  },

  /* ── Event binding ──────────────────────────────────────────────── */

  _bind() {
    $('btnStart').addEventListener('click', () => this.goSetup());
    $('btnGoScan').addEventListener('click', () => this.goScan());
    $('btnBackSetup').addEventListener('click', () => { Camera.stop(); this._stopPoll(); UI.show('setup'); });
    $('btnCalibrate').addEventListener('click', () => this.runCalibration());
    $('btnCaptureLens').addEventListener('click', () => this.captureWithLens());
    $('btnSwitchEye').addEventListener('click', () => this.switchEye());
    $('btnFinish').addEventListener('click', () => this.showResults());
    $('btnNewScan').addEventListener('click', () => this.reset());
    $('btnFlipCam').addEventListener('click', () => this._flipCam());
    $('btnExpJSON').addEventListener('click', () => Exporter.json(this.st));
    $('btnExpCSV').addEventListener('click', () => Exporter.csv(this.st));
    $('btnPrint').addEventListener('click', () => window.print());

    const ds = $('distSlider');
    ds.addEventListener('input', e => {
      this.st.lensDistMM = +e.target.value;
      $('distLbl').textContent = e.target.value + ' mm';
    });
    const eye_btns = document.querySelectorAll('.eye-btn');
    eye_btns.forEach(btn => btn.addEventListener('click', () => {
      this.st.currentEye = btn.dataset.eye;
      eye_btns.forEach(b => b.classList.toggle('sel', b.dataset.eye === this.st.currentEye));
    }));
  },

  /* ── Navigation ─────────────────────────────────────────────────── */

  goSetup() {
    UI.show('setup');
    UI.prog(10);
    UI.status('SETUP');
  },

  async goScan() {
    UI.show('scan');
    UI.prog(20);
    UI.status('CAMERA INIT');

    const vid = $('mainVid');
    const result = await Camera.start(vid);
    if (!result.ok) {
      UI.notify('Camera access failed: ' + (result.err || 'unknown'), 'err');
      return;
    }

    // Reset cycle state for current eye
    this._resetEyeState();

    const specs = Camera.specs;
    this.st.hasFocusAPI = specs.hasFocusAPI;
    UI.showSpecs(specs);

    // Update eye label
    $('scanEyeLbl').textContent = this.st.currentEye === 'right' ? 'Right' : 'Left';
    $('scanEyeCode').textContent = this.st.currentEye === 'right' ? '(OD)' : '(OS)';

    this._setPhase('ready');
    this._startPoll(vid);
    UI.status('READY', 'ok');
    UI.notify('Point camera at a distant object and press Calibrate', 'info');
  },

  /* ── Calibration (no lens) ───────────────────────────────────────── */

  async runCalibration() {
    if (this.st.isCapturing) return;
    this.st.isCapturing = true;
    this._setPhase('calibrating');
    UI.showMask(true, 'CALIBRATING…', 'Lock focus on distant object — no lens');

    const vid = $('mainVid');
    await Camera.unlockFocus();
    await delay(300);

    // Wait for AF to converge on distant scene
    const convergence = await Camera.waitFocusConverge(vid, 5000, 120);
    const focDist = Camera.getFocusDist();

    // Capture sharpness reference (no lens)
    const id = Camera.capture(vid);
    const sh = id ? Sharpness.compute(id) : { fused: 0, h: 0, v: 0 };

    this.st.sharpnessRef    = sh.fused;
    this.st.dRef            = focDist; // may be null if no focus API
    this.st.dRefSharpness   = sh;

    UI.showMask(false);
    this.st.isCapturing = false;

    if (focDist) {
      $('calDistVal').textContent = focDist.toFixed(3) + ' m';

      // Warn if calibration distance is too far for measuring negative lenses.
      // d_lens = 1/(1/dRef + P) goes negative when |P| > 1/dRef.
      // At 2 m only lenses from 0 to −0.5 D are measurable with the focus-API path.
      const maxNeg = (1 / focDist).toFixed(2);
      if (focDist > 0.8) {
        UI.notify(
          `Calibrated at ${focDist.toFixed(2)} m — ` +
          `can measure positives and negatives down to −${maxNeg} D. ` +
          `For stronger myopia, re-calibrate at ≤ ${Math.round(100/2.5)} cm.`,
          'ok');
      } else {
        UI.notify(`Calibrated — focus at ${focDist.toFixed(2)} m`, 'ok');
      }
    } else {
      // No focus API — use manual distance
      this.st.dRef = this.st.manualDistM;
      const maxNeg = (1 / this.st.manualDistM).toFixed(2);
      UI.notify(
        `No focus distance API — using ${this.st.manualDistM.toFixed(1)} m manual reference. ` +
        `Blur-profile method active (±0.5 D accuracy). ` +
        `For myopia > −${maxNeg} D, hold target at ≤ ${Math.round(100/2.5)} cm.`,
        'warn');
      $('calDistVal').textContent = this.st.manualDistM.toFixed(1) + ' m (manual)';
    }

    $('calSharpVal').textContent = Math.round(sh.fused);
    $('calCard').style.display = '';
    this._setPhase('placing');
    $('btnCaptureLens').disabled = false;
    UI.status('CALIBRATED', 'ok');
    UI.prog(35 + this.st.cycleNum * 6);
  },

  /* ── Measurement (with lens) ─────────────────────────────────────── */

  async captureWithLens() {
    if (this.st.isCapturing || !this.st.dRef) return;
    this.st.isCapturing = true;
    this._setPhase('measuring');
    $('btnCaptureLens').disabled = true;

    const vid = $('mainVid');

    // Initialise blur detector with calibration baseline
    const ref = this.st.dRefSharpness;
    BlurDetector.reset(ref ? { s: ref.fused, sH: ref.h, sV: ref.v } : null);

    UI.showMask(true, 'PLACE LENS', 'Hold lens in front of camera — auto-detecting placement…');
    await Camera.unlockFocus();

    // ── Phase 1+2: monitor sharpness stream, detect blur onset + convergence ──
    const m = await this._monitorAndConverge(vid, 14000);

    UI.showMask(false);
    this.st.isCapturing = false;

    // ── Phase 3: power computation ───────────────────────────────────────────

    // Calibration-distance validity check:
    // For P = negative, d_eff = 1/(1/dRef + P).  If |P| > 1/dRef, d_eff goes negative
    // (camera can't focus there) → must calibrate closer.
    const dRef = this.st.dRef;
    const maxNegPower = 1 / dRef;  // e.g. dRef=2m → can only measure down to −0.5 D at that cal distance

    let cycleResult;

    if (m.dLens && dRef) {
      // ── Focus-API path ──
      const res = PowerCalc.fromFocusDist(m.dLens, dRef);

      // Sanity check: if blur was large but power is tiny, AF probably locked on
      // minimum-focus end (couldn't reach d_lens) — result is unreliable.
      const blurLarge = m.blurDepth > 0.40;
      const powerTiny = Math.abs(res.power) < 0.50;
      if (res.ok && blurLarge && powerTiny) {
        UI.notify(
          `⚠ Large blur (${Math.round(m.blurDepth*100)}%) but tiny power reading — ` +
          `for lenses stronger than −${maxNegPower.toFixed(2)} D, re-calibrate at ≤ ${(1000/Math.abs(m.blurDepth*6+0.5)).toFixed(0)} cm`,
          'warn');
      }

      cycleResult = {
        ...res,
        cylinder: 0, axis: 0,
        dRef,
        dLens: m.dLens,
        sharpness: m.sh.fused,
        shH: m.sh.h, shV: m.sh.v,
        blurDepth: m.blurDepth,
        recovery: m.recovery,
        cycleNum: this.st.cycleNum + 1,
      };

      // Cylinder from H/V sharpness asymmetry at peak-blur moment
      const refSh = this.st.dRefSharpness;
      if (refSh && m.blurDepthH !== undefined) {
        const rawCyl = res.rawPower * (m.blurDepthH - m.blurDepthV) * 0.45;
        if (Math.abs(rawCyl) >= 0.25 && Math.abs(res.power) >= 0.25) {
          cycleResult.cylinder = Math.round(rawCyl / OPT_CONST.PREC) * OPT_CONST.PREC;
          cycleResult.axis     = m.blurDepthH > m.blurDepthV ? 180 : 90;
          cycleResult.method   = 'focus_shift+cylinder';
        }
      }

    } else if (m.blurDetected && m.blurDepth > 0.10) {
      // ── Blur-profile path (no focus API, but blur event was observed) ──
      // Uses blur depth AT onset (before AF compensates) — physically grounded.
      // Accuracy: ±0.5 D typical.
      const res = PowerCalc.fromBlurProfile(
        m.blurDepthH, m.blurDepthV, dRef, m.recovery);

      if (!m.goodRecovery) {
        // Camera couldn't refocus → strong negative lens or wrong cal distance
        if (dRef > 0.5) {
          UI.notify(
            `⚠ Camera could not refocus (${Math.round(m.recovery*100)}% recovery). ` +
            `For lenses stronger than −${maxNegPower.toFixed(2)} D, re-calibrate ` +
            `at ≤ ${Math.round(100/Math.abs(res.power||1))} cm for best accuracy.`,
            'warn');
        }
      }

      cycleResult = {
        ...res,
        dRef, dLens: null,
        sharpness: m.sh.fused, shH: m.sh.h, shV: m.sh.v,
        blurDepth: m.blurDepth,
        recovery: m.recovery,
        cycleNum: this.st.cycleNum + 1,
      };

    } else {
      // ── Legacy fallback: no blur event AND no focus API ──
      // (usually means lens was placed before monitoring started, or very weak lens)
      // Use convergence sharpness; accuracy is limited.
      const shRef = this.st.sharpnessRef || 1;
      const conv  = m.sh.fused;
      // Sharpness ratio after AF can only tell us if lens helped or hurt focus.
      // Map to a rough power via blur-profile method using implied blur.
      const impliedBlur = Math.max(0, 1 - conv / shRef);
      const res = impliedBlur > 0.05
        ? PowerCalc.fromBlurProfile(impliedBlur, impliedBlur, dRef, m.recovery)
        : { ok: true, power: 0, rawPower: 0, sphere: 0, cylinder: 0, axis: 0, method: 'near_plano' };

      cycleResult = {
        ...res,
        dRef, dLens: null,
        sharpness: m.sh.fused, shH: m.sh.h, shV: m.sh.v,
        blurDepth: impliedBlur, recovery: m.recovery,
        cycleNum: this.st.cycleNum + 1,
        method: res.method || 'sharpness_fallback',
      };
      if (!m.blurDetected) {
        UI.notify('Lens not auto-detected — ensure lens was in front of camera during capture', 'warn');
      }
    }

    this.st.cycles.push(cycleResult);
    this.st.cycleNum++;

    this._updateRunning();
    UI.addCycleRow(cycleResult, this.st.cycleNum);
    UI.prog(35 + this.st.cycleNum * 6);

    const done = this.st.cycleNum >= OPT_CONST.CYCLES;
    if (done) {
      this._finishEye();
    } else {
      this._setPhase('placing');
      $('btnCaptureLens').disabled = false;
      $('btnCaptureLens').textContent = `🔬 Capture Cycle ${this.st.cycleNum + 1} / ${OPT_CONST.CYCLES}`;
      $('btnCalibrate').textContent = 'Re-calibrate (optional)';
      UI.notify(`Cycle ${this.st.cycleNum} done — remove lens and repeat`, 'ok');
      UI.status(`CYCLE ${this.st.cycleNum}/${OPT_CONST.CYCLES}`, 'hot');
    }
  },

  /* ── Monitor sharpness stream: detect blur onset + wait for convergence ──
   *
   * Combines blur detection (Phase 1) with convergence waiting (Phase 2)
   * in a single polling loop so we capture the PEAK BLUR moment that
   * occurs before AF has had a chance to compensate.
   *
   * Returns: { dLens, sh, blurDetected, blurDepth, blurDepthH, blurDepthV,
   *            recovery, goodRecovery, converged }
   */
  async _monitorAndConverge(vid, timeoutMs = 14000) {
    const start        = Date.now();
    const SAMPLE_MS    = 65;
    const history      = [];
    let lensDetected   = false;
    let blurOnsetMs    = null;
    let stableCount    = 0;
    let lastSh         = this.st.dRefSharpness || { fused: 0, h: 0, v: 0 };
    let lastFd         = null;

    while (Date.now() - start < timeoutMs) {
      await delay(SAMPLE_MS);
      const id = Camera.capture(vid);
      if (!id) continue;

      const sh = Sharpness.compute(id);
      const fd = Camera.getFocusDist();
      const ev = BlurDetector.feed(sh, fd);
      history.push({ sh, fd, t: Date.now() });
      lastSh = sh;
      if (fd != null) lastFd = fd;

      // ── Lens placement detection ──
      if (!lensDetected && (ev === 'blur_onset' || ev === 'blurred')) {
        lensDetected = true;
        blurOnsetMs  = Date.now();
        const bd = Math.round(BlurDetector.blurDepth * 100);
        UI.showMask(true,
          `LENS DETECTED — ${bd}% BLUR`,
          bd > 55
            ? 'Strong defocus — auto-focusing through lens…'
            : 'Defocus detected — auto-focusing through lens…');
        UI.notify(`Blur onset: ${bd}%  (H:${Math.round(BlurDetector.blurDepthH*100)}%  V:${Math.round(BlurDetector.blurDepthV*100)}%)`, 'info');
      }

      // ── Convergence check ──
      // Wait until lens has been in place (or initial wait is over) before
      // checking stability so we don't false-trigger on the blur onset itself.
      const minWait = lensDetected ? blurOnsetMs + 600 : start + 2000;
      if (Date.now() > minWait && history.length >= 5) {
        const recent = history.slice(-5).map(h => h.sh.fused);
        const maxR = Math.max(...recent), minR = Math.min(...recent);
        const stability = maxR > 0 ? (maxR - minR) / maxR : 1;
        if (stability < 0.015) {
          stableCount++;
          if (stableCount >= 3) break;
        } else {
          stableCount = 0;
        }
      }
    }

    const shRef     = this.st.sharpnessRef || 1;
    const recovery  = Math.min(2, lastSh.fused / shRef);

    return {
      dLens:        lastFd,
      sh:           lastSh,
      blurDetected: lensDetected,
      blurDepth:    BlurDetector.blurDepth,
      blurDepthH:   BlurDetector.blurDepthH,
      blurDepthV:   BlurDetector.blurDepthV,
      recovery,
      goodRecovery: recovery > 0.78,
      converged:    stableCount >= 3,
    };
  },

  /* ── Finish current eye ─────────────────────────────────────────── */

  _finishEye() {
    const agg = PowerCalc.aggregateCycles(this.st.cycles);
    if (!agg) { UI.notify('Not enough valid readings', 'err'); return; }
    agg.cycles = this.st.cycleNum;
    this.st.results[this.st.currentEye] = agg;
    this._setPhase('done');
    UI.showFinalReading(agg, this.st.currentEye);
    $('nextBtns').style.display = '';
    UI.status('EYE DONE', 'ok');
    UI.notify(`${this.st.currentEye === 'right' ? 'Right' : 'Left'} eye complete!`, 'ok');
  },

  /* ── Switch eye ─────────────────────────────────────────────────── */

  switchEye() {
    this.st.currentEye = this.st.currentEye === 'right' ? 'left' : 'right';
    this._resetEyeState();
    $('scanEyeLbl').textContent = this.st.currentEye === 'right' ? 'Right' : 'Left';
    $('scanEyeCode').textContent = this.st.currentEye === 'right' ? '(OD)' : '(OS)';
    $('nextBtns').style.display = 'none';
    $('calCard').style.display = 'none';
    $('cycleTableBody').innerHTML = '';
    $('btnCaptureLens').textContent = `🔬 Capture Cycle 1 / ${OPT_CONST.CYCLES}`;
    $('btnCalibrate').textContent = '📐 Calibrate (no lens)';
    $('btnCaptureLens').disabled = true;
    this._setPhase('ready');
    UI.notify('Switched to ' + (this.st.currentEye === 'right' ? 'right' : 'left') + ' eye', 'info');
    UI.clearRunning();
    UI.status('READY', 'ok');
    UI.prog(35);
  },

  _resetEyeState() {
    this.st.cycles = [];
    this.st.cycleNum = 0;
    this.st.dRef = null;
    this.st.dRefSharpness = null;
    this.st.sharpnessRef = null;
    this.st.sharpnessHistory = [];
    this.st.isCapturing = false;
  },

  /* ── Results ────────────────────────────────────────────────────── */

  showResults() {
    Camera.stop();
    this._stopPoll();
    UI.show('results');
    UI.prog(100);
    UI.status('COMPLETE', 'ok');
    UI.renderResults(this.st.results);
  },

  reset() {
    Camera.stop();
    this._stopPoll();
    Object.assign(this.st, {
      phase: 'idle', cycles: [], cycleNum: 0,
      dRef: null, dRefSharpness: null, sharpnessRef: null,
      results: { right: null, left: null }, isCapturing: false,
    });
    UI.show('welcome');
    UI.prog(0);
    UI.status('STANDBY');
  },

  /* ── Running average update ─────────────────────────────────────── */

  _updateRunning() {
    const agg = PowerCalc.aggregateCycles(this.st.cycles);
    if (agg) UI.showRunning(agg);
  },

  /* ── Live poll ──────────────────────────────────────────────────── */

  _pollTimer: null,

  _startPoll(vid) {
    this._stopPoll();
    this._pollTimer = setInterval(() => {
      if (this.st.isCapturing) return;
      const id = Camera.capture(vid);
      if (!id) return;
      const sh = Sharpness.compute(id);
      this.st.sharpnessHistory.push(sh.fused);
      if (this.st.sharpnessHistory.length > 30) this.st.sharpnessHistory.shift();
      const focDist = Camera.getFocusDist();
      UI.updateHUD(sh, focDist, this.st.sharpnessRef, Camera.specs.focusRange);
      FocusGraph.push(sh.fused, focDist);
    }, 130);
  },

  _stopPoll() {
    if (this._pollTimer) { clearInterval(this._pollTimer); this._pollTimer = null; }
  },

  /* ── Camera flip ────────────────────────────────────────────────── */

  async _flipCam() {
    // Simple re-start with opposite facing mode
    Camera.stop();
    this._stopPoll();
    const vid = $('mainVid');
    // Toggle facing mode
    const prevFacing = Camera._caps?.facingMode?.[0] ?? 'environment';
    const newFacing = prevFacing === 'environment' ? 'user' : 'environment';
    // Temporarily override constraint
    Camera._overrideFacing = newFacing;
    await Camera.start(vid);
    this._startPoll(vid);
  },

  _setPhase(p) {
    this.st.phase = p;
    UI.setPhase(p, this.st.cycleNum);
  },
};
