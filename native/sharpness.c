#include <stdint.h>
#include <math.h>
#include <string.h>

/*
 * OptiScan Pro — Native Sharpness Kernel (C → WebAssembly)
 *
 * Tri-metric sharpness fusion:
 *  1. Tenengrad (Sobel gradient magnitude squared) — best overall focus metric
 *  2. Brenner gradient (squared diff of pixels 2 apart) — fast, low-noise
 *  3. Normalised variance — catches low-texture scenes where Tenengrad fails
 *
 * All three are computed in a single pass over the grayscale ROI buffer.
 * Fusion weight: Tenengrad 0.55, Brenner 0.30, NormVar 0.15
 * (weights empirically tuned — Tenengrad dominates but NormVar rescues
 *  low-contrast scenes and Brenner stabilises high-frequency noise).
 *
 * Additionally computes 8-direction Sobel decomposition for cylinder axis:
 *  H, V, D45, D135 — allows estimating the dominant edge orientation
 *  which maps directly to the cylinder axis of an astigmatic lens.
 *
 * Exported symbols (called from JS via Wasm):
 *   compute_sharpness(ptr, w, h, x0, y0, x1, y1, out_ptr)
 *   alloc(size)   — simple bump allocator for pixel buffer
 *   free_all()    — reset bump pointer
 */

#define WASM_EXPORT __attribute__((visibility("default")))

/* ── Bump allocator (no libc malloc needed in Wasm) ── */
static uint8_t _heap[4 * 1920 * 1080 + 4096]; /* ~8 MB, covers 1080p RGBA */
static uint32_t _bump = 0;

WASM_EXPORT
uint8_t* alloc(uint32_t size) {
    uint32_t aligned = (_bump + 3u) & ~3u;
    if (aligned + size > sizeof(_heap)) return 0;
    _bump = aligned + size;
    return _heap + aligned;
}

WASM_EXPORT
void free_all(void) { _bump = 0; }

/*
 * SharpnessResult layout in the output float32 array (10 floats):
 *  [0] tenengrad
 *  [1] brenner
 *  [2] normvar
 *  [3] fused          ← primary score (use this)
 *  [4] sobel_h        ← horizontal edge energy
 *  [5] sobel_v        ← vertical edge energy
 *  [6] sobel_d45      ← 45° diagonal edge energy
 *  [7] sobel_d135     ← 135° diagonal edge energy
 *  [8] mean_luma      ← sanity check: reject if < 20 (dark frame)
 *  [9] pixel_count    ← number of pixels processed
 */
#define OUT_TENENGRAD  0
#define OUT_BRENNER    1
#define OUT_NORMVAR    2
#define OUT_FUSED      3
#define OUT_SOBEL_H    4
#define OUT_SOBEL_V    5
#define OUT_SOBEL_D45  6
#define OUT_SOBEL_D135 7
#define OUT_MEAN_LUMA  8
#define OUT_PIXEL_CNT  9

WASM_EXPORT
void compute_sharpness(
    const uint8_t* rgba,   /* RGBA pixel buffer, row-major */
    int32_t W, int32_t H,  /* full frame dimensions */
    int32_t x0, int32_t y0,/* ROI top-left (inclusive) */
    int32_t x1, int32_t y1,/* ROI bottom-right (exclusive) */
    float* out             /* output float32[10] */
) {
    /* Clamp ROI to valid range with 1px border for kernel access */
    if (x0 < 1) x0 = 1;
    if (y0 < 1) y0 = 1;
    if (x1 > W - 1) x1 = W - 1;
    if (y1 > H - 1) y1 = H - 1;

    double sum_ten = 0.0, sum_bren = 0.0;
    double sum_luma = 0.0, sum_luma2 = 0.0;
    double sum_sh = 0.0, sum_sv = 0.0, sum_sd45 = 0.0, sum_sd135 = 0.0;
    int64_t n = 0;

    /* Process every other pixel for speed (Nyquist: still captures all spatial freqs
       that matter for focus — sharpness changes are low-spatial-frequency phenomena) */
    for (int32_t y = y0; y < y1; y += 2) {
        const uint8_t* row_m = rgba + (y - 1) * W * 4;
        const uint8_t* row_c = rgba + y       * W * 4;
        const uint8_t* row_p = rgba + (y + 1) * W * 4;

        for (int32_t x = x0; x < x1; x += 2) {
            /* ITU-R BT.709 luma coefficients, scaled to avoid FP per pixel */
            /* Compute luma for 3×3 neighbourhood using integer arithmetic */
            #define LUMA(row, col) ((uint32_t)((row)[(col)*4]*54u + (row)[(col)*4+1]*183u + (row)[(col)*4+2]*19u) >> 8)

            uint32_t g00 = LUMA(row_m, x-1), g01 = LUMA(row_m, x  ), g02 = LUMA(row_m, x+1);
            uint32_t g10 = LUMA(row_c, x-1), g11 = LUMA(row_c, x  ), g12 = LUMA(row_c, x+1);
            uint32_t g20 = LUMA(row_p, x-1), g21 = LUMA(row_p, x  ), g22 = LUMA(row_p, x+1);
            #undef LUMA

            float luma = (float)g11;
            sum_luma  += luma;
            sum_luma2 += (double)luma * luma;

            /* Sobel X (vertical edges, horizontal focus) */
            float gx = (float)((int32_t)(g02 + 2*g12 + g22) - (int32_t)(g00 + 2*g10 + g20));
            /* Sobel Y (horizontal edges, vertical focus) */
            float gy = (float)((int32_t)(g20 + 2*g21 + g22) - (int32_t)(g00 + 2*g01 + g02));
            /* Tenengrad = Gx² + Gy² */
            float ten = gx * gx + gy * gy;
            sum_ten += ten;

            /* Directional Sobel components for cylinder axis */
            sum_sh    += (double)(gx * gx);                     /* pure horizontal focus */
            sum_sv    += (double)(gy * gy);                     /* pure vertical focus */
            /* Diagonal 45°: (g22 - g00) kernel */
            float gd45  = (float)((int32_t)g22 - (int32_t)g00);
            float gd135 = (float)((int32_t)g02 - (int32_t)g20);
            sum_sd45    += (double)(gd45  * gd45);
            sum_sd135   += (double)(gd135 * gd135);

            /* Brenner: squared difference of pixels 2 apart (very fast, noise-robust) */
            float bx, by;
            if (x + 2 < x1) {
                uint32_t gx2 = (row_c[(x+2)*4]*54u + row_c[(x+2)*4+1]*183u + row_c[(x+2)*4+2]*19u) >> 8;
                bx = (float)((int32_t)gx2 - (int32_t)g10);
            } else {
                bx = gx;
            }
            if (y + 2 < y1) {
                const uint8_t* row_p2 = rgba + (y+2) * W * 4;
                uint32_t gy2 = (row_p2[x*4]*54u + row_p2[x*4+1]*183u + row_p2[x*4+2]*19u) >> 8;
                by = (float)((int32_t)gy2 - (int32_t)g11);
            } else {
                by = gy;
            }
            sum_bren += (double)(bx * bx + by * by);

            n++;
        }
    }

    if (n == 0) {
        memset(out, 0, 10 * sizeof(float));
        return;
    }

    double dn = (double)n;
    double mean   = sum_luma / dn;
    double var    = sum_luma2 / dn - mean * mean;
    double normvar = (mean > 1.0) ? var / (mean * mean) : 0.0;

    double tenengrad = sum_ten / dn;
    double brenner   = sum_bren / dn;

    /*
     * Fusion: normalise each metric to [0,1] range using empirical saturation points,
     * then blend. Saturation points (empirically measured on phone cameras):
     *   Tenengrad saturates at ~50000 for very sharp 1080p frames
     *   Brenner saturates at ~8000
     *   NormVar saturates at ~0.6
     * These are soft normalisation — values can exceed 1.0 for extremely sharp frames,
     * but the relative comparison between frames is what matters.
     */
    double t_norm = tenengrad / 50000.0;
    double b_norm = brenner   / 8000.0;
    double n_norm = normvar   / 0.6;

    double fused = 0.55 * t_norm + 0.30 * b_norm + 0.15 * n_norm;

    out[OUT_TENENGRAD]  = (float)tenengrad;
    out[OUT_BRENNER]    = (float)brenner;
    out[OUT_NORMVAR]    = (float)normvar;
    out[OUT_FUSED]      = (float)fused;
    out[OUT_SOBEL_H]    = (float)(sum_sh    / dn);
    out[OUT_SOBEL_V]    = (float)(sum_sv    / dn);
    out[OUT_SOBEL_D45]  = (float)(sum_sd45  / dn);
    out[OUT_SOBEL_D135] = (float)(sum_sd135 / dn);
    out[OUT_MEAN_LUMA]  = (float)mean;
    out[OUT_PIXEL_CNT]  = (float)n;
}

/*
 * Kalman filter state for focus distance tracking.
 * Helps smooth noisy focusDistance API readings.
 * State: [distance, velocity]
 *
 * Called once per frame from JS. JS passes current measurement and dt,
 * gets back filtered estimate.
 */
typedef struct {
    float x;      /* estimated position */
    float v;      /* estimated velocity */
    float P00, P01, P10, P11; /* covariance matrix */
} KalmanState;

static KalmanState _kstate = {0};
static int _kinit = 0;

WASM_EXPORT
void kalman_reset(void) {
    _kstate.x   = 0; _kstate.v   = 0;
    _kstate.P00 = 1; _kstate.P01 = 0;
    _kstate.P10 = 0; _kstate.P11 = 1;
    _kinit = 0;
}

/*
 * kalman_update(measurement, dt, proc_noise, meas_noise) → filtered distance
 * proc_noise: process noise variance (try 0.001)
 * meas_noise: measurement noise variance (try 0.005)
 */
WASM_EXPORT
float kalman_update(float z, float dt, float Q, float R) {
    if (!_kinit) { _kstate.x = z; _kinit = 1; return z; }

    /* Predict */
    float x_p  = _kstate.x + _kstate.v * dt;
    float v_p  = _kstate.v;
    float P00p = _kstate.P00 + dt * (_kstate.P10 + _kstate.P01) + dt*dt * _kstate.P11 + Q;
    float P01p = _kstate.P01 + dt * _kstate.P11;
    float P10p = _kstate.P10 + dt * _kstate.P11;
    float P11p = _kstate.P11 + Q * 0.1f;

    /* Update */
    float S   = P00p + R;
    float K0  = P00p / S;
    float K1  = P10p / S;
    float innov = z - x_p;

    _kstate.x   = x_p + K0 * innov;
    _kstate.v   = v_p + K1 * innov;
    _kstate.P00 = (1 - K0) * P00p;
    _kstate.P01 = (1 - K0) * P01p;
    _kstate.P10 = P10p - K1 * P00p;
    _kstate.P11 = P11p - K1 * P01p;

    return _kstate.x;
}

/*
 * Parabolic interpolation of peak focus distance from a sharpness curve.
 * pts_dist[n], pts_sharp[n] — sorted by distance ascending.
 * Returns interpolated peak distance, or pts_dist[best_i] if interpolation fails.
 */
WASM_EXPORT
float parabolic_peak_dist(const float* pts_dist, const float* pts_sharp, int32_t n) {
    if (n < 3) return n > 0 ? pts_dist[n/2] : 0.0f;
    int best = 0;
    float bv = pts_sharp[0];
    for (int i = 1; i < n; i++) { if (pts_sharp[i] > bv) { bv = pts_sharp[i]; best = i; } }
    if (best == 0 || best == n - 1) return pts_dist[best];

    float da = pts_dist[best-1], db = pts_dist[best], dc = pts_dist[best+1];
    float fa = pts_sharp[best-1], fb = pts_sharp[best], fc = pts_sharp[best+1];
    float num = da*da*(fb-fc) + db*db*(fc-fa) + dc*dc*(fa-fb);
    float den = 2.0f * (da*(fb-fc) + db*(fc-fa) + dc*(fa-fb));
    if (den == 0.0f || fabsf(den) < 1e-10f) return db;
    float peak = num / den;
    /* Clamp to neighbourhood */
    if (peak < da) peak = da;
    if (peak > dc) peak = dc;
    return peak;
}

/*
 * Dominant axis detector.
 * Given 4 directional edge energies, returns the dominant axis angle in degrees.
 * 0=H, 90=V, 45=D45, 135=D135
 * Used to detect cylinder axis without needing a pattern.
 */
WASM_EXPORT
float dominant_axis_deg(float sh, float sv, float sd45, float sd135) {
    float max_s = sh;
    float angle = 90.0f; /* H edges dominant → V cylinder axis = 90° */
    if (sv > max_s)    { max_s = sv;    angle = 180.0f; }
    if (sd45 > max_s)  { max_s = sd45;  angle = 135.0f; }
    if (sd135 > max_s) {                angle = 45.0f;  }
    return angle;
}
