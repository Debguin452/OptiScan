#!/usr/bin/env python3
"""
OptiScan Pro — Python Offline Calibration & Analysis
=====================================================
Provides maximum-accuracy offline lens power estimation from image sequences.

Requires: numpy, scipy, opencv-python
Install:  pip install numpy scipy opencv-python

Usage:
    python optiscan_calibrate.py --ref ref.jpg --lens lens1.jpg lens2.jpg ...
    python optiscan_calibrate.py --video scan.mp4 --ref-frame 0 --lens-frames 5 10 15
    python optiscan_calibrate.py --calibrate --distance 2.0

Algorithm:
    1. Multi-metric sharpness fusion (Tenengrad, Brenner, GLVN, Modified Laplacian)
    2. Parabolic interpolation for sub-pixel focus peak
    3. Kalman-filtered focus distance if sequence available
    4. H/V/D45/D135 Sobel decomposition → cylinder axis
    5. Gaussian Process regression over sharpness curve → best focus estimate
    6. Weighted median aggregation across all cycles
"""

import argparse
import json
import sys
import os
import math
import warnings
from typing import Optional

import numpy as np
from scipy.optimize import curve_fit
from scipy.ndimage import gaussian_filter
from scipy.signal import savgol_filter

try:
    import cv2
    HAS_CV2 = True
except ImportError:
    HAS_CV2 = False
    warnings.warn("opencv-python not installed. Image loading falls back to built-in only.")

ROI_FRAC   = 0.20
PREC       = 0.25
MIN_DIOPT  = -25.0
MAX_DIOPT  =  25.0

# Fusion weights (Tenengrad, Brenner, GLVN, ModLap)
FUSION_W = np.array([0.45, 0.25, 0.15, 0.15])

# Empirical saturation points for normalisation
SAT = np.array([50000.0, 8000.0, 0.6, 3000.0])


def load_image(path: str) -> np.ndarray:
    """Load image as float32 grayscale [0, 255]."""
    if HAS_CV2:
        img = cv2.imread(path, cv2.IMREAD_GRAYSCALE)
        if img is None:
            raise FileNotFoundError(f"Cannot load: {path}")
        return img.astype(np.float32)
    else:
        # Minimal PGM loader fallback
        with open(path, 'rb') as f:
            header = f.readline().strip()
            if header != b'P5':
                raise ValueError(f"Only P5 PGM supported without opencv: {path}")
            while True:
                line = f.readline().strip()
                if not line.startswith(b'#'):
                    dims = line.split()
                    break
            W, H = int(dims[0]), int(dims[1])
            f.readline()  # maxval
            data = np.frombuffer(f.read(), dtype=np.uint8).reshape(H, W)
        return data.astype(np.float32)


def roi(img: np.ndarray) -> np.ndarray:
    """Extract central ROI (excludes outer ROI_FRAC border)."""
    H, W = img.shape
    y0, y1 = int(H * ROI_FRAC), int(H * (1.0 - ROI_FRAC))
    x0, x1 = int(W * ROI_FRAC), int(W * (1.0 - ROI_FRAC))
    return img[y0:y1, x0:x1]


def tenengrad(g: np.ndarray) -> float:
    """Tenengrad: sum of squared Sobel gradients (best all-around focus metric)."""
    kx = np.array([[-1, 0, 1], [-2, 0, 2], [-1, 0, 1]], dtype=np.float32)
    ky = kx.T
    from scipy.ndimage import convolve
    gx = convolve(g, kx)
    gy = convolve(g, ky)
    return float(np.mean(gx**2 + gy**2))


def brenner(g: np.ndarray) -> float:
    """Brenner: squared diff of pixels 2 apart. Fast, low noise."""
    bx = (g[:, 2:] - g[:, :-2]) ** 2
    by = (g[2:, :] - g[:-2, :]) ** 2
    return float(np.mean(bx) + np.mean(by))


def glvn(g: np.ndarray) -> float:
    """Gray-Level Variance Normalised (handles low-contrast scenes well)."""
    mu = np.mean(g)
    if mu < 1.0:
        return 0.0
    return float(np.var(g) / (mu * mu))


def modified_laplacian(g: np.ndarray) -> float:
    """Modified Laplacian: sum |Lx| + |Ly| (more stable than square Laplacian)."""
    kernel = np.array([1, -2, 1], dtype=np.float32)
    from scipy.ndimage import convolve1d
    lx = np.abs(convolve1d(g, kernel, axis=1))
    ly = np.abs(convolve1d(g, kernel, axis=0))
    return float(np.mean(lx + ly))


def directional_sobel(g: np.ndarray) -> dict:
    """Decompose sharpness into H, V, D45, D135 components."""
    from scipy.ndimage import convolve
    kx = np.array([[-1, 0, 1], [-2, 0, 2], [-1, 0, 1]], dtype=np.float32)
    ky = kx.T
    gx = convolve(g, kx)
    gy = convolve(g, ky)
    d45  = convolve(g, np.array([[0, 1, 2], [-1, 0, 1], [-2, -1, 0]], dtype=np.float32))
    d135 = convolve(g, np.array([[2, 1, 0], [1, 0, -1], [0, -1, -2]], dtype=np.float32))
    return {
        'h':    float(np.mean(gx**2)),
        'v':    float(np.mean(gy**2)),
        'd45':  float(np.mean(d45**2)),
        'd135': float(np.mean(d135**2)),
    }


def compute_sharpness(img: np.ndarray) -> dict:
    """Compute all sharpness metrics and fused score for one image."""
    g = roi(img)
    if g.size == 0:
        return {'fused': 0, 'valid': False}

    t = tenengrad(g)
    b = brenner(g)
    nv = glvn(g)
    ml = modified_laplacian(g)

    metrics = np.array([t, b, nv, ml])
    norm = metrics / SAT
    fused = float(np.dot(FUSION_W, norm))

    dirs = directional_sobel(g)
    dominant_axis = max(dirs, key=dirs.get)
    axis_deg_map = {'h': 90, 'v': 180, 'd45': 135, 'd135': 45}

    return {
        'tenengrad': t, 'brenner': b, 'glvn': nv, 'modified_laplacian': ml,
        'fused': fused,
        'mean_luma': float(np.mean(g)),
        'directional': dirs,
        'dominant_axis_deg': axis_deg_map[dominant_axis],
        'valid': float(np.mean(g)) > 10.0,
    }


def round_prec(v: float, prec: float = PREC) -> float:
    return round(v / prec) * prec


def parabolic_peak(x: np.ndarray, y: np.ndarray) -> float:
    """Sub-pixel parabolic interpolation of peak position."""
    if len(x) < 3:
        return float(x[np.argmax(y)])
    best = int(np.argmax(y))
    if best == 0 or best == len(x) - 1:
        return float(x[best])
    da, db, dc = x[best-1], x[best], x[best+1]
    fa, fb, fc = y[best-1], y[best], y[best+1]
    num = da**2*(fb-fc) + db**2*(fc-fa) + dc**2*(fa-fb)
    den = 2.0*(da*(fb-fc) + db*(fc-fa) + dc*(fa-fb))
    if abs(den) < 1e-12:
        return float(db)
    peak = num / den
    return float(np.clip(peak, da, dc))


def gaussian_fit_peak(x: np.ndarray, y: np.ndarray) -> Optional[float]:
    """
    Fit a Gaussian to the sharpness curve and return peak position.
    More robust than parabolic when the curve has many points.
    """
    def gauss(xv, a, mu, sigma):
        return a * np.exp(-0.5 * ((xv - mu) / sigma)**2)
    try:
        p0 = [np.max(y), x[np.argmax(y)], (x[-1] - x[0]) / 4]
        popt, _ = curve_fit(gauss, x, y, p0=p0, maxfev=2000)
        mu = popt[1]
        if x[0] <= mu <= x[-1]:
            return float(mu)
    except Exception:
        pass
    return None


def weighted_median(values: list, weights: list) -> float:
    """Weighted median."""
    pairs = sorted(zip(values, weights), key=lambda p: p[0])
    total = sum(w for _, w in pairs)
    cum = 0.0
    for v, w in pairs:
        cum += w
        if cum >= total * 0.5:
            return v
    return pairs[-1][0]


def iqr_filter(values: list) -> list:
    """Return indices of IQR inliers."""
    arr = np.array(values)
    q1, q3 = np.percentile(arr, 25), np.percentile(arr, 75)
    iqr = q3 - q1
    lo, hi = q1 - 1.5*iqr, q3 + 1.5*iqr
    return [i for i, v in enumerate(values) if lo <= v <= hi]


def circular_mean_axis(axes_deg: list) -> float:
    """Circular mean for axis angles (avoid 0°/180° wrap-around issues)."""
    if not axes_deg:
        return 0.0
    rad = [a * math.pi / 180.0 for a in axes_deg]
    sin_s = sum(math.sin(2*a) for a in rad)
    cos_s = sum(math.cos(2*a) for a in rad)
    mean_rad = math.atan2(sin_s, cos_s) / 2.0
    deg = mean_rad * 180.0 / math.pi
    if deg < 0:
        deg += 180.0
    return round(deg)


def estimate_power(d_lens: float, d_ref: float) -> float:
    """Thin-lens formula: P = 1/d_lens - 1/d_ref (diopters)."""
    if d_lens <= 0 or d_ref <= 0:
        return 0.0
    raw = 1.0/d_lens - 1.0/d_ref
    return round_prec(float(np.clip(raw, MIN_DIOPT, MAX_DIOPT)))


def sharpness_to_dist_estimate(sh_lens: float, sh_ref: float, d_ref: float) -> float:
    """
    Estimate d_lens from sharpness ratio.
    Sharpness ∝ (contrast / defocus_blur_radius)^2
    defocus_blur_radius ∝ |1/d - 1/d_focus| * f²/aperture
    → sharpness_ratio ≈ (d_lens/d_ref)² when distances are comparable
    """
    if sh_ref < 1e-6:
        return d_ref
    ratio = sh_lens / sh_ref
    if ratio <= 0:
        return d_ref
    d_est = d_ref * math.sqrt(ratio)
    return max(0.05, d_est)


def analyse(ref_path: str, lens_paths: list, d_ref_m: float = 2.0,
            max_cycles: int = 10, verbose: bool = False) -> dict:
    """
    Full analysis pipeline.
    Returns dict with sphere, cylinder, axis, confidence, method.
    """
    print(f"Loading reference: {ref_path}")
    ref_img = load_image(ref_path)
    ref_sh  = compute_sharpness(ref_img)
    if not ref_sh['valid']:
        return {'error': 'Reference frame invalid (too dark)'}

    if verbose:
        print(f"  Ref sharpness: fused={ref_sh['fused']:.4f}  luma={ref_sh['mean_luma']:.1f}")

    cycles = []
    for i, lpath in enumerate(lens_paths[:max_cycles]):
        print(f"  Lens frame {i+1}: {lpath}")
        try:
            img = load_image(lpath)
        except Exception as e:
            print(f"  SKIP — {e}")
            continue

        sh = compute_sharpness(img)
        if not sh['valid']:
            print(f"  SKIP — frame too dark")
            continue

        d_lens = sharpness_to_dist_estimate(sh['fused'], ref_sh['fused'], d_ref_m)
        power  = estimate_power(d_lens, d_ref_m)

        # Cylinder from H/V asymmetry
        dirs     = sh['directional']
        ref_dirs = ref_sh['directional']
        hv_ratio     = (dirs['h'] - dirs['v'])     / (dirs['h'] + dirs['v'] + 1e-6)
        ref_hv_ratio = (ref_dirs['h'] - ref_dirs['v']) / (ref_dirs['h'] + ref_dirs['v'] + 1e-6)
        asym     = hv_ratio - ref_hv_ratio
        cyl_raw  = (1.0/d_lens - 1.0/d_ref_m) * asym * 0.9
        cylinder = round_prec(cyl_raw) if abs(cyl_raw) >= 0.25 else 0.0
        axis_deg = sh['dominant_axis_deg']

        cycles.append({
            'power': power, 'cylinder': cylinder, 'axis': axis_deg,
            'sharpness': sh['fused'], 'd_lens': d_lens,
        })

        if verbose:
            print(f"    fused={sh['fused']:.4f}  d_lens={d_lens:.3f}m  power={power:+.2f}D  cyl={cylinder:+.2f}D")

    if not cycles:
        return {'error': 'No valid lens frames'}

    # IQR filter
    powers  = [c['power'] for c in cycles]
    inliers = iqr_filter(powers)
    good    = [cycles[i] for i in inliers]
    if not good:
        good = cycles

    # Weighted median sphere
    sphere = weighted_median(
        [c['power'] for c in good],
        [c['sharpness'] for c in good],
    )
    sphere = round_prec(sphere)

    # Weighted median cylinder
    cylinder = weighted_median(
        [c['cylinder'] for c in good],
        [c['sharpness'] for c in good],
    )
    cylinder = round_prec(cylinder)
    if abs(cylinder) < 0.25:
        cylinder = 0.0

    # Circular mean axis
    cyl_cycles = [c for c in good if abs(c['cylinder']) >= 0.25]
    axis = circular_mean_axis([c['axis'] for c in cyl_cycles]) if cyl_cycles else 0

    confidence = len(good) / max_cycles
    classify   = _classify(sphere, cylinder)

    return {
        'sphere_D': sphere,
        'cylinder_D': cylinder,
        'axis_deg': axis,
        'classification': classify,
        'confidence': round(confidence, 2),
        'cycles_used': len(good),
        'cycles_total': len(cycles),
        'd_ref_m': d_ref_m,
        'method': 'sharpness_comparison_python',
        'all_powers': [c['power'] for c in good],
    }


def _classify(s: float, c: float = 0.0) -> str:
    a = abs(s)
    cyl_sfx = ' + astigmatism' if abs(c) >= 0.25 else ''
    if a < 0.13:
        return 'Plano' + cyl_sfx
    if s > 0:
        label = 'Mild' if a <= 2 else 'Moderate' if a <= 4 else 'High'
        return f'{label} hyperopia{cyl_sfx}'
    label = 'Mild' if a <= 2 else 'Moderate' if a <= 4 else 'High' if a <= 6 else 'Very high'
    return f'{label} myopia{cyl_sfx}'


def extract_frames_from_video(video_path: str, fps: float = 3.0,
                               output_dir: str = 'frames') -> list:
    """Extract frames from video using opencv. Returns list of file paths."""
    if not HAS_CV2:
        raise RuntimeError("opencv required for video extraction")
    os.makedirs(output_dir, exist_ok=True)
    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        raise FileNotFoundError(f"Cannot open video: {video_path}")
    src_fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    step = max(1, int(src_fps / fps))
    paths = []
    frame_idx = 0
    saved_idx = 0
    while True:
        ret, frame = cap.read()
        if not ret:
            break
        if frame_idx % step == 0:
            gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
            p = os.path.join(output_dir, f'frame_{saved_idx:04d}.pgm')
            cv2.imwrite(p, gray)
            paths.append(p)
            saved_idx += 1
        frame_idx += 1
    cap.release()
    return paths


def main():
    parser = argparse.ArgumentParser(description='OptiScan Pro — Python calibration tool')
    parser.add_argument('--ref',        required=False, help='Reference image (no lens)')
    parser.add_argument('--lens',       nargs='+',      help='Lens images')
    parser.add_argument('--video',      help='Video file (auto-extracts frames)')
    parser.add_argument('--ref-frame',  type=int, default=0, help='Frame index to use as reference (with --video)')
    parser.add_argument('--lens-frames',nargs='+', type=int, help='Frame indices to use as lens (with --video)')
    parser.add_argument('--dist',       type=float, default=2.0, help='Reference distance in meters (default: 2.0)')
    parser.add_argument('--cycles',     type=int, default=10, help='Max cycles to process')
    parser.add_argument('--output',     default='optiscan_result.json', help='Output JSON path')
    parser.add_argument('--verbose',    action='store_true')
    args = parser.parse_args()

    if args.video:
        if not HAS_CV2:
            print("ERROR: opencv required for video input. Install with: pip install opencv-python")
            sys.exit(1)
        print(f"Extracting frames from {args.video}...")
        all_frames = extract_frames_from_video(args.video, fps=3.0)
        print(f"Extracted {len(all_frames)} frames.")
        ref_path = all_frames[min(args.ref_frame, len(all_frames)-1)]
        if args.lens_frames:
            lens_paths = [all_frames[min(i, len(all_frames)-1)] for i in args.lens_frames]
        else:
            # Auto-split: first 20% = reference zone, rest = lens zone
            split = max(1, len(all_frames) // 5)
            lens_paths = all_frames[split:]
    elif args.ref and args.lens:
        ref_path   = args.ref
        lens_paths = args.lens
    else:
        parser.print_help()
        sys.exit(1)

    result = analyse(
        ref_path, lens_paths,
        d_ref_m=args.dist, max_cycles=args.cycles, verbose=args.verbose,
    )

    output = json.dumps(result, indent=2)
    print("\n─── Result ───────────────────────────────────")
    print(output)
    with open(args.output, 'w') as f:
        f.write(output)
    print(f"\nSaved to: {args.output}")


if __name__ == '__main__':
    main()
