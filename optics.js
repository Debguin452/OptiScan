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
   WASM LOADER
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
        alloc: ex.alloc, free_all: ex.free_all,
        compute_sharpness: ex.compute_sharpness,
        kalman_reset: ex.kalman_reset, kalman_update: ex.kalman_update,
        parabolic_peak_dist: ex.parabolic_peak_dist,
        dominant_axis_deg: ex.dominant_axis_deg,
      };
      this._outPtr   = ex.alloc(10 * 4);
      this._distPtr  = ex.alloc(256 * 4);
      this._sharpPtr = ex.alloc(256 * 4);
      console.log('[OptiScan] Wasm engine loaded — sharpness accelerated');
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
    const pxPtr = ex.alloc(data.length);
    if (!pxPtr) return null;
    new Uint8Array(ex.memory.buffer).set(data, pxPtr);
    const roi = OPT_CONST.ROI;
    const x0 = Math.round(W*roi), x1 = Math.round(W*(1-roi));
    const y0 = Math.round(H*roi), y1 = Math.round(H*(1-roi));
    ex.compute_sharpness(pxPtr, W, H, x0, y0, x1, y1, this._outPtr);
    ex.free_all();
    this._outPtr   = ex.alloc(10*4);
    this._distPtr  = ex.alloc(256*4);
    this._sharpPtr = ex.alloc(256*4);
    const f = new Float32Array(ex.memory.buffer, this._outPtr, 10);
    return { tenengrad:f[0], brenner:f[1], normvar:f[2], fused:f[3],
             h:f[4], v:f[5], d45:f[6], d135:f[7], meanLuma:f[8], pixelCount:f[9], valid:f[8]>10 };
  },

  kalmanReset() { this._fns.kalman_reset?.(); },
  kalmanUpdate(z, dt, Q=0.001, R=0.005) { return this._fns.kalman_update?.(z, dt, Q, R) ?? z; },

  parabolicPeak(distArr, sharpArr) {
    if (!this.available || distArr.length < 3) return null;
    const n = Math.min(distArr.length, 256);
    const ex = this._mod.exports;
    const f = new Float32Array(ex.memory.buffer);
    const dOff = this._distPtr/4, sOff = this._sharpPtr/4;
    for (let i = 0; i < n; i++) { f[dOff+i] = distArr[i]; f[sOff+i] = sharpArr[i]; }
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
    const dn=n, mean=sumL/dn, nv=mean>1?(sumL2/dn-mean*mean)/(mean*mean):0;
    const ten=sumTen/dn, bren=sumBren/dn;
    const [w0,w1,w2]=OPT_CONST.FUSION_W, [s0,s1,s2]=OPT_CONST.SAT;
    return { tenengrad:ten, brenner:bren, normvar:nv,
             fused: w0*(ten/s0)+w1*(bren/s1)+w2*(nv/s2),
             h:sumH/dn, v:sumV/dn, d45:sumD45/dn, d135:sumD135/dn,
             meanLuma:mean, pixelCount:n, valid:mean>10 };
  },
};

/* Unified sharpness API */
const Sharpness = {
  compute(imageData) {
    if (WasmEngine.available) { const r=WasmEngine.computeSharpness(imageData); if(r) return r; }
    return SharpnessJS.compute(imageData);
  },
  normalize(val, refVal) { return (!refVal||refVal<1e-6)?0:Math.min(2,val/refVal); },
  dominantAxis(sh) {
    const d={h:sh.h,v:sh.v,d45:sh.d45,d135:sh.d135};
    const map={h:90,v:180,d45:135,d135:45};
    return map[Object.keys(d).reduce((a,b)=>d[a]>d[b]?a:b)]??90;
  },
};

/* ═══════════════════════════════════════════════════════════════════════════
   KALMAN FILTER (JS)
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
    try { const s=this._track.getSettings(); const raw=s.focusDistance??null; if(raw===null) return null; return filtered?this._kalman.update(raw):raw; }
    catch(_){return null;}
  },
  async lock() { if(!this._track)return false; try{await this._track.applyConstraints({advanced:[{focusMode:'manual'}]});return true;}catch(_){return false;} },
  async unlock() { if(!this._track)return false; try{await this._track.applyConstraints({advanced:[{focusMode:'continuous'}]});return true;}catch(_){return false;} },
  async waitForFocus(videoEl, captureCanvas, timeoutMs=5000, sampleMs=80) {
    const start=Date.now(), history=[];
    let stableCount=0;
    while (Date.now()-start<timeoutMs) {
      await delay(sampleMs);
      const id=captureFrame(videoEl,captureCanvas);
      if(!id) continue;
      const sh=Sharpness.compute(id);
      const fd=this.read(true);
      history.push({lap:sh.fused,shH:sh.h,shV:sh.v,sh,focDist:fd,t:Date.now()});
      if (history.length>=6) {
        const recent=history.slice(-5).map(h=>h.lap);
        const maxR=Math.max(...recent),minR=Math.min(...recent);
        const stability=maxR>0?(maxR-minR)/maxR:1;
        if(stability<0.012){stableCount++;if(stableCount>=3){const best=history.reduce((a,b)=>a.lap>b.lap?a:b);return{ok:true,...best};}}
        else stableCount=0;
      }
    }
    if(history.length){const best=history.reduce((a,b)=>a.lap>b.lap?a:b);return{ok:true,...best};}
    return{ok:false,lap:0,shH:0,shV:0,sh:null,focDist:null};
  },
  get caps(){return this._caps;},
};

/* ═══════════════════════════════════════════════════════════════════════════
   BLUR EVENT DETECTOR
   Watches a sharpness stream for the characteristic drop-then-recovery
   that happens when a lens is placed in front of the camera.
   Samples are fed via .feed(); blur metrics are read via getters.
═══════════════════════════════════════════════════════════════════════════ */
const BlurDetector = {
  _hist:      [],    // { s, sH, sV, t, fd }
  _ref:       null,  // { s, sH, sV }  — calibration baseline
  _onset:     null,  // sample at blur onset
  _peakBlur:  null,  // sample with minimum sharpness (= maximum blur)

  reset(ref) {
    this._hist     = [];
    this._ref      = ref || null;
    this._onset    = null;
    this._peakBlur = null;
  },

  // Returns: 'stable' | 'blur_onset' | 'blurred' | 'recovering' | 'converged'
  feed(sh, focDist = null) {
    const s = sh.fused, sH = sh.h, sV = sh.v;
    const t = performance.now();
    const sample = { s, sH, sV, t, fd: focDist };
    this._hist.push(sample);
    if (this._hist.length > 120) this._hist.shift();

    if (!this._ref || this._ref.s < 1) return 'stable';
    const ratio = s / this._ref.s;

    if (!this._onset) {
      // Onset: sharpness drops below 72% of baseline while previous was above 80%
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

    // Post-onset: keep tracking the peak blur (minimum sharpness sample)
    if (s < this._peakBlur.s) this._peakBlur = sample;

    const age = t - this._onset.t;
    if (ratio < 0.72) return age < 400 ? 'blur_onset' : 'blurred';
    if (ratio > 0.88) return 'converged';
    return 'recovering';
  },

  // Blur depth: 0 = no blur, 1 = completely dark
  get blurDepth() {
    if (!this._peakBlur || !this._ref?.s) return 0;
    return Math.max(0, 1 - this._peakBlur.s  / this._ref.s);
  },
  get blurDepthH() {
    if (!this._peakBlur || !this._ref?.sH || this._ref.sH < 0.5) return this.blurDepth;
    return Math.max(0, 1 - this._peakBlur.sH / this._ref.sH);
  },
  get blurDepthV() {
    if (!this._peakBlur || !this._ref?.sV || this._ref.sV < 0.5) return this.blurDepth;
    return Math.max(0, 1 - this._peakBlur.sV / this._ref.sV);
  },
  get wasDetected() { return !!this._onset;    },
  get onset()       { return this._onset;       },
  get peakBlur()    { return this._peakBlur;    },
};

/* ═══════════════════════════════════════════════════════════════════════════
   POWER CALCULATOR
═══════════════════════════════════════════════════════════════════════════ */
const PowerCalc = {
  fromFocusDist(dLens,dRef) {
    if(!dLens||!dRef||dLens<=0||dRef<=0) return{ok:false,reason:'invalid distances'};
    const raw=1/dLens-1/dRef;
    const clamped=Math.max(OPT_CONST.MIN_D,Math.min(OPT_CONST.MAX_D,raw));
    return{ok:true,rawPower:raw,power:Math.round(clamped/OPT_CONST.PREC)*OPT_CONST.PREC,method:'focus_shift'};
  },
  fromSharpnessProfile(measurements,dRef) {
    if(!measurements?.length||!dRef) return{ok:false};
    const sorted=[...measurements].sort((a,b)=>a.focusDist-b.focusDist);
    const bestH=this._parabolicPeak(sorted,'shH');
    const bestV=this._parabolicPeak(sorted,'shV');
    if(!bestH||!bestV) return{ok:false};
    const pH=this.fromFocusDist(bestH,dRef), pV=this.fromFocusDist(bestV,dRef);
    if(!pH.ok||!pV.ok) return{ok:false};
    const sphere=Math.round(((pH.rawPower+pV.rawPower)/2)/OPT_CONST.PREC)*OPT_CONST.PREC;
    const rawCyl=pH.rawPower-pV.rawPower;
    const cylinder=Math.round(rawCyl/OPT_CONST.PREC)*OPT_CONST.PREC;
    const axis=Math.abs(cylinder)>=0.25?(pH.rawPower>pV.rawPower?180:90):0;
    return{ok:true,sphere,cylinder,axis,dH:bestH,dV:bestV,method:'sharpness_profile'};
  },
  /* Estimate lens power from blur depth captured at lens-placement onset
   * (before autofocus compensates).  No focus-distance API required.
   *
   * blurH/blurV : blur fraction 0–1 for H and V sharpness channels
   * dRef        : calibration focus distance (m)
   * recovery    : final sharpness ÷ baseline sharpness after AF settles
   *
   * Sign logic (no API, sign from physics):
   *   Far cal (>0.5 m) + poor recovery → camera couldn't find d_lens
   *     → d_lens would be negative → diverging (negative) lens
   *   Far cal          + good recovery → camera focused closer → converging (positive)
   *   Close cal (<0.5m)+ good recovery → camera focused farther → diverging (negative)
   *   Close cal        + poor recovery → camera couldn't find d_lens → converging (positive)
   *
   * Accuracy note: ±0.5 D typical without focus API.
   */
  fromBlurProfile(blurH, blurV, dRef, recovery) {
    // Model: b = (K·|P|)² / (1+(K·|P|)²)  →  |P| = sqrt(b/(1-b)) / K
    // K ≈ 0.42 for a typical smartphone (f/1.8, ~4 mm actual FL)
    const K = 0.42;
    const estMag = b => {
      if (b < 0.03) return 0;
      if (b > 0.97) return 14;
      return Math.sqrt(b / (1 - b)) / K;
    };
    const magH = estMag(Math.min(0.97, blurH));
    const magV = estMag(Math.min(0.97, blurV));
    const mag  = (magH + magV) / 2;

    // XOR: (close AND good) OR (far AND bad) → diverging/negative
    const isClose    = dRef < 0.5;
    const goodRec    = (recovery ?? 0) > 0.78;
    const isDiverging = (isClose === goodRec);
    const sign = isDiverging ? -1 : 1;

    const sphere   = sign * Math.round(mag   / OPT_CONST.PREC) * OPT_CONST.PREC;
    const rawCyl   = magH - magV;
    const cylinder = Math.round(rawCyl / OPT_CONST.PREC) * OPT_CONST.PREC;
    const axis     = Math.abs(cylinder) >= 0.25 ? (magH > magV ? 180 : 90) : 0;
    return {
      ok: mag > 0,
      power: sphere, rawPower: sign * mag,
      sphere, cylinder, axis,
      method: 'blur_profile',
    };
  },

  _parabolicPeak(pts,key) {
    if(pts.length<2) return pts[0]?.focusDist??null;
    let bestI=0,bestVal=-Infinity;
    pts.forEach((p,i)=>{if(p[key]>bestVal){bestVal=p[key];bestI=i;}});
    if(bestI===0||bestI===pts.length-1) return pts[bestI].focusDist;
    const a=pts[bestI-1],b=pts[bestI],c=pts[bestI+1];
    const da=a.focusDist,db=b.focusDist,dc=c.focusDist;
    const fa=a[key],fb=b[key],fc=c[key];
    const num=da*da*(fb-fc)+db*db*(fc-fa)+dc*dc*(fa-fb);
    const den=2*(da*(fb-fc)+db*(fc-fa)+dc*(fa-fb));
    if(Math.abs(den)<1e-10) return db;
    return Math.max(0.01,num/den);
  },
  aggregateCycles(cycles) {
    if(!cycles.length) return null;
    const powers=cycles.map(c=>c.power).filter(isFinite).sort((a,b)=>a-b);
    const q1=powers[Math.floor(powers.length*0.25)],q3=powers[Math.floor(powers.length*0.75)],iqr=q3-q1;
    const lo=q1-1.5*iqr,hi=q3+1.5*iqr;
    let good=cycles.filter(c=>isFinite(c.power)&&c.power>=lo&&c.power<=hi);
    if(!good.length) good=cycles;
    const totalW=good.reduce((s,c)=>s+(c.sharpness||1),0);
    const sorted=[...good].sort((a,b)=>a.power-b.power);
    let wSum=0,medPower=sorted[Math.floor(sorted.length/2)].power;
    for(const c of sorted){wSum+=(c.sharpness||1);if(wSum>=totalW/2){medPower=c.power;break;}}
    const cylGood=good.filter(c=>Math.abs(c.cylinder??0)>=0.25);
    let cylinder=0;
    if(cylGood.length>=2){
      const totalCW=cylGood.reduce((s,c)=>s+(c.sharpness||1),0);
      const cSorted=[...cylGood].sort((a,b)=>a.cylinder-b.cylinder);
      let cWSum=0; cylinder=cSorted[Math.floor(cSorted.length/2)].cylinder;
      for(const c of cSorted){cWSum+=(c.sharpness||1);if(cWSum>=totalCW/2){cylinder=c.cylinder;break;}}
      cylinder=Math.round(cylinder/OPT_CONST.PREC)*OPT_CONST.PREC;
    }
    const axCycles=good.filter(c=>c.axis&&Math.abs(c.cylinder??0)>=0.25);
    let axis=0;
    if(axCycles.length){
      const sinS=axCycles.reduce((s,c)=>s+Math.sin(2*c.axis*Math.PI/180),0);
      const cosS=axCycles.reduce((s,c)=>s+Math.cos(2*c.axis*Math.PI/180),0);
      let a=Math.atan2(sinS,cosS)*90/Math.PI; if(a<0)a+=180; axis=Math.round(a);
    }
    return{
      sphere:Math.round(medPower/OPT_CONST.PREC)*OPT_CONST.PREC,
      cylinder,axis,cycles:good.length,confidence:good.length/OPT_CONST.CYCLES,
      allPowers:good.map(c=>c.power),method:good[0]?.method||'focus_shift',
      engine:WasmEngine.available?'wasm':'js',
    };
  },
  fmtP(p){if(p===null||p===undefined||isNaN(p))return'—';if(Math.abs(p)<0.01)return'Plano';return(p>0?'+':'')+p.toFixed(2)+' D';},
  fmtC(c){if(!c||Math.abs(c)<0.25)return'—';return(c>0?'+':'')+c.toFixed(2)+' D';},
  fmtA(a){return a?a+'°':'—';},
  classify(s,c=0){const a=Math.abs(s),cyl=c&&Math.abs(c)>=0.25?' + astigmatism':'';if(a<0.13)return'Plano'+cyl;if(s>0)return(a<=2?'Mild':a<=4?'Moderate':'High')+' hyperopia'+cyl;return(a<=2?'Mild':a<=4?'Moderate':a<=6?'High':'Very high')+' myopia'+cyl;},
  pcls(p){if(!p||Math.abs(p)<0.13)return'zero';return p>0?'pos':'neg';},
};

/* ── Utilities ── */
function delay(ms){return new Promise(r=>setTimeout(r,ms));}
function captureFrame(videoEl,canvas){const w=videoEl.videoWidth||640,h=videoEl.videoHeight||480;canvas.width=w;canvas.height=h;const ctx=canvas.getContext('2d');ctx.drawImage(videoEl,0,0,w,h);return ctx.getImageData(0,0,w,h);}

WasmEngine.load().catch(()=>{});
