'use strict';
/**
 * OptiScan Pro — UI Module
 * All DOM manipulation, HUD updates, and visualization rendering.
 */

/* ── Focus Graph (sharpness + focus distance over time) ─────────────── */
const FocusGraph = {
  _canvas: null, _ctx: null,
  _data: [],   // {lap, focDist, t}
  _maxPts: 180,

  init(canvas) {
    this._canvas = canvas;
    this._ctx = canvas.getContext('2d');
    this._resize();
    window.addEventListener('resize', () => this._resize());
  },

  _resize() {
    const w = this._canvas.parentElement?.clientWidth || 400;
    this._canvas.width = w; this._canvas.height = 80;
  },

  push(lap, focDist) {
    this._data.push({ lap, focDist, t: Date.now() });
    if (this._data.length > this._maxPts) this._data.shift();
    this._draw();
  },

  clear() { this._data = []; this._draw(); },

  _draw() {
    if (!this._canvas) return;
    const cv = this._canvas, ctx = this._ctx;
    const W = cv.width, H = cv.height;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#08162a'; ctx.fillRect(0, 0, W, H);

    const n = this._data.length;
    if (n < 2) return;

    const laps = this._data.map(d => d.lap).filter(Boolean);
    const maxLap = Math.max(...laps) || 1;

    // Sharpness line
    ctx.strokeStyle = 'rgba(0,229,255,0.75)'; ctx.lineWidth = 2;
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * W;
      const y = H - 4 - (this._data[i].lap / maxLap) * (H - 8);
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.stroke();

    // Focus distance line (purple)
    const fds = this._data.filter(d => d.focDist != null);
    if (fds.length > 1) {
      const minFD = Math.min(...fds.map(d => d.focDist));
      const maxFD = Math.max(...fds.map(d => d.focDist)) + 0.01;
      ctx.strokeStyle = 'rgba(177,151,252,0.6)'; ctx.lineWidth = 1.5;
      ctx.beginPath();
      let first = true;
      for (let i = 0; i < n; i++) {
        if (this._data[i].focDist == null) continue;
        const x = (i / (n - 1)) * W;
        const y = H - 4 - ((this._data[i].focDist - minFD) / (maxFD - minFD)) * (H - 8);
        first ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
        first = false;
      }
      ctx.stroke();
    }

    // Labels
    ctx.fillStyle = 'rgba(107,151,181,0.5)';
    ctx.font = '9px JetBrains Mono,monospace';
    ctx.fillText('sharpness', 3, 12);
    if (fds.length > 1) { ctx.fillStyle = 'rgba(177,151,252,0.5)'; ctx.fillText('focus dist', 3, 23); }
  },
};

/* ── UI Controller ───────────────────────────────────────────────────── */
const UI = {
  _app: null,

  init(app) { this._app = app; },

  show(id) {
    document.querySelectorAll('.step').forEach(s => s.classList.remove('on'));
    const el = document.getElementById('step-' + id);
    if (el) el.classList.add('on');
    window.scrollTo({ top: 0, behavior: 'smooth' });
    FocusGraph.init(document.getElementById('focusGraph'));
  },

  prog(p) { $('pBar').style.width = p + '%'; },
  status(txt, type) {
    const b = $('sBadge'); b.textContent = txt;
    b.className = 'badge' + (type ? ' ' + type : '');
  },
  notify(msg, type = 'info') {
    const n = $('notif'); n.textContent = msg;
    n.className = 'notif ' + type + ' show';
    clearTimeout(n._t); n._t = setTimeout(() => n.classList.remove('show'), 3500);
  },
  showMask(show, txt, sub) {
    const m = $('capMask'); m.classList.toggle('show', show);
    if (txt) $('capTxt').textContent = txt;
    const s = $('capSub'); if (s && sub) s.textContent = sub;
  },

  /* ── Phase gating ────────────────────────────────────────────────── */
  setPhase(phase, cycleNum) {
    const phases = { calibrating: 0, ready: 1, placing: 2, measuring: 3, done: 4 };
    const n = OPT_CONST.CYCLES;

    // Instruction banner
    const banners = {
      ready:      { txt: 'POINT AT DISTANT OBJECT', cls: 'sb-idle' },
      calibrating:{ txt: 'CALIBRATING…',            cls: 'sb-capturing' },
      placing:    { txt: cycleNum > 0 ? `PLACE LENS — CYCLE ${cycleNum + 1}/${n}` : 'PLACE LENS', cls: 'sb-lens' },
      measuring:  { txt: 'MEASURING WITH LENS…',    cls: 'sb-capturing' },
      done:       { txt: 'EYE SCAN COMPLETE',        cls: 'sb-measured' },
    };
    const b = banners[phase] || { txt: phase.toUpperCase(), cls: 'sb-idle' };
    const banner = $('stateBanner');
    if (banner) { banner.textContent = b.txt; banner.className = 'state-banner ' + b.cls; }

    // Camera border state
    const cw = $('mainCamWrap');
    if (cw) {
      cw.className = 'cam-wrap ' + ({
        ready: 'state-idle', calibrating: 'state-capturing',
        placing: 'state-ref', measuring: 'state-capturing', done: 'state-measured'
      }[phase] || 'state-idle');
    }

    // Instruction text
    const instrMap = {
      ready: '1. Point your camera at a distant object (wall, window, etc.)<br>2. Press <strong>Calibrate</strong> to lock the baseline focus distance.',
      calibrating: 'Camera is converging focus… hold still.',
      placing: `<strong>Remove lens</strong> from camera view, then hold it still in front — press <strong>Capture With Lens</strong> when ready.<br><small class="tx3">Cycle ${cycleNum + 1} of ${n}</small>`,
      measuring: 'Measuring focus shift through lens… hold very still.',
      done: 'Scan complete. Switch eye or view results.',
    };
    const instr = $('instrText');
    if (instr) instr.innerHTML = instrMap[phase] || '';

    // Cycle progress dots
    this._updateDots(cycleNum);
  },

  _updateDots(count) {
    const container = $('cycleDots');
    if (!container) return;
    container.innerHTML = '';
    for (let i = 0; i < OPT_CONST.CYCLES; i++) {
      const dot = document.createElement('div');
      dot.className = 'cycle-dot' + (i < count ? ' done' : i === count ? ' active' : '');
      container.appendChild(dot);
    }
  },

  /* ── HUD ─────────────────────────────────────────────────────────── */
  updateHUD(sh, focDist, shRef, focRange) {
    const lapNorm = shRef && shRef > 0 ? Math.min(100, Math.round((sh.lap / shRef) * 100)) : Math.min(100, Math.round(Math.sqrt(sh.lap) / 3));
    $('focFill').style.width = lapNorm + '%';
    $('focVal').textContent = lapNorm + '%';

    // H/V sharpness bars
    const maxSH = Math.max(sh.h, sh.v, 1);
    const shHFill = $('shHFill'); if (shHFill) shHFill.style.width = Math.min(100, Math.round(sh.h / maxSH * 100)) + '%';
    const shVFill = $('shVFill'); if (shVFill) shVFill.style.width = Math.min(100, Math.round(sh.v / maxSH * 100)) + '%';

    if (focDist != null) {
      $('fdVal').textContent = focDist.toFixed(3) + ' m';
      $('focDistHud').style.display = '';
      if (focRange) {
        const range = focRange.max - focRange.min;
        const norm = range > 0 ? ((focDist - focRange.min) / range * 100) : 50;
        $('fdFill').style.width = Math.min(100, norm) + '%';
      }
    } else {
      $('fdVal').textContent = 'N/A';
    }
  },

  /* ── Camera specs ───────────────────────────────────────────────── */
  showSpecs(specs) {
    const sg = $('specGrid'); if (!sg) return;
    sg.innerHTML = '';
    const add = (label, val, hl) => {
      const item = document.createElement('div'); item.className = 'spec-item';
      item.innerHTML = `<div class="spec-label">${label}</div><div class="spec-val${hl ? ' highlight' : ''}">${val ?? '—'}</div>`;
      sg.appendChild(item);
    };
    if (specs.width) add('RESOLUTION', `${specs.width}×${specs.height}`, true);
    if (specs.fps) add('FRAME RATE', `${specs.fps} fps`);
    if (specs.facing) add('CAMERA', specs.facing.toUpperCase());
    if (specs.focalLength) add('FOCAL LEN', `${specs.focalLength.toFixed(1)} mm`, true);
    if (specs.focusDist != null) add('FOCUS DIST', `${specs.focusDist.toFixed(2)} m`, true);
    if (specs.focusRange) add('FOCUS RANGE', `${specs.focusRange.min?.toFixed(1)}–${specs.focusRange.max?.toFixed(1)} m`, true);
    add('FOCUS API', specs.hasFocusAPI ? '✅ Available' : '⚠ Not exposed', specs.hasFocusAPI);
    $('camSpecCard').style.display = '';
    $('focusApiNote').textContent = specs.hasFocusAPI
      ? '✅ Focus-distance API available — will use autofocus shift for highest accuracy.'
      : '⚠ Camera does not expose focus distance. Sharpness-comparison fallback will be used (lower accuracy).';
  },

  /* ── Cycle table ────────────────────────────────────────────────── */
  addCycleRow(cycle, num) {
    const tbody = $('cycleTableBody');
    if (!tbody) return;
    const tr = document.createElement('tr');
    const pwr  = PowerCalc.fmtP(cycle.power);
    const conf  = cycle.sharpness ? Math.min(100, Math.round(Math.sqrt(cycle.sharpness) / 3)) : '—';
    const dLens = cycle.dLens ? cycle.dLens.toFixed(3) + ' m' : '—';
    const dRef  = cycle.dRef  ? cycle.dRef.toFixed(3)  + ' m' : '—';
    /* Compact method badge -- helps user distinguish which measurement path each cycle used */
    const METHOD_LABELS = {
      'focus_shift':          '<span style="color:var(--cy);font-size:.72em" title="Focus shift">FS</span>',
      'focus_shift+cylinder': '<span style="color:var(--cy);font-size:.72em" title="Focus shift + cylinder">FS+C</span>',
      'blur_profile':         '<span style="color:var(--am);font-size:.72em" title="Blur profile (no Focus API)">BP</span>',
      'blur_unblur':          '<span style="color:var(--vl);font-size:.72em" title="Blur/unblur cycle">BU</span>',
      'near_plano':           '<span style="color:var(--tx3);font-size:.72em" title="Near plano">~0</span>',
      'sharpness_fallback':   '<span style="color:var(--tx3);font-size:.72em" title="Sharpness fallback">SF</span>',
    };
    const badge = METHOD_LABELS[cycle.method] || '<span style="color:var(--tx3);font-size:.72em">?</span>';
    tr.innerHTML = `
      <td class="mono" style="color:var(--tx3)">${num}</td>
      <td class="mono cy">${pwr}</td>
      <td class="mono tx2">${dRef}</td>
      <td class="mono tx2">${dLens}</td>
      <td class="mono am">${PowerCalc.fmtC(cycle.cylinder)}</td>
      <td class="mono" style="color:var(--vl)">${cycle.axis ? cycle.axis + '°' : '—'}</td>
      <td class="mono tx3">${typeof conf === 'number' ? conf + '%' : conf}</td>
      <td>${badge}</td>
    `;
    tbody.appendChild(tr);
    tbody.scrollTop = tbody.scrollHeight;
    $('cycleCount').textContent = num;
  },

  /* ── Running average ─────────────────────────────────────────────── */
  showRunning(agg) {
    $('runCard').style.display = '';
    const pEl = $('runPwr');
    pEl.textContent = PowerCalc.fmtP(agg.sphere);
    pEl.className = 'pwr ' + PowerCalc.pcls(agg.sphere);
    $('runCls').textContent = PowerCalc.classify(agg.sphere, agg.cylinder);
    $('runSph').textContent = PowerCalc.fmtP(agg.sphere);
    $('runCyl').textContent = PowerCalc.fmtC(agg.cylinder);
    $('runAx').textContent = PowerCalc.fmtA(agg.axis);
    $('runConf').textContent = Math.round(agg.confidence * 100) + '%';
    $('runCfill').style.width = Math.round(agg.confidence * 100) + '%';
  },
  clearRunning() {
    $('runCard').style.display = 'none';
    $('runPwr').textContent = '—';
  },

  /* ── Final reading per eye (in-scan) ────────────────────────────── */
  showFinalReading(agg, eye) {
    const id = eye === 'right' ? 'progR' : 'progL';
    const el = $(id);
    if (el) {
      el.textContent = PowerCalc.fmtP(agg.sphere);
      el.className = 'pwr ' + PowerCalc.pcls(agg.sphere);
    }
  },

  /* -- Results page (FIX 11: anisometropia warning added) ----------- */
  renderResults(results) {
    const pop = (r, suf) => {
      const el   = $('fin' + suf), cl  = $('fin' + suf + 'Cl'), cy2 = $('fin' + suf + 'Cy');
      const rxS  = $('rx'  + suf + 'S'), rxC = $('rx' + suf + 'C');
      const rxA  = $('rx'  + suf + 'A'), rxCl = $('rx' + suf + 'Cl');
      if (!r) { if (el) el.textContent = 'Not measured'; return; }
      if (el)  { el.textContent = PowerCalc.fmtP(r.sphere); el.className = 'pwr ' + PowerCalc.pcls(r.sphere); }
      if (cl)  cl.textContent  = PowerCalc.classify(r.sphere, r.cylinder);
      if (cy2) cy2.textContent = Math.abs(r.cylinder || 0) >= 0.25
        ? `Cyl: ${PowerCalc.fmtC(r.cylinder)}, Axis: ${PowerCalc.fmtA(r.axis)}` : '';
      if (rxS)  rxS.textContent  = PowerCalc.fmtP(r.sphere);
      if (rxC)  rxC.textContent  = PowerCalc.fmtC(r.cylinder);
      if (rxA)  rxA.textContent  = PowerCalc.fmtA(r.axis);
      if (rxCl) rxCl.textContent = PowerCalc.classify(r.sphere, r.cylinder);
    };
    pop(results.right, 'R');
    pop(results.left,  'L');

    $('dCyc').textContent = (results.right?.cycles || 0) + 'R / ' + (results.left?.cycles || 0) + 'L';
    const methods = [results.right?.method, results.left?.method].filter(Boolean);
    $('dMeth').textContent = methods.length ? [...new Set(methods)].join('+').toUpperCase() : '--';
    const confAvg = [results.right?.confidence, results.left?.confidence].filter(Boolean);
    $('dCnf').textContent = confAvg.length ? Math.round(confAvg.reduce((s,v)=>s+v,0)/confAvg.length*100)+'%' : '--';

    /* FIX 11: Anisometropia warning
       Sphere difference > 2 D or cylinder difference > 1.5 D between eyes
       is clinically significant and warrants a professional check. */
    if (results.right && results.left) {
      const dSph = Math.abs((results.right.sphere  || 0) - (results.left.sphere  || 0));
      const dCyl = Math.abs((results.right.cylinder|| 0) - (results.left.cylinder|| 0));
      if (dSph > 2.0 || dCyl > 1.5) {
        const anisoEl = $('anisoWarn');
        if (anisoEl) {
          anisoEl.textContent =
            `Anisometropia detected: inter-eye sphere difference ${dSph.toFixed(2)} D` +
            (dCyl > 1.5 ? `, cylinder difference ${dCyl.toFixed(2)} D` : '') +
            '. Large differences between eyes can indicate amblyopia or measurement error -- ' +
            'please consult a qualified optometrist.';
          anisoEl.style.display = '';
        }
      }
    }
  },
};

/* -- FIX 9: Vertex distance helper ----------------------------------------
   Converts back-vertex measured power to corneal-plane power.
   For lenses >= +/-4 D the difference is clinically significant.
   Standard vertex distance assumed: 12 mm (adjustable). */
function vertexCorrect(P, vertexMM = 12) {
  if (!P || Math.abs(P) < 4.0) return P;   /* skip correction below 4 D */
  const d = vertexMM / 1000;
  const denom = 1 - d * P;
  return Math.abs(denom) > 0.01 ? Math.round((P / denom) / OPT_CONST.PREC) * OPT_CONST.PREC : P;
}

/* -- Exporter (FIX 9: vertex-corrected sphere added to exports) ----------- */
const Exporter = {
  json(st) {
    const d = {
      timestamp: new Date().toISOString(),
      tool:      'OptiScan Pro v6.1',
      method:    'focus_shift',
      vertex_distance_mm: 12,
      results:   {},
    };
    for (const eye of ['right', 'left']) {
      const r = st.results[eye];
      if (r) d.results[eye] = {
        sphere_measured:   r.sphere,
        sphere_at_cornea:  vertexCorrect(r.sphere),   /* FIX 9 */
        cylinder:          r.cylinder  || 0,
        axis:              r.axis      || 0,
        classification:    PowerCalc.classify(r.sphere, r.cylinder),
        confidence:        r.confidence,
        low_confidence:    r.lowConfidence ?? false,  /* FIX 7 */
        stddev:            r.stddev != null ? +r.stddev.toFixed(3) : null,
        cycles:            r.cycles,
        method:            r.method,
        allPowers:         r.allPowers,
      };
    }
    this._dl(JSON.stringify(d, null, 2), 'application/json', 'optiscan.json');
  },

  csv(st) {
    const rows = [[
      'Eye', 'Sphere Measured (D)', 'Sphere at Cornea (D)',
      'Cylinder (D)', 'Axis (deg)', 'Confidence', 'Low Confidence',
      'Std Dev (D)', 'Cycles', 'Classification', 'Method',
    ]];
    for (const [k, lbl] of [['right', 'Right (OD)'], ['left', 'Left (OS)']]) {
      const r = st.results[k];
      rows.push(r
        ? [
            lbl,
            r.sphere,
            vertexCorrect(r.sphere),       /* FIX 9 */
            r.cylinder || 0,
            r.axis     || 0,
            r.confidence?.toFixed(2),
            r.lowConfidence ? 'YES' : 'no', /* FIX 7 */
            r.stddev?.toFixed(3) ?? '--',
            r.cycles,
            PowerCalc.classify(r.sphere, r.cylinder),
            r.method || 'focus_shift',
          ]
        : [lbl, '--', '--', '--', '--', '--', '--', '--', '--', 'Not measured', '--']);
    }
    this._dl(rows.map(r => r.join(',')).join('\n'), 'text/csv', 'optiscan.csv');
  },

  _dl(content, type, name) {
    const a = document.createElement('a');
    a.href     = URL.createObjectURL(new Blob([content], { type }));
    a.download = name;
    a.click();
  },
};

/* -- Helper ----------------------------------------------------- */
function $(id) { return document.getElementById(id); }
