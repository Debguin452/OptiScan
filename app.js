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
    const sh = id ? Sharpness.compute(id) : { lap: 0, h: 0, v: 0 };

    this.st.sharpnessRef = sh.lap;
    this.st.dRef = focDist; // may be null if no focus API
    this.st.dRefSharpness = sh;

    UI.showMask(false);
    this.st.isCapturing = false;

    if (focDist) {
      UI.notify(`Calibrated — focus at ${focDist.toFixed(2)} m`, 'ok');
      $('calDistVal').textContent = focDist.toFixed(3) + ' m';
    } else {
      // No focus API — use manual distance
      this.st.dRef = this.st.manualDistM;
      UI.notify('No focus API — using manual reference distance', 'warn');
      $('calDistVal').textContent = this.st.manualDistM.toFixed(1) + ' m (manual)';
    }

    $('calSharpVal').textContent = Math.round(sh.lap);
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
    UI.showMask(true, 'MEASURING…', 'Hold lens still — waiting for focus to settle');

    // Unlock so camera re-focuses through lens
    await Camera.unlockFocus();
    await delay(400);

    // Wait for AF to converge with lens in front
    const convergence = await Camera.waitFocusConverge(vid, 6000, 120);
    const dLens = Camera.getFocusDist();
    const id = Camera.capture(vid);
    const sh = id ? Sharpness.compute(id) : { lap: 0, h: 0, v: 0 };

    UI.showMask(false);
    this.st.isCapturing = false;

    // Compute power
    let cycleResult;
    if (dLens && this.st.dRef) {
      const res = PowerCalc.fromFocusDist(dLens, this.st.dRef);
      cycleResult = {
        ...res,
        cylinder: 0, axis: 0,
        dRef: this.st.dRef,
        dLens,
        sharpness: sh.lap,
        shH: sh.h, shV: sh.v,
        cycleNum: this.st.cycleNum + 1,
      };

      // Try sharpness profile for cylinder if we have H/V sharpness data
      if (this.st.dRefSharpness) {
        const shRefH = this.st.dRefSharpness.h;
        const shRefV = this.st.dRefSharpness.v;
        // Detect meridional asymmetry in sharpness recovery
        // If H sharpness recovered more than V, the lens has more H power
        const hRatio = shRefH > 0 ? sh.h / shRefH : 1;
        const vRatio = shRefV > 0 ? sh.v / shRefV : 1;
        const asymmetry = Math.abs(hRatio - vRatio);
        if (asymmetry > 0.08 && Math.abs(res.power) > 0.25) {
          // Estimate cylinder contribution from sharpness imbalance
          const cylEstimate = res.rawPower * (hRatio - vRatio) * 0.4;
          cycleResult.cylinder = Math.round(cylEstimate / OPT_CONST.PREC) * OPT_CONST.PREC;
          cycleResult.axis = hRatio > vRatio ? 180 : 90;
          cycleResult.method = 'focus_shift+cylinder';
        }
      }
    } else {
      // Focus API unavailable — use sharpness comparison with manual distance
      // Estimate relative power from sharpness at fixed distance
      const lapRef = this.st.sharpnessRef || 1;
      const lapLens = sh.lap;
      // If sharpness with lens is higher, lens helps focus → converging (positive power)
      // This is a rough relative estimate; we use manual distance as pivot
      const sharpRatio = lapLens / lapRef;
      // Rough: P ≈ (sharpness improvement ratio - 1) / distance_factor
      const dM = this.st.manualDistM;
      const estimatedDLens = sharpRatio > 1 ? dM / sharpRatio : dM * sharpRatio;
      const res = PowerCalc.fromFocusDist(estimatedDLens, dM);
      cycleResult = {
        ...res,
        cylinder: 0, axis: 0,
        dRef: dM, dLens: estimatedDLens,
        sharpness: sh.lap, shH: sh.h, shV: sh.v,
        cycleNum: this.st.cycleNum + 1,
        method: 'sharpness_fallback',
      };
    }

    this.st.cycles.push(cycleResult);
    this.st.cycleNum++;

    // Update running average
    this._updateRunning();
    UI.addCycleRow(cycleResult, this.st.cycleNum);
    UI.prog(35 + this.st.cycleNum * 6);

    const done = this.st.cycleNum >= OPT_CONST.CYCLES;
    if (done) {
      this._finishEye();
    } else {
      // Ready for next cycle
      this._setPhase('placing');
      $('btnCaptureLens').disabled = false;
      $('btnCaptureLens').textContent = `🔬 Capture Cycle ${this.st.cycleNum + 1} / ${OPT_CONST.CYCLES}`;
      $('btnCalibrate').textContent = 'Re-calibrate (optional)';
      UI.notify(`Cycle ${this.st.cycleNum} done — remove lens and repeat`, 'ok');
      UI.status(`CYCLE ${this.st.cycleNum}/${OPT_CONST.CYCLES}`, 'hot');
    }
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
      this.st.sharpnessHistory.push(sh.lap);
      if (this.st.sharpnessHistory.length > 30) this.st.sharpnessHistory.shift();
      const focDist = Camera.getFocusDist();
      UI.updateHUD(sh, focDist, this.st.sharpnessRef, Camera.specs.focusRange);
      FocusGraph.push(sh.lap, focDist);
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
