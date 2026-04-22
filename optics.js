'use strict';

const OPT_CONST = {
  MIN_D: -25, MAX_D: 25,
  PREC: 0.25,
  CYCLES: 10,
  ROI: 0.20,
  FUSION_W: [0.45, 0.25, 0.15, 0.15],
  SAT: [50000, 8000, 0.6, 3000],
};

/* ═══════════════════════════════════════════════════════════════════════════
   FIX 3 — WASM LOADER  (two-region allocator: permanent + temp)
   Permanent slots (_outPtr, _distPtr, _sharpPtr) are allocated once via
   alloc() then sealed — they never move.  Per-frame pixel buffers go
   through temp_alloc() / temp_free_all(), which only resets the temp region.
═══════════════════════════════════════════════════════════════════════════ */
const WasmEngine = {
  _mod: null, _fns: {}, _outPtr: 0, _distPtr: 0, _sharpPtr: 0,

  async load(path = 'sharpness.wasm') {
    try {
      const resp = await fetch(path);
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      const buf = await resp.arrayBuffer();
      const result = await WebAssembly.instantiate(buf, {
        env: { memory: new WebAssembly.Memory({ initial: 256 }) },
        wasi_snapshot_preview1: { proc_exit: () => {}, fd_write: () => 0 },
      });
      this._mod = result.instance;
      const ex = this._mod.exports;
      this._fns = {
        alloc:              ex.alloc,
        seal_permanent:     ex.seal_permanent,
        temp_alloc:         ex.temp_alloc,
        temp_free_all:      ex.temp_free_all,
        compute_sharpness:  ex.compute_sharpness,
        kalman_reset:       ex.kalman_reset,
        kalman_update:      ex.kalman_update,
        parabolic_peak_dist:ex.parabolic_peak_dist,
        dominant_axis_deg:  ex.dominant_axis_deg,
      };
      /* Allocate permanent output slots BEFORE sealing */
      this._outPtr   = ex.alloc(10 * 4);   /* float32[10] sharpness result  */
      this._distPtr  = ex.alloc(256 * 4);  /* float32[256] dist array       */
      this._sharpPtr = ex.alloc(256 * 4);  /* float32[256] sharpness array  */
      ex.seal_permanent();                  /* lock permanent region         */
      console.log('[OptiScan] Wasm engine loaded — two-region allocator, sharpness accelerated');
      return true;
    } catch (e) {
      console.warn('[OptiScan] Wasm unavailable, using JS engine:', e.message);
      return false;
    }
  },

  get available() { return !!this._mod; },

  computeSharpness(imageData) {
    if (!this.available) return null;
    const { data, width: W, height: H } = imageData;
    const ex = this._mod.exports;
    /* FIX 3: pixel buffer lives in the temp region only */
    const pxPtr = this._fns.temp_alloc(data.length);
    if (!pxPtr) return null;
    new Uint8Array(ex.memory.buffer).set(data, pxPtr);
    const roi = OPT_CONST.ROI;
    const x0 = Math.round(W * roi), x1 = Math.round(W * (1 - roi));
    const y0 = Math.round(H * roi), y1 = Math.round(H * (1 - roi));
    ex.compute_sharpness(pxPtr, W, H, x0, y0, x1, y1, this._outPtr);
    /* Reset temp region — permanent _outPtr slot is untouched */
    this._fns.temp_free_all();
    const f = new Float32Array(ex.memory.buffer, this._outPtr, 10);
    return {
      tenengrad: f[0], brenner: f[1], normvar: f[2], fused: f[3],
      h: f[4], v: f[5], d45: f[6], d135: f[7],
      meanLuma: f[8], pixelCount: f[9],
      valid: f[8] > 20,   /* FIX 4: raise threshold (was >10) */
    };
  },

  kalmanReset()                    { this._fns.kalman_reset?.(); },
  kalmanUpdate(z, dt, Q=0.001, R=0.005) { return this._fns.kalman_update?.(z, dt, Q, R) ?? z; },

  parabolicPeak(distArr, sharpArr) {
    if (!this.available || distArr.length < 3) return null;
    const n = Math.min(distArr.length, 256);
    const ex = this._mod.exports;
    const f  = new Float32Array(ex.memory.buffer);
    const dOff = this._distPtr / 4, sOff = this._sharpPtr / 4;
    for (let i = 0; i < n; i++) { f[dOff + i] = distArr[i]; f[sOff + i] = sharpArr[i]; }
    return ex.parabolic_peak_dist(this._distPtr, this._sharpPtr, n);
  },
};

/* ═══════════════════════════════════════════════════════════════════════════
   JS SHARPNESS FALLBACK — tri-metric fusion
═══════════════════════════════════════════════════════════════════════════ */
const SharpnessJS = {
  compute(imageData) {
    const { data, width: W, height: H } = imageData;
    const roi = OPT_CONST.ROI;
    const x0 = Math.max(1, Math.round(W*roi)), x1 = Math.min(W-1, Math.round(W*(1-roi)));
    const y0 = Math.max(1, Math.round(H*roi)), y1 = Math.min(H-1, Math.round(H*(1-roi)));
    const rW = x1-x0, rH = y1-y0;
    const gray = new Float32Array(rW*rH);
    for (let y=y0;y<y1;y++) for (let x=x0;x<x1;x++) {
      const i=(y*W+x)*4;
      gray[(y-y0)*rW+(x-x0)] = 0.2126*data[i]+0.7152*data[i+1]+0.0722*data[i+2];
    }
    let sumTen=0,sumBren=0,sumL=0,sumL2=0,sumH=0,sumV=0,sumD45=0,sumD135=0,n=0;
    for (let y=1;y<rH-1;y+=2) for (let x=1;x<rW-1;x+=2) {
      const g00=gray[(y-1)*rW+(x-1)],g01=gray[(y-1)*rW+x],g02=gray[(y-1)*rW+(x+1)];
      const g10=gray[y*rW+(x-1)],    g11=gray[y*rW+x],    g12=gray[y*rW+(x+1)];
      const g20=gray[(y+1)*rW+(x-1)],g21=gray[(y+1)*rW+x],g22=gray[(y+1)*rW+(x+1)];
      sumL+=g11; sumL2+=g11*g11;
      const gx=(g02+2*g12+g22)-(g00+2*g10+g20);
      const gy=(g20+2*g21+g22)-(g00+2*g01+g02);
      sumTen+=gx*gx+gy*gy; sumH+=gx*gx; sumV+=gy*gy;
      const d45=g22-g00, d135=g02-g20;
      sumD45+=d45*d45; sumD135+=d135*d135;
      const bx=(x+2<rW)?gray[y*rW+(x+2)]-g10:gx;
      const by=(y+2<rH)?gray[(y+2)*rW+x]-g11:gy;
      sumBren+=bx*bx+by*by; n++;
    }
    if (!n) return {fused:0,h:0,v:0,d45:0,d135:0,meanLuma:0,valid:false};
    const dn=n,mean=sumL/dn,nv=mean>1?(sumL2/dn-mean*mean)/(mean*mean):0;
    const ten=sumTen/dn,bren=sumBren/dn;
    const [w0,w1,w2]=OPT_CONST.FUSION_W,[s0,s1,s2]=OPT_CONST.SAT;
    return {
      tenengrad:ten, brenner:bren, normvar:nv,
      fused: w0*(ten/s0)+w1*(bren/s1)+w2*(nv/s2),
      h:sumH/dn, v:sumV/dn, d45:sumD45/dn, d135:sumD135/dn,
      meanLuma:mean, pixelCount:n,
      valid: mean > 20,   /* FIX 4: consistent threshold with Wasm */
    };
  },
};

/* ── Unified sharpness API ── */
const ZERO_SHARPNESS = { tenengrad:0,brenner:0,normvar:0,fused:0,h:0,v:0,d45:0,d135:0,meanLuma:0,pixelCount:0,valid:false };

const Sharpness = {
  compute(imageData) {
    const r = WasmEngine.available
      ? WasmEngine.computeSharpness(imageData)
      : SharpnessJS.compute(imageData);
    /* FIX 4: treat invalid (dark/saturated) frames as zero — callers must
       check sh.valid before using the result for calibration or measurement. */
    if (!r || !r.valid) return { ...ZERO_SHARPNESS };
    return r;
  },
  normalize(val, refVal) { return (!refVal||refVal<1e-6)?0:Math.min(2,val/refVal); },

  /* FIX 2: Compute cylinder axis using circular-mean across all 4 directional
     Sobel channels.  This gives continuous axis resolution (5° steps) instead
     of the old binary 90°/180° choice.
     
     Mapping (edge energy → axis candidate):
       sh.h    = Gx² = vertical-edge energy   → axis candidate 90°
       sh.v    = Gy² = horizontal-edge energy  → axis candidate 180° (= 0°)
       sh.d45  = 45° diagonal energy           → axis candidate 135°
       sh.d135 = 135° diagonal energy          → axis candidate 45°
     
     The DOMINANT direction (highest energy) is the axis, because that
     direction is still sharp — the lens has no power there.
     We use a weighted circular mean so oblique axes interpolate smoothly
     rather than snapping to the nearest 45° bin. */
  computeAxis(sh) {
    const candidates = [
      { axisDeg: 90,  energy: sh.h    },
      { axisDeg: 180, energy: sh.v    },
      { axisDeg: 135, energy: sh.d45  },
      { axisDeg: 45,  energy: sh.d135 },
    ];
    const totalE = candidates.reduce((s, c) => s + c.energy, 0);
    if (totalE < 1e-6) return 90;   /* degenerate: return default */
    let sinSum = 0, cosSum = 0;
    for (const { axisDeg, energy } of candidates) {
      const w   = energy / totalE;
      const rad = (axisDeg * 2) * Math.PI / 180; /* double-angle for circular stats */
      sinSum += w * Math.sin(rad);
      cosSum += w * Math.cos(rad);
    }
    let axis = Math.atan2(sinSum, cosSum) * 90 / Math.PI;
    if (axis < 0) axis += 180;
    return Math.round(axis / 5) * 5;  /* round to nearest 5° */
  },
};

/* ═══════════════════════════════════════════════════════════════════════════
   FIX 8 — SHARPNESS EXPONENTIAL MOVING AVERAGE
   Applied to the monitoring stream so that sensor noise does not trigger
   false blur-onset events.  The calibration baseline uses raw (unsmoothed)
   values so it reflects a settled, accurate reference.
═══════════════════════════════════════════════════════════════════════════ */
const SharpnessEMA = {
  _alpha: 0.35,   /* 0 = max smoothing, 1 = no smoothing */
  _state: null,
  reset()  { this._state = null; },
  filter(sh) {
    if (!this._state) { this._state = { ...sh }; return sh; }
    const a = this._alpha, b = 1 - a;
    const out = {
      fused: a * sh.fused + b * this._state.fused,
      h:     a * sh.h     + b * this._state.h,
      v:     a * sh.v     + b * this._state.v,
      d45:   a * sh.d45   + b * this._state.d45,
      d135:  a * sh.d135  + b * this._state.d135,
      meanLuma: sh.meanLuma,
      valid:    sh.valid,
    };
    this._state = out;
    return out;
  },
};

/* ═══════════════════════════════════════════════════════════════════════════
   FIX 5 — CONVERGENCE DETECTOR (shared by Camera and App)
   Replaces the duplicated stability-checking loops in camera.js and app.js.
   Feed sharpness values via .feed(); returns true when the stream has been
   stable for requiredCount consecutive checks.
═══════════════════════════════════════════════════════════════════════════ */
class ConvergenceDetector {
  constructor({ windowSize = 5, stabilityThreshold = 0.013, requiredCount = 3 } = {}) {
    this._window   = windowSize;
    this._thresh   = stabilityThreshold;
    this._required = requiredCount;
    this._stable   = 0;
    this._history  = [];
  }
  reset() { this._stable = 0; this._history = []; }
  /** Returns true when convergence is reached. */
  feed(sharpness) {
    this._history.push(sharpness);
    if (this._history.length > 120) this._history.shift();
    if (this._history.length < this._window) return false;
    const recent = this._history.slice(-this._window);
    const max = Math.max(...recent), min = Math.min(...recent);
    const spread = max > 0 ? (max - min) / max : 1;
    if (spread < this._thresh) {
      this._stable++;
      return this._stable >= this._required;
    }
    this._stable = 0;
    return false;
  }
  get stableCount() { return this._stable; }
}

/* ═══════════════════════════════════════════════════════════════════════════
   KALMAN FILTER (JS fallback)
═══════════════════════════════════════════════════════════════════════════ */
class KalmanFD {
  constructor() { this.reset(); }
  reset() { this.x=0;this.v=0;this.P=[[1,0],[0,1]];this._init=false;this._lastT=0; }
  update(z, Q=0.001, R=0.005) {
    const now=performance.now()/1000;
    const dt=this._init?Math.min(now-this._lastT,0.5):0;
    this._lastT=now;
    if (!this._init) { this.x=z;this._init=true;return z; }
    const xp=this.x+this.v*dt, vp=this.v;
    const P00p=this.P[0][0]+dt*(this.P[1][0]+this.P[0][1])+dt*dt*this.P[1][1]+Q;
    const P01p=this.P[0][1]+dt*this.P[1][1];
    const P10p=this.P[1][0]+dt*this.P[1][1];
    const P11p=this.P[1][1]+Q*0.1;
    const S=P00p+R, K0=P00p/S, K1=P10p/S, inn=z-xp;
    this.x=xp+K0*inn; this.v=vp+K1*inn;
    this.P=[[(1-K0)*P00p,(1-K0)*P01p],[P10p-K1*P00p,P11p-K1*P01p]];
    return this.x;
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   FOCUS DISTANCE API
═══════════════════════════════════════════════════════════════════════════ */
const FocusAPI = {
  _track:null, _caps:null, _kalman:new KalmanFD(),
  attach(stream) {
    if (!stream) return false;
    this._track=stream.getVideoTracks()[0]??null;
    if (!this._track) return false;
    try { this._caps=this._track.getCapabilities?.()??{}; } catch(_){this._caps={};}
    this._kalman.reset(); WasmEngine.kalmanReset();
    return !!this._caps.focusDistance;
  },
  read(filtered=true) {
    if (!this._track) return null;
    try {
      const s=this._track.getSettings();
      const raw=s.focusDistance??null;
      if (raw===null) return null;
      return filtered ? this._kalman.update(raw) : raw;
    } catch(_){ return null; }
  },
  async lock()   { if(!this._track)return false; try{await this._track.applyConstraints({advanced:[{focusMode:'manual'}]});return true;}catch(_){return false;} },
  async unlock() { if(!this._track)return false; try{await this._track.applyConstraints({advanced:[{focusMode:'continuous'}]});return true;}catch(_){return false;} },
  /* FIX 5: waitForFocus uses shared ConvergenceDetector */
  async waitForFocus(videoEl, captureCanvas, timeoutMs=5000, sampleMs=80) {
    const start=Date.now(), history=[], conv=new ConvergenceDetector();
    while (Date.now()-start<timeoutMs) {
      await delay(sampleMs);
      const id=captureFrame(videoEl,captureCanvas);
      if(!id) continue;
      const sh=Sharpness.compute(id);
      const fd=this.read(true);
      history.push({lap:sh.fused,shH:sh.h,shV:sh.v,sh,focDist:fd,t:Date.now()});
      if (conv.feed(sh.fused)) {
        const best=history.reduce((a,b)=>a.lap>b.lap?a:b);
        return {ok:true,...best};
      }
    }
    if(history.length){const best=history.reduce((a,b)=>a.lap>b.lap?a:b);return{ok:true,...best};}
    return{ok:false,lap:0,shH:0,shV:0,sh:null,focDist:null};
  },
  get caps(){return this._caps;},
};

/* ═══════════════════════════════════════════════════════════════════════════
   FIX 6 — BLUR EVENT DETECTOR  (motion-blur discrimination added)
   
   Watches a sharpness stream for the characteristic drop-then-recovery
   that happens when a lens is placed in front of the camera.

   Motion blur vs optical blur:
     Motion blur (hand shake / moving background) kills ONE directional
     channel much more than the others (e.g., panning horizontally wipes
     sh.h while sh.v stays near baseline).
     Optical defocus from a lens suppresses ALL channels together.
     We flag events where the max/min channel ratio exceeds 4× as motion
     and ignore them, avoiding false lens-detection triggers.
═══════════════════════════════════════════════════════════════════════════ */
const BlurDetector = {
  _hist:      [],
  _ref:       null,  /* { s, sH, sV, sD45, sD135 } calibration baseline */
  _onset:     null,
  _peakBlur:  null,

  reset(ref) {
    this._hist     = [];
    this._ref      = ref || null;
    this._onset    = null;
    this._peakBlur = null;
  },

  /* Returns: 'stable'|'motion_blur'|'blur_onset'|'blurred'|'recovering'|'converged' */
  feed(sh, focDist = null) {
    const s = sh.fused, sH = sh.h, sV = sh.v, sD45 = sh.d45, sD135 = sh.d135;
    const t = performance.now();
    const sample = { s, sH, sV, sD45, sD135, t, fd: focDist };
    this._hist.push(sample);
    if (this._hist.length > 120) this._hist.shift();

    if (!this._ref || this._ref.s < 1) return 'stable';
    const ratio = s / this._ref.s;

    /* FIX 6: Motion-blur guard — check directional asymmetry.
       If one channel is blurred much more than the others, this is motion
       (or a very strongly astigmatic scene), not an isotropic lens defocus.
       Only apply when we see a significant overall drop. */
    if (ratio < 0.80 && !this._onset) {
      const dirs = [sH, sV, sD45, sD135].map(v => v + 1e-6);
      const maxD = Math.max(...dirs), minD = Math.min(...dirs);
      const asymmetry = maxD / minD;
      if (asymmetry > 5.0) {
        /* Extreme uni-directional blur — almost certainly motion, not a lens */
        return 'motion_blur';
      }
    }

    if (!this._onset) {
      if (ratio < 0.72 && this._hist.length >= 3) {
        const prev = this._hist[this._hist.length - 3].s / this._ref.s;
        if (prev > 0.80) {
          this._onset    = sample;
          this._peakBlur = sample;
          return 'blur_onset';
        }
      }
      return ratio < 0.72 ? 'blurred' : 'stable';
    }

    if (s < this._peakBlur.s) this._peakBlur = sample;
    const age = t - this._onset.t;
    if (ratio < 0.72) return age < 400 ? 'blur_onset' : 'blurred';
    if (ratio > 0.88) return 'converged';
    return 'recovering';
  },

  get blurDepth()  { if(!this._peakBlur||!this._ref?.s)   return 0; return Math.max(0, 1 - this._peakBlur.s    / this._ref.s);    },
  get blurDepthH() { if(!this._peakBlur||!(this._ref?.sH > 0.5)) return this.blurDepth; return Math.max(0, 1 - this._peakBlur.sH   / this._ref.sH);   },
  get blurDepthV() { if(!this._peakBlur||!(this._ref?.sV > 0.5)) return this.blurDepth; return Math.max(0, 1 - this._peakBlur.sV   / this._ref.sV);   },
  /* FIX 2: expose diagonal blur depths for 4-direction axis computation */
  get blurDepthD45()  { if(!this._peakBlur||!(this._ref?.sD45  > 0.5)) return this.blurDepth; return Math.max(0, 1 - this._peakBlur.sD45  / this._ref.sD45);  },
  get blurDepthD135() { if(!this._peakBlur||!(this._ref?.sD135 > 0.5)) return this.blurDepth; return Math.max(0, 1 - this._peakBlur.sD135 / this._ref.sD135); },
  get wasDetected() { return !!this._onset; },
  get onset()       { return this._onset;   },
  get peakBlur()    { return this._peakBlur;},
};

/* ═══════════════════════════════════════════════════════════════════════════
   POWER CALCULATOR
═══════════════════════════════════════════════════════════════════════════ */
/* =============================================================================
   BLUR-UNBLUR COLLECTOR
   Used when focus lock/unlock does not work (blur_unblur measure mode).

   Tracks a full place-and-remove lens cycle:
     Phase A  'waiting_lens'   -- watching for blur onset
     Phase B  'lens_in'        -- lens detected, tracking peak blur
     Phase C  'waiting_remove' -- user prompted to remove lens, watching for rise
     Phase D  'removed'        -- lens removed, tracking recovery
     Phase E  'done'           -- both transitions captured

   After done, callers read:
     .onsetSh   -- sharpness at blur onset (t_onset)
     .peakSh    -- sharpness at deepest blur (t_peak)
     .removeSh  -- sharpness when removal detected (unblur onset)
     .finalSh   -- sharpness after full recovery
     .phase     -- final state string
   All sharpness objects have { fused, h, v, d45, d135 }.
============================================================================= */
const BlurUnblurCollector = {
  _ref:       null,   /* { s, sH, sV, sD45, sD135 } baseline */
  _hist:      [],
  _phase:     'waiting_lens',
  _onsetSh:   null,
  _peakSh:    null,
  _removeSh:  null,
  _finalSh:   null,
  _onsetT:    null,
  _peakT:     null,

  reset(ref) {
    this._ref      = ref || null;
    this._hist     = [];
    this._phase    = 'waiting_lens';
    this._onsetSh  = null;
    this._peakSh   = null;
    this._removeSh = null;
    this._finalSh  = null;
    this._onsetT   = null;
    this._peakT    = null;
  },

  /**
   * Feed one sharpness sample.
   * Returns the current phase string so the caller can drive UI prompts.
   */
  feed(sh) {
    const t   = performance.now();
    const s   = sh.fused;
    this._hist.push({ sh, t });
    if (this._hist.length > 180) this._hist.shift();

    if (!this._ref || this._ref.s < 1) return this._phase;

    const ratio = s / this._ref.s;

    switch (this._phase) {

      case 'waiting_lens':
        /* Blur onset: drop below 72% while previous sample was above 80% */
        if (ratio < 0.72 && this._hist.length >= 3) {
          const prevRatio = this._hist[this._hist.length - 3].sh.fused / this._ref.s;
          if (prevRatio > 0.80) {
            this._onsetSh = sh;
            this._peakSh  = sh;
            this._onsetT  = t;
            this._phase   = 'lens_in';
          }
        }
        break;

      case 'lens_in':
        /* Track peak blur (minimum sharpness = maximum defocus) */
        if (s < this._peakSh.fused) {
          this._peakSh = sh;
          this._peakT  = t;
        }
        /* After 600 ms at peak or 2 s total, instruct user to remove lens */
        if (t - this._onsetT > 600) this._phase = 'waiting_remove';
        break;

      case 'waiting_remove':
        /* Keep updating peak in case it deepens further */
        if (s < this._peakSh.fused) this._peakSh = sh;

        /* Removal detected: sharpness starts rising from peak */
        if (this._peakSh && s > this._peakSh.fused * 1.08) {
          this._removeSh = sh;
          this._phase    = 'removed';
        }
        break;

      case 'removed':
        /* Track recovery until sharpness returns to >= 88% of baseline */
        this._finalSh = sh;
        if (ratio > 0.88) this._phase = 'done';
        break;

      case 'done':
        /* Done -- no further state changes */
        break;
    }

    return this._phase;
  },

  get phase()     { return this._phase;    },
  get isDone()    { return this._phase === 'done' || (this._phase === 'removed' && this._finalSh); },
  get lensIn()    { return this._phase !== 'waiting_lens'; },
  get onsetSh()   { return this._onsetSh;  },
  get peakSh()    { return this._peakSh;   },
  get removeSh()  { return this._removeSh; },
  get finalSh()   { return this._finalSh;  },

  /* Blur depths derived from ref baseline */
  _depth(shField, refField) {
    if (!this._peakSh || !this._ref) return 0;
    const refV = this._ref[refField];
    if (!refV || refV < 0.5) return this._depthFused();
    return Math.max(0, 1 - this._peakSh[shField] / refV);
  },
  _depthFused()  { return this._peakSh && this._ref ? Math.max(0, 1 - this._peakSh.fused / this._ref.s) : 0; },
  get blurDepth()    { return this._depthFused(); },
  get blurDepthH()   { return this._depth('sH',   'sH');   },
  get blurDepthV()   { return this._depth('sV',   'sV');   },
  get blurDepthD45() { return this._depth('sD45', 'sD45'); },
  get blurDepthD135(){ return this._depth('sD135','sD135');},
};


const PowerCalc = {

  /* FIX 1 — Back-vertex correction for lens-to-camera distance.
     The thin-lens formula P = 1/d_lens - 1/d_ref assumes the lens is at the
     camera nodal point.  When the lens is held lensDistM metres away, the
     measured power must be corrected to the back-vertex power:
       P_bvp = P_thin / (1 - lensDistM * P_thin)
     For a +4 D lens at 50 mm the error without this is +0.84 D. */
  fromFocusDist(dLens, dRef, lensDistM = 0) {
    if (!dLens||!dRef||dLens<=0||dRef<=0) return {ok:false,reason:'invalid distances'};
    const thin = 1/dLens - 1/dRef;
    /* Back-vertex correction (safe guard: if denominator ~0, skip correction) */
    const denom = 1 - lensDistM * thin;
    const corrected = (lensDistM > 0 && Math.abs(denom) > 0.01) ? thin / denom : thin;
    const clamped = Math.max(OPT_CONST.MIN_D, Math.min(OPT_CONST.MAX_D, corrected));
    return {
      ok: true, rawPower: corrected,
      power: Math.round(clamped / OPT_CONST.PREC) * OPT_CONST.PREC,
      method: 'focus_shift',
    };
  },

  fromSharpnessProfile(measurements, dRef) {
    if (!measurements?.length||!dRef) return {ok:false};
    const sorted=[...measurements].sort((a,b)=>a.focusDist-b.focusDist);
    const bestH=this._parabolicPeak(sorted,'shH');
    const bestV=this._parabolicPeak(sorted,'shV');
    if (!bestH||!bestV) return {ok:false};
    const pH=this.fromFocusDist(bestH,dRef), pV=this.fromFocusDist(bestV,dRef);
    if (!pH.ok||!pV.ok) return {ok:false};
    const sphere=Math.round(((pH.rawPower+pV.rawPower)/2)/OPT_CONST.PREC)*OPT_CONST.PREC;
    const rawCyl=pH.rawPower-pV.rawPower;
    const cylinder=Math.round(rawCyl/OPT_CONST.PREC)*OPT_CONST.PREC;
    const axis=Math.abs(cylinder)>=0.25?(pH.rawPower>pV.rawPower?180:90):0;
    return {ok:true,sphere,cylinder,axis,dH:bestH,dV:bestV,method:'sharpness_profile'};
  },

  fromBlurProfile(blurH, blurV, dRef, recovery) {
    const K = 0.42;
    const estMag = b => {
      if (b < 0.03) return 0;
      if (b > 0.97) return 14;
      return Math.sqrt(b / (1 - b)) / K;
    };
    const magH = estMag(Math.min(0.97, blurH));
    const magV = estMag(Math.min(0.97, blurV));
    const mag  = (magH + magV) / 2;
    const isClose = dRef < 0.5;
    const goodRec = (recovery ?? 0) > 0.78;
    const isDiverging = (isClose === goodRec);
    const sign = isDiverging ? -1 : 1;
    const sphere   = sign * Math.round(mag   / OPT_CONST.PREC) * OPT_CONST.PREC;
    const rawCyl   = magH - magV;
    const cylinder = Math.round(rawCyl / OPT_CONST.PREC) * OPT_CONST.PREC;
    const axis     = Math.abs(cylinder) >= 0.25 ? (magH > magV ? 180 : 90) : 0;
    return { ok: mag>0, power:sphere, rawPower:sign*mag, sphere, cylinder, axis, method:'blur_profile' };
  },

  /**
   * fromBlurUnblur -- power estimation from a full blur/unblur cycle.
   *
   * Called when focus lock/unlock does not work. We capture the lens being
   * placed (blur onset -> peak) AND removed (unblur -> recovery), giving two
   * independent measurements of the same lens which we then fuse.
   *
   * Parameters:
   *   onsetH/V  -- blur depth (0-1) at onset, H and V channels
   *   peakH/V   -- blur depth at maximum defocus, H and V channels
   *   dRef      -- calibration focus distance (m)
   *   finalRecovery -- final sharpness / baseline sharpness after removal
   *
   * The onset blur (captured before any AF compensation can kick in) is the
   * cleanest reading.  The peak blur has the largest signal (higher SNR) but
   * may include partial AF compensation.  We weight onset 40% + peak 60% for
   * the sphere, and use whichever channel shows stronger astigmatism for cyl.
   */
  fromBlurUnblur(onsetH, onsetV, peakH, peakV, dRef, finalRecovery) {
    /* Primary: peak blur (highest SNR) */
    const peak   = this.fromBlurProfile(peakH,  peakV,  dRef, finalRecovery);
    /* Secondary: onset blur (least AF contamination) */
    const onset  = this.fromBlurProfile(onsetH, onsetV, dRef, finalRecovery);

    if (!peak.ok && !onset.ok) return { ok: false, method: 'blur_unblur' };
    if (!peak.ok)  return { ...onset,  method: 'blur_unblur' };
    if (!onset.ok) return { ...peak,   method: 'blur_unblur' };

    /* Weighted average sphere: 60% peak, 40% onset */
    const rawSphere = 0.6 * peak.rawPower + 0.4 * onset.rawPower;
    const sphere    = Math.round(rawSphere / OPT_CONST.PREC) * OPT_CONST.PREC;

    /* Cylinder: use whichever measurement showed stronger H/V asymmetry */
    const peakAsym  = Math.abs(peakH  - peakV);
    const onsetAsym = Math.abs(onsetH - onsetV);
    const cylSrc    = peakAsym > onsetAsym ? peak : onset;

    return {
      ok:       true,
      power:    sphere,
      rawPower: rawSphere,
      sphere,
      cylinder: cylSrc.cylinder,
      axis:     cylSrc.axis,
      method:   'blur_unblur',
    };
  },


  _parabolicPeak(pts, key) {
    if (pts.length<2) return pts[0]?.focusDist??null;
    let bestI=0,bestVal=-Infinity;
    pts.forEach((p,i)=>{if(p[key]>bestVal){bestVal=p[key];bestI=i;}});
    if (bestI===0||bestI===pts.length-1) return pts[bestI].focusDist;
    const a=pts[bestI-1],b=pts[bestI],c=pts[bestI+1];
    const da=a.focusDist,db=b.focusDist,dc=c.focusDist;
    const fa=a[key],fb=b[key],fc=c[key];
    const num=da*da*(fb-fc)+db*db*(fc-fa)+dc*dc*(fa-fb);
    const den=2*(da*(fb-fc)+db*(fc-fa)+dc*(fa-fb));
    if (Math.abs(den)<1e-10) return db;
    return Math.max(0.01,num/den);
  },

  /* FIX 7 — Enhanced aggregation with bimodality guard + trimmed mean.
     IQR outlier rejection with 10 samples is underpowered: one extreme
     outlier can skew Q1/Q3 enough to let other outliers through.
     Added: bimodality detection (stddev > 1.0 D flags a mixed measurement)
     and trimmed mean as a cross-check against the weighted median. */
  aggregateCycles(cycles) {
    if (!cycles.length) return null;
    const powers = cycles.map(c=>c.power).filter(isFinite).sort((a,b)=>a-b);
    const q1=powers[Math.floor(powers.length*0.25)];
    const q3=powers[Math.floor(powers.length*0.75)];
    const iqr=q3-q1;
    const lo=q1-1.5*iqr, hi=q3+1.5*iqr;
    let good=cycles.filter(c=>isFinite(c.power)&&c.power>=lo&&c.power<=hi);
    if (!good.length) good=cycles;

    const totalW=good.reduce((s,c)=>s+(c.sharpness||1),0);
    const sorted=[...good].sort((a,b)=>a.power-b.power);
    let wSum=0, medPower=sorted[Math.floor(sorted.length/2)].power;
    for (const c of sorted){wSum+=(c.sharpness||1);if(wSum>=totalW/2){medPower=c.power;break;}}

    /* FIX 7: Bimodality guard — compute std-dev of filtered powers */
    const mean = good.reduce((s,c)=>s+c.power,0) / good.length;
    const variance = good.reduce((s,c)=>s+(c.power-mean)**2,0) / good.length;
    const stddev = Math.sqrt(variance);

    /* FIX 7: Trimmed mean (drop top and bottom cycle) as cross-check */
    const trimmed = sorted.length > 2 ? sorted.slice(1,-1) : sorted;
    const trimmedMean = trimmed.reduce((s,c)=>s+c.power,0) / trimmed.length;
    const trimmedPower = Math.round(trimmedMean / OPT_CONST.PREC) * OPT_CONST.PREC;

    /* Flag low-confidence results: high spread OR median/trimmed-mean disagree */
    const bimodal = stddev > 1.0;
    const methodDisagreement = Math.abs(medPower - trimmedMean) > 0.5;
    const lowConfidence = bimodal || methodDisagreement;

    /* Cylinder aggregation (unchanged) */
    const cylGood=good.filter(c=>Math.abs(c.cylinder??0)>=0.25);
    let cylinder=0;
    if (cylGood.length>=2){
      const totalCW=cylGood.reduce((s,c)=>s+(c.sharpness||1),0);
      const cSorted=[...cylGood].sort((a,b)=>a.cylinder-b.cylinder);
      let cWSum=0; cylinder=cSorted[Math.floor(cSorted.length/2)].cylinder;
      for(const c of cSorted){cWSum+=(c.sharpness||1);if(cWSum>=totalCW/2){cylinder=c.cylinder;break;}}
      cylinder=Math.round(cylinder/OPT_CONST.PREC)*OPT_CONST.PREC;
    }

    /* FIX 2: Axis circular mean already done in app.js per-cycle.
       Final axis: weighted circular mean of per-cycle axes. */
    const axCycles=good.filter(c=>c.axis&&Math.abs(c.cylinder??0)>=0.25);
    let axis=0;
    if (axCycles.length){
      const sinS=axCycles.reduce((s,c)=>s+Math.sin(2*c.axis*Math.PI/180),0);
      const cosS=axCycles.reduce((s,c)=>s+Math.cos(2*c.axis*Math.PI/180),0);
      let a=Math.atan2(sinS,cosS)*90/Math.PI; if(a<0)a+=180; axis=Math.round(a/5)*5;
    }

    return {
      sphere:      Math.round(medPower/OPT_CONST.PREC)*OPT_CONST.PREC,
      trimmedSphere: trimmedPower,
      cylinder, axis,
      cycles:      good.length,
      confidence:  good.length/OPT_CONST.CYCLES,
      allPowers:   good.map(c=>c.power),
      method:      good[0]?.method||'focus_shift',
      engine:      WasmEngine.available?'wasm':'js',
      stddev,
      bimodal,
      lowConfidence,
    };
  },

  fmtP(p){if(p===null||p===undefined||isNaN(p))return'--';if(Math.abs(p)<0.01)return'Plano';return(p>0?'+':'')+p.toFixed(2)+' D';},
  fmtC(c){if(!c||Math.abs(c)<0.25)return'--';return(c>0?'+':'')+c.toFixed(2)+' D';},
  fmtA(a){return a?a+'deg':'--';},
  classify(s,c=0){const a=Math.abs(s),cyl=c&&Math.abs(c)>=0.25?' + astigmatism':'';if(a<0.13)return'Plano'+cyl;if(s>0)return(a<=2?'Mild':a<=4?'Moderate':'High')+' hyperopia'+cyl;return(a<=2?'Mild':a<=4?'Moderate':a<=6?'High':'Very high')+' myopia'+cyl;},
  pcls(p){if(!p||Math.abs(p)<0.13)return'zero';return p>0?'pos':'neg';},
};

/* ── Utilities ── */
function delay(ms){return new Promise(r=>setTimeout(r,ms));}
function captureFrame(videoEl,canvas){const w=videoEl.videoWidth||640,h=videoEl.videoHeight||480;canvas.width=w;canvas.height=h;const ctx=canvas.getContext('2d');ctx.drawImage(videoEl,0,0,w,h);return ctx.getImageData(0,0,w,h);}

WasmEngine.load().catch(()=>{});
