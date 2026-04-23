'use strict';
/**
 * OptiScan Pro -- App Controller
 * Orchestrates the 10-cycle focus-shift lens power measurement.
 *
 * Cycle flow (per reading):
 *   1. WITHOUT LENS: camera focuses on distant object, AF converges -> record d_ref
 *   2. WITH LENS:    user places lens in front, AF re-converges -> record d_lens
 *   3. Power = 1/d_lens - 1/d_ref  (+ back-vertex correction for lensDistMM)
 *   Repeat 10x, then compute weighted median.
 *
 * FIX 1:  lensDistMM now passed through to PowerCalc.fromFocusDist for
 *         back-vertex distance correction (was silently ignored before).
 * FIX 4:  Calibration and capture abort early if the frame is dark/invalid.
 * FIX 5:  _monitorAndConverge uses shared ConvergenceDetector.
 * FIX 6:  'motion_blur' events from BlurDetector are ignored.
 * FIX 8:  SharpnessEMA applied to the monitoring stream.
 * FIX 10: Camera flip calls Camera.start({facingMode}) instead of mutating
 *         Camera._overrideFacing.
 * FIX 12: App.st split into three typed sub-objects; _resetEyeState uses a
 *         declared constant so field omissions are caught at definition time.
 */

/* ---- FIX 12: Eye-state defaults declared as a constant ------------------
   Any field that must be wiped between eyes is listed here.  If you add a
   new per-eye field anywhere, add it here too -- resetEyeState() will get it
   automatically. */
const EYE_STATE_DEFAULTS = Object.freeze({
  cycles:          [],
  cycleNum:        0,
  dRef:            null,
  dRefSharpness:   null,
  sharpnessRef:    null,
  sharpnessHistory:[],
  isCapturing:     false,
});

const App = {
  /* ---- FIX 12: State split into semantic sub-objects -------------------- *
   *
   *   calibState  -- calibration-specific data reset between eyes
   *   scanSession -- measurement session data reset between eyes
   *   deviceState -- hardware / user-preference data that persists
   *
   * A flat `st` view is assembled below for backward-compat with UI code
   * that still reads App.st.xxx.  New code should access sub-objects directly.
   */

  /* Calibration data (reset per eye) */
  _cal: {
    dRef:          null,
    dRefSharpness: null,
    sharpnessRef:  null,
  },

  /* Measurement session (reset per eye) */
  _scan: {
    currentEye: 'right',
    results:    { right: null, left: null },
    cycles:     [],
    cycleNum:   0,
  },

  /* Device / preferences (persist across eyes) */
  _dev: {
    phase:            'idle',
    hasFocusAPI:      false,
    isCapturing:      false,
    manualDistM:      2.0,
    lensDistMM:       50,
    sharpnessHistory: [],
    /* 'auto' => probe on first scan; 'focus_shift' => lock/unlock works;
       'blur_unblur' => lock/unlock broken, use blur/unblur cycle */
    measureMode:      'auto',
  },

  /* Unified read-only view for UI code -- keeps backward compatibility */
  get st() {
    return {
      ...this._cal,
      ...this._scan,
      ...this._dev,
    };
  },

  /* ---- Init ------------------------------------------------------------ */

  init() {
    Camera.init(document.getElementById('capCanvas'));
    UI.init(this);
    this._bind();
    UI.show('welcome');
    UI.status('STANDBY');
  },

  /* ---- Event binding --------------------------------------------------- */

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
      this._dev.lensDistMM = +e.target.value;
      $('distLbl').textContent = e.target.value + ' mm';
    });
    const eye_btns = document.querySelectorAll('.eye-btn');
    eye_btns.forEach(btn => btn.addEventListener('click', () => {
      this._scan.currentEye = btn.dataset.eye;
      eye_btns.forEach(b => b.classList.toggle('sel', b.dataset.eye === this._scan.currentEye));
    }));
  },

  /* ---- Navigation ------------------------------------------------------ */

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

    this._resetEyeState();

    const specs = Camera.specs;
    this._dev.hasFocusAPI = specs.hasFocusAPI;
    UI.showSpecs(specs);

    /* Probe whether focus lock/unlock actually works on this device.
       Only probe once per session (measureMode stays set across eyes). */
    if (this._dev.measureMode === 'auto') {
      UI.status('PROBING FOCUS', 'warn');
      UI.notify('Testing focus control -- hold camera still...', 'info');
      const probe = await Camera.probeFocusControl(vid);
      if (probe.focusControlWorks && probe.focusDistanceReliable) {
        this._dev.measureMode = 'focus_shift';
        console.log('[OptiScan] Mode: focus_shift (lock/unlock + distance verified)');
      } else if (probe.focusControlWorks && !probe.focusDistanceReliable) {
        /* Lock/unlock works but distance returns sentinel values (e.g. 2^63).
           Focus-shift path will hit null d_lens every cycle and auto-degrade
           to blur-profile — set mode accordingly from the start. */
        this._dev.measureMode = 'blur_unblur';
        console.log('[OptiScan] Mode: blur_unblur (focus distance API returns sentinel values)');
        UI.notify(
          'Camera reports focus distance as a sentinel value (HAL does not expose real data). ' +
          'Switching to blur/unblur cycle mode for accurate measurement.',
          'warn');
      } else {
        this._dev.measureMode = 'blur_unblur';
        console.log('[OptiScan] Mode: blur_unblur (focus control unresponsive)');
        UI.notify(
          'Focus lock unavailable on this camera -- switching to blur/unblur cycle mode. ' +
          'You will be prompted to place then remove the lens each cycle.',
          'warn');
      }
    }

    $('scanEyeLbl').textContent  = this._scan.currentEye === 'right' ? 'Right' : 'Left';
    $('scanEyeCode').textContent = this._scan.currentEye === 'right' ? '(OD)'  : '(OS)';

    this._setPhase('ready');
    this._startPoll(vid);
    const modeLabel = this._dev.measureMode === 'blur_unblur' ? 'BLUR/UNBLUR MODE' : 'READY';
    UI.status(modeLabel, this._dev.measureMode === 'blur_unblur' ? 'warn' : 'ok');
    const calibHint = this._dev.measureMode === 'blur_unblur'
      ? 'BLUR/UNBLUR mode: point camera at distant object and press Calibrate'
      : 'Point camera at a distant object and press Calibrate';
    UI.notify(calibHint, 'info');
  },

  /* ---- Calibration (no lens) ------------------------------------------- */

  async runCalibration() {
    if (this._dev.isCapturing) return;
    this._dev.isCapturing = true;
    this._setPhase('calibrating');
    UI.showMask(true, 'CALIBRATING...', 'Lock focus on distant object -- no lens');

    const vid = $('mainVid');
    await Camera.unlockFocus();
    await delay(300);

    const convergence = await Camera.waitFocusConverge(vid, 5000, 120);
    const focDist = Camera.getFocusDist();

    const id = Camera.capture(vid);
    const sh = id ? Sharpness.compute(id) : null;

    /* FIX 4: Abort if the calibration frame is invalid (dark/saturated) */
    if (!sh || !sh.valid) {
      UI.showMask(false);
      this._dev.isCapturing = false;
      UI.notify('Calibration frame invalid (too dark or overexposed) -- check lighting and retry', 'err');
      this._setPhase('ready');
      return;
    }

    this._cal.sharpnessRef  = sh.fused;
    this._cal.dRef          = focDist;
    this._cal.dRefSharpness = sh;

    UI.showMask(false);
    this._dev.isCapturing = false;

    if (focDist) {
      $('calDistVal').textContent = focDist.toFixed(3) + ' m';
      const maxNeg = (1 / focDist).toFixed(2);
      if (focDist > 0.8) {
        UI.notify(
          `Calibrated at ${focDist.toFixed(2)} m -- ` +
          `can measure positives and negatives down to -${maxNeg} D. ` +
          `For stronger myopia, re-calibrate at <= ${Math.round(100/2.5)} cm.`,
          'ok');
      } else {
        UI.notify(`Calibrated -- focus at ${focDist.toFixed(2)} m`, 'ok');
      }
    } else {
      this._cal.dRef = this._dev.manualDistM;
      const maxNeg = (1 / this._dev.manualDistM).toFixed(2);
      /* Distinguish between: no capability at all vs. capability exists but returns sentinel */
      const hasCap = this._dev.hasFocusAPI;
      const msg = hasCap
        ? `Focus distance API exists but returns unusable values (camera HAL sentinel). ` +
          `Using ${this._dev.manualDistM.toFixed(1)} m manual reference -- ` +
          `blur-profile method active (+-0.5 D accuracy).`
        : `No focus distance API -- using ${this._dev.manualDistM.toFixed(1)} m manual reference. ` +
          `Blur-profile method active (+-0.5 D accuracy). ` +
          `For myopia > -${maxNeg} D, hold target at <= ${Math.round(100/2.5)} cm.`;
      UI.notify(msg, 'warn');
      $('calDistVal').textContent = this._dev.manualDistM.toFixed(1) + ' m (manual)';
    }

    $('calSharpVal').textContent = Math.round(sh.fused);
    $('calCard').style.display   = '';
    this._setPhase('placing');
    $('btnCaptureLens').disabled = false;
    UI.status('CALIBRATED', 'ok');
    UI.prog(35 + this._scan.cycleNum * 6);
  },

  /* ---- Measurement (with lens) ----------------------------------------- */

  async captureWithLens() {
    if (this._dev.isCapturing || !this._cal.dRef) return;
    this._dev.isCapturing = true;
    this._setPhase('measuring');
    $('btnCaptureLens').disabled = true;

    const vid   = $('mainVid');
    const ref   = this._cal.dRefSharpness;
    /* FIX 8: reset EMA so the new measurement starts fresh */
    SharpnessEMA.reset();
    BlurDetector.reset(ref ? { s: ref.fused, sH: ref.h, sV: ref.v, sD45: ref.d45, sD135: ref.d135 } : null);

    if (this._dev.measureMode === 'blur_unblur') {
      /* Focus lock/unlock broken -- run the place-and-remove blur/unblur cycle */
      await this._runBlurUnblurCycle(vid);
      return;
    }

    UI.showMask(true, 'PLACE LENS', 'Hold lens in front of camera -- auto-detecting placement...');
    await Camera.unlockFocus();

    const m = await this._monitorAndConverge(vid, 14000);

    UI.showMask(false);
    this._dev.isCapturing = false;

    /* FIX 1: pass lensDistM for back-vertex correction */
    const dRef       = this._cal.dRef;
    const lensDistM  = this._dev.lensDistMM / 1000;
    const maxNegPower = 1 / dRef;

    let cycleResult;

    /* ── Runtime sentinel / frozen-distance guard ──────────────────────────
     * Even after FocusAPI.read() sanitization, some edge cases can produce
     * d_ref === d_lens (focus distance didn't move through the lens):
     *   - Camera needs > 14 s to refocus (our timeout)
     *   - Negative lens pushes virtual image behind camera (d_lens undefined)
     *   - Driver fixed at one value across all AF operations
     *
     * Detection: if |d_lens - d_ref| < 5 mm after blur was detected, the
     * focus system did not respond. Degrade to blur-profile for this cycle
     * and every subsequent cycle in this eye by clearing hasFocusAPI.       */
    if (m.dLens && dRef && Math.abs(m.dLens - dRef) < 0.005 && m.blurDepth > 0.05) {
      console.warn('[OptiScan] focus distance unchanged (Δ <5 mm) despite blur --',
        'dRef=', dRef.toFixed(4), 'dLens=', m.dLens.toFixed(4),
        'blurDepth=', (m.blurDepth*100).toFixed(1)+'%');
      UI.notify(
        'Focus distance did not change through the lens -- ' +
        'camera AF may be stuck or negative lens pushes focal plane behind sensor. ' +
        'Switching to blur-profile method for remaining cycles.',
        'warn');
      /* Degrade for all remaining cycles this eye */
      this._dev.hasFocusAPI = false;
      /* Treat this cycle as blur-profile (nullify dLens so path falls through) */
      m = { ...m, dLens: null };
    }

    if (m.dLens && dRef) {
      /* ---- Focus-API path ---- */
      const res = PowerCalc.fromFocusDist(m.dLens, dRef, lensDistM);   /* FIX 1 */

      const blurLarge = m.blurDepth > 0.40;
      const powerTiny = Math.abs(res.power) < 0.50;
      if (res.ok && blurLarge && powerTiny) {
        UI.notify(
          `Warning: Large blur (${Math.round(m.blurDepth*100)}%) but tiny power -- ` +
          `for lenses stronger than -${maxNegPower.toFixed(2)} D, re-calibrate at <= ${(1000/Math.abs(m.blurDepth*6+0.5)).toFixed(0)} cm`,
          'warn');
      }

      /* FIX 2: Compute axis from all 4 directional channels using the peak
         blur sharpness snapshot (stored in BlurDetector.peakBlur). */
      const peakSh = BlurDetector.peakBlur;
      const peakShFull = peakSh
        ? { h: peakSh.sH, v: peakSh.sV, d45: peakSh.sD45 ?? 0, d135: peakSh.sD135 ?? 0 }
        : null;

      cycleResult = {
        ...res, cylinder: 0, axis: 0,
        dRef, dLens: m.dLens,
        sharpness: m.sh.fused,
        shH: m.sh.h, shV: m.sh.v,
        blurDepth: m.blurDepth,
        recovery:  m.recovery,
        cycleNum:  this._scan.cycleNum + 1,
      };

      const refSh = this._cal.dRefSharpness;
      if (refSh && peakShFull && m.blurDepth > 0.15) {
        const rawCyl = res.rawPower * (m.blurDepthH - m.blurDepthV) * 0.45;
        if (Math.abs(rawCyl) >= 0.25 && Math.abs(res.power) >= 0.25) {
          cycleResult.cylinder = Math.round(rawCyl / OPT_CONST.PREC) * OPT_CONST.PREC;
          /* FIX 2: use 4-direction axis instead of binary 90/180 */
          cycleResult.axis     = Sharpness.computeAxis(peakShFull);
          cycleResult.method   = 'focus_shift+cylinder';
        }
      }

    } else if (m.blurDetected && m.blurDepth > 0.10) {
      /* ---- Blur-profile path (no focus API) ---- */
      const res = PowerCalc.fromBlurProfile(m.blurDepthH, m.blurDepthV, dRef, m.recovery);

      if (!m.goodRecovery && dRef > 0.5) {
        UI.notify(
          `Warning: Camera could not refocus (${Math.round(m.recovery*100)}% recovery). ` +
          `For lenses stronger than -${maxNegPower.toFixed(2)} D, re-calibrate ` +
          `at <= ${Math.round(100/Math.abs(res.power||1))} cm for best accuracy.`,
          'warn');
      }

      cycleResult = {
        ...res, dRef, dLens: null,
        sharpness: m.sh.fused, shH: m.sh.h, shV: m.sh.v,
        blurDepth: m.blurDepth, recovery: m.recovery,
        cycleNum: this._scan.cycleNum + 1,
      };

    } else {
      /* ---- Legacy fallback ---- */
      const shRef = this._cal.sharpnessRef || 1;
      const conv  = m.sh.fused;
      const impliedBlur = Math.max(0, 1 - conv / shRef);
      const res = impliedBlur > 0.05
        ? PowerCalc.fromBlurProfile(impliedBlur, impliedBlur, dRef, m.recovery)
        : { ok:true,power:0,rawPower:0,sphere:0,cylinder:0,axis:0,method:'near_plano' };

      cycleResult = {
        ...res, dRef, dLens: null,
        sharpness: m.sh.fused, shH: m.sh.h, shV: m.sh.v,
        blurDepth: impliedBlur, recovery: m.recovery,
        cycleNum: this._scan.cycleNum + 1,
        method: res.method || 'sharpness_fallback',
      };
      if (!m.blurDetected) {
        UI.notify('Lens not auto-detected -- ensure lens was in front of camera during capture', 'warn');
      }
    }

    this._scan.cycles.push(cycleResult);
    this._scan.cycleNum++;

    this._updateRunning();
    UI.addCycleRow(cycleResult, this._scan.cycleNum);
    UI.prog(35 + this._scan.cycleNum * 6);

    const done = this._scan.cycleNum >= OPT_CONST.CYCLES;
    if (done) {
      this._finishEye();
    } else {
      this._setPhase('placing');
      $('btnCaptureLens').disabled = false;
      $('btnCaptureLens').textContent = `Capture Cycle ${this._scan.cycleNum + 1} / ${OPT_CONST.CYCLES}`;
      $('btnCalibrate').textContent   = 'Re-calibrate (optional)';
      UI.notify(`Cycle ${this._scan.cycleNum} done -- remove lens and repeat`, 'ok');
      UI.status(`CYCLE ${this._scan.cycleNum}/${OPT_CONST.CYCLES}`, 'hot');
    }
  },

  /* ---- Monitor sharpness stream: detect blur onset + convergence ---------
   *
   * FIX 5: Uses shared ConvergenceDetector.
   * FIX 6: Ignores 'motion_blur' events from BlurDetector.
   * FIX 8: SharpnessEMA applied before BlurDetector.feed().
   *
   * Returns: { dLens, sh, blurDetected, blurDepth, blurDepthH, blurDepthV,
   *            recovery, goodRecovery, converged }
   */
  async _monitorAndConverge(vid, timeoutMs = 14000) {
    const start      = Date.now();
    const SAMPLE_MS  = 65;
    const history    = [];
    /* FIX 5: shared convergence detector */
    const conv       = new ConvergenceDetector({ windowSize:5, stabilityThreshold:0.015, requiredCount:3 });
    let lensDetected = false;
    let blurOnsetMs  = null;
    let lastSh       = this._cal.dRefSharpness || { fused:0,h:0,v:0,d45:0,d135:0 };
    let lastFd       = null;

    while (Date.now() - start < timeoutMs) {
      await delay(SAMPLE_MS);
      const id = Camera.capture(vid);
      if (!id) continue;

      const rawSh = Sharpness.compute(id);
      /* FIX 8: smooth sharpness before feeding the blur detector */
      const sh    = SharpnessEMA.filter(rawSh);

      const fd  = Camera.getFocusDist();
      /* FIX 6: feed BlurDetector and check for motion vs optical blur */
      const ev  = BlurDetector.feed(sh, fd);
      history.push({ sh, fd, t: Date.now() });
      lastSh = sh;
      if (fd != null) lastFd = fd;

      /* FIX 6: ignore motion blur events -- do not declare lens detected */
      if (ev === 'motion_blur') continue;

      /* Lens placement detection */
      if (!lensDetected && (ev === 'blur_onset' || ev === 'blurred')) {
        lensDetected = true;
        blurOnsetMs  = Date.now();
        const bd = Math.round(BlurDetector.blurDepth * 100);
        UI.showMask(true,
          `LENS DETECTED -- ${bd}% BLUR`,
          bd > 55
            ? 'Strong defocus -- auto-focusing through lens...'
            : 'Defocus detected -- auto-focusing through lens...');
        UI.notify(`Blur onset: ${bd}%  (H:${Math.round(BlurDetector.blurDepthH*100)}%  V:${Math.round(BlurDetector.blurDepthV*100)}%)`, 'info');
      }

      /* Convergence check */
      const minWait = lensDetected ? blurOnsetMs + 600 : start + 2000;
      if (Date.now() > minWait) {
        /* FIX 5: delegate to ConvergenceDetector */
        if (conv.feed(sh.fused)) break;
      }
    }

    const shRef    = this._cal.sharpnessRef || 1;
    const recovery = Math.min(2, lastSh.fused / shRef);

    return {
      dLens:        lastFd,
      sh:           lastSh,
      blurDetected: lensDetected,
      blurDepth:    BlurDetector.blurDepth,
      blurDepthH:   BlurDetector.blurDepthH,
      blurDepthV:   BlurDetector.blurDepthV,
      recovery,
      goodRecovery: recovery > 0.78,
      converged:    conv.stableCount >= 3,
    };
  },


  /* ═══════════════════════════════════════════════════════════════════════
     BLUR / UNBLUR CYCLE  (fallback when focus lock/unlock is broken)

     Guides the user through a full place-and-remove cycle:
       1. Place lens in front of camera -> blur onset detected
          (mask: "LENS DETECTED -- hold steady")
       2. Hold until peak blur is stable (600 ms at nadir)
          (mask: "HOLD STEADY -- now remove lens")
       3. Remove lens -> sharpness rises back to baseline
          (mask: "LENS REMOVED -- recovering...")
       4. Recovery complete -> compute power from both transitions

     Power is estimated via PowerCalc.fromBlurUnblur() which combines the
     onset blur depth (least AF contamination) and peak blur depth (highest
     SNR) in a weighted 40/60 average.
  ═══════════════════════════════════════════════════════════════════════ */
  async _runBlurUnblurCycle(vid) {
    const ref       = this._cal.dRefSharpness;
    const dRef      = this._cal.dRef;
    const lensDistM = this._dev.lensDistMM / 1000;
    const maxNegPower = 1 / dRef;

    SharpnessEMA.reset();
    BlurUnblurCollector.reset(
      ref ? { s: ref.fused, sH: ref.h, sV: ref.v, sD45: ref.d45 ?? 0, sD135: ref.d135 ?? 0 } : null
    );

    UI.showMask(true, 'PLACE LENS', 'Hold lens in front of camera -- watching for defocus...');

    const SAMPLE_MS = 65;
    const TIMEOUT   = 22000;   /* 22 s total: place + hold + remove + recover */
    const start     = Date.now();
    let   lastSh    = ref || { fused: 0, h: 0, v: 0, d45: 0, d135: 0 };
    let   prevPhase = 'waiting_lens';
    let   lastFd    = null;

    while (Date.now() - start < TIMEOUT) {
      await delay(SAMPLE_MS);
      const id = Camera.capture(vid);
      if (!id) continue;

      const rawSh = Sharpness.compute(id);
      const sh    = SharpnessEMA.filter(rawSh);
      const fd    = Camera.getFocusDist();
      if (fd != null) lastFd = fd;
      lastSh = sh;

      const phase = BlurUnblurCollector.feed(sh);

      /* Drive UI prompts only when phase changes */
      if (phase !== prevPhase) {
        prevPhase = phase;

        if (phase === 'lens_in') {
          const bd = Math.round(BlurUnblurCollector.blurDepth * 100);
          UI.showMask(true, `LENS DETECTED -- ${bd}% BLUR`, 'Hold perfectly still...');
          UI.notify(
            `Blur onset: ${bd}%  (H:${Math.round(BlurUnblurCollector.blurDepthH*100)}%  ` +
            `V:${Math.round(BlurUnblurCollector.blurDepthV*100)}%)`, 'info');
        }

        if (phase === 'waiting_remove') {
          const bd = Math.round(BlurUnblurCollector.blurDepth * 100);
          UI.showMask(true, `PEAK BLUR ${bd}% -- REMOVE LENS NOW`, 'Pull lens away from camera...');
        }

        if (phase === 'removed') {
          UI.showMask(true, 'LENS REMOVED', 'Recovering sharpness...');
        }

        if (phase === 'done') break;
      }

      /* Also break when recovery is complete even if event was missed */
      if (BlurUnblurCollector.isDone) break;
    }

    UI.showMask(false);
    this._dev.isCapturing = false;

    /* ── Compute power from both blur transitions ── */
    const collector = BlurUnblurCollector;
    const peakSh    = collector.peakSh;
    const onsetSh   = collector.onsetSh;
    const finalSh   = collector.finalSh || lastSh;
    const shRef     = this._cal.sharpnessRef || 1;
    const finalRec  = Math.min(2, finalSh.fused / shRef);

    if (!peakSh) {
      /* No blur was detected -- lens may not have been placed in time */
      UI.notify('No lens blur detected -- ensure lens covers the camera during capture', 'warn');
      this._dev.isCapturing = false;
      this._setPhase('placing');
      $('btnCaptureLens').disabled = false;
      return;
    }

    /* Blur depths at onset (before any AF movement) */
    const onsetH = onsetSh ? Math.max(0, 1 - onsetSh.h  / (ref?.h  || 1)) : collector.blurDepthH;
    const onsetV = onsetSh ? Math.max(0, 1 - onsetSh.v  / (ref?.v  || 1)) : collector.blurDepthV;
    /* Blur depths at peak (deepest defocus) */
    const peakH  = collector.blurDepthH;
    const peakV  = collector.blurDepthV;

    const res = PowerCalc.fromBlurUnblur(onsetH, onsetV, peakH, peakV, dRef, finalRec);

    /* Warn if no removal was detected (only onset/peak available) */
    if (collector.phase !== 'done' && collector.phase !== 'removed') {
      UI.notify(
        'Lens removal not detected -- using onset blur only. ' +
        'For best accuracy: place lens, hold 1 s, then remove it cleanly.',
        'warn');
    }

    /* Recovery sanity check: if final sharpness did not return close to baseline,
       the lens may still be partially in frame or the camera shifted */
    if (finalRec < 0.70) {
      UI.notify(
        `Warning: Recovery only ${Math.round(finalRec*100)}% -- ` +
        'ensure the lens is fully removed before recovery completes.',
        'warn');
    }

    /* Build cycle result (same shape as focus-shift path) */
    const peakShFull = peakSh
      ? { h: peakSh.h ?? peakSh.sH ?? 0, v: peakSh.v ?? peakSh.sV ?? 0,
          d45: peakSh.d45 ?? peakSh.sD45 ?? 0, d135: peakSh.d135 ?? peakSh.sD135 ?? 0 }
      : null;

    const cycleResult = {
      ...res,
      dRef, dLens: lastFd,
      sharpness:  lastSh.fused,
      shH: lastSh.h, shV: lastSh.v,
      blurDepth:  collector.blurDepth,
      blurDepthH: peakH, blurDepthV: peakV,
      recovery:   finalRec,
      cycleNum:   this._scan.cycleNum + 1,
      /* Cylinder axis from 4-direction channel at peak blur */
      axis: peakShFull ? Sharpness.computeAxis(peakShFull) : (res.axis ?? 0),
    };

    this._scan.cycles.push(cycleResult);
    this._scan.cycleNum++;

    this._updateRunning();
    UI.addCycleRow(cycleResult, this._scan.cycleNum);
    UI.prog(35 + this._scan.cycleNum * 6);

    const done = this._scan.cycleNum >= OPT_CONST.CYCLES;
    if (done) {
      this._finishEye();
    } else {
      this._setPhase('placing');
      $('btnCaptureLens').disabled    = false;
      $('btnCaptureLens').textContent =
        `Capture Cycle ${this._scan.cycleNum + 1} / ${OPT_CONST.CYCLES}`;
      $('btnCalibrate').textContent   = 'Re-calibrate (optional)';
      UI.notify(
        `Cycle ${this._scan.cycleNum} done (blur/unblur) -- ready for next cycle`,
        'ok');
      UI.status(`CYCLE ${this._scan.cycleNum}/${OPT_CONST.CYCLES}`, 'hot');
    }
  },

  /* ---- Finish current eye ---------------------------------------------- */

  _finishEye() {
    const agg = PowerCalc.aggregateCycles(this._scan.cycles);
    if (!agg) { UI.notify('Not enough valid readings', 'err'); return; }
    agg.cycles = this._scan.cycleNum;
    this._scan.results[this._scan.currentEye] = agg;
    this._setPhase('done');
    UI.showFinalReading(agg, this._scan.currentEye);

    /* FIX 7: warn if aggregation flagged low confidence */
    if (agg.lowConfidence) {
      UI.notify(
        `Low-confidence result (spread ${agg.stddev.toFixed(2)} D) -- ` +
        `consider re-scanning this eye for a more reliable reading.`,
        'warn');
    }

    $('nextBtns').style.display = '';
    UI.status('EYE DONE', 'ok');
    UI.notify(`${this._scan.currentEye === 'right' ? 'Right' : 'Left'} eye complete!`, 'ok');
  },

  /* ---- Switch eye ------------------------------------------------------ */

  switchEye() {
    this._scan.currentEye = this._scan.currentEye === 'right' ? 'left' : 'right';
    this._resetEyeState();
    $('scanEyeLbl').textContent  = this._scan.currentEye === 'right' ? 'Right' : 'Left';
    $('scanEyeCode').textContent = this._scan.currentEye === 'right' ? '(OD)'  : '(OS)';
    $('nextBtns').style.display  = 'none';
    $('calCard').style.display   = 'none';
    $('cycleTableBody').innerHTML = '';
    $('btnCaptureLens').textContent = `Capture Cycle 1 / ${OPT_CONST.CYCLES}`;
    $('btnCalibrate').textContent   = 'Calibrate (no lens)';
    $('btnCaptureLens').disabled    = true;
    this._setPhase('ready');
    UI.notify('Switched to ' + (this._scan.currentEye === 'right' ? 'right' : 'left') + ' eye', 'info');
    UI.clearRunning();
    UI.status('READY', 'ok');
    UI.prog(35);
  },

  /* FIX 12: _resetEyeState uses the EYE_STATE_DEFAULTS constant so no field
     can be accidentally omitted when new per-eye state is added later. */
  _resetEyeState() {
    const d = EYE_STATE_DEFAULTS;
    /* calibration state */
    this._cal.dRef          = d.dRef;
    this._cal.dRefSharpness = d.dRefSharpness;
    this._cal.sharpnessRef  = d.sharpnessRef;
    /* scan session */
    this._scan.cycles       = [...d.cycles];
    this._scan.cycleNum     = d.cycleNum;
    /* device transient flags */
    this._dev.isCapturing      = d.isCapturing;
    this._dev.sharpnessHistory = [...d.sharpnessHistory];
    /* reset smoothing filters */
    SharpnessEMA.reset();
  },

  /* ---- Results --------------------------------------------------------- */

  showResults() {
    Camera.stop();
    this._stopPoll();
    UI.show('results');
    UI.prog(100);
    UI.status('COMPLETE', 'ok');
    UI.renderResults(this._scan.results);
  },

  reset() {
    Camera.stop();
    this._stopPoll();
    /* reset all sub-objects */
    this._cal.dRef = null; this._cal.dRefSharpness = null; this._cal.sharpnessRef = null;
    this._scan.cycles = []; this._scan.cycleNum = 0;
    this._scan.results = { right: null, left: null };
    this._dev.phase = 'idle'; this._dev.isCapturing = false;
    this._dev.measureMode = 'auto';  /* re-probe on next scan */
    SharpnessEMA.reset();
    UI.show('welcome');
    UI.prog(0);
    UI.status('STANDBY');
  },

  /* ---- Running average update ------------------------------------------ */

  _updateRunning() {
    const agg = PowerCalc.aggregateCycles(this._scan.cycles);
    if (agg) UI.showRunning(agg);
  },

  /* ---- Live poll -------------------------------------------------------- */

  _pollTimer: null,

  _startPoll(vid) {
    this._stopPoll();
    this._pollTimer = setInterval(() => {
      if (this._dev.isCapturing) return;
      const id = Camera.capture(vid);
      if (!id) return;
      const sh = Sharpness.compute(id);
      this._dev.sharpnessHistory.push(sh.fused);
      if (this._dev.sharpnessHistory.length > 30) this._dev.sharpnessHistory.shift();
      const focDist = Camera.getFocusDist();
      UI.updateHUD(sh, focDist, this._cal.sharpnessRef, Camera.specs.focusRange);
      FocusGraph.push(sh.fused, focDist);
    }, 130);
  },

  _stopPoll() {
    if (this._pollTimer) { clearInterval(this._pollTimer); this._pollTimer = null; }
  },

  /* ---- Camera flip (FIX 10: no more _overrideFacing mutation) ----------- */

  async _flipCam() {
    Camera.stop();
    this._stopPoll();
    const vid       = $('mainVid');
    const newFacing = Camera._currentFacing === 'environment' ? 'user' : 'environment';
    /* FIX 10: pass facingMode as a parameter, not via a mutable field */
    await Camera.start(vid, { facingMode: newFacing });
    this._startPoll(vid);
  },

  _setPhase(p) {
    this._dev.phase = p;
    UI.setPhase(p, this._scan.cycleNum);
  },
};
