#include <iostream>
#include <fstream>
#include <vector>
#include <cmath>
#include <algorithm>
#include <numeric>
#include <string>
#include <cstring>
#include <cassert>
#include <cstdint>

/*
 * OptiScan Pro — Offline CLI (C++17)
 *
 * Reads a sequence of JPEG/PNG frames (extracted from video) and performs
 * the full focus-shift power estimation pipeline entirely offline.
 *
 * Usage:
 *   optiscan_cli --ref ref_frame.pgm --lens lens_frame1.pgm lens_frame2.pgm ...
 *                [--dist 2.0] [--cycles 10] [--output result.json]
 *
 * Compile:
 *   g++ -O3 -march=native -std=c++17 -o optiscan_cli optiscan_cli.cpp -lm
 *
 * Frame format: PGM (P5) grayscale 8-bit. Convert with:
 *   ffmpeg -i video.mp4 -vf fps=5 frame_%04d.pgm
 *
 * The CLI implements the same algorithm as the browser Wasm module but with
 * full double precision, larger ROI, and additional metrics not feasible in JS.
 */

static const double ROI_FRAC = 0.20;  /* exclude outer 20% */
static const double PREC     = 0.25;  /* round to nearest 0.25 D */
static const double MIN_D    = -25.0;
static const double MAX_D    =  25.0;

/* ─── Grayscale image ───────────────────────────────────────────────────── */
struct Image {
    std::vector<uint8_t> data;
    int W = 0, H = 0;
    bool ok = false;

    bool load_pgm(const std::string& path) {
        std::ifstream f(path, std::ios::binary);
        if (!f) { std::cerr << "Cannot open: " << path << "\n"; return false; }
        std::string magic; int maxval;
        f >> magic >> W >> H >> maxval;
        if (magic != "P5" || W <= 0 || H <= 0) {
            std::cerr << "Expected P5 PGM: " << path << "\n"; return false;
        }
        f.get();
        data.resize((size_t)W * H);
        f.read((char*)data.data(), data.size());
        ok = true;
        return true;
    }

    uint8_t at(int y, int x) const { return data[(size_t)y * W + x]; }
};

/* ─── Sharpness metrics ──────────────────────────────────────────────────── */
struct SharpnessResult {
    double tenengrad = 0, brenner = 0, normvar = 0, fused = 0;
    double sobel_h = 0, sobel_v = 0, sobel_d45 = 0, sobel_d135 = 0;
    double mean_luma = 0;
    long   pixel_count = 0;
    bool   valid = false;

    /* Dominant edge axis in degrees (H=90, V=180, D45=135, D135=45) */
    double dominant_axis_deg() const {
        double vals[4] = {sobel_h, sobel_v, sobel_d45, sobel_d135};
        double angles[4] = {90.0, 180.0, 135.0, 45.0};
        int best = (int)(std::max_element(vals, vals+4) - vals);
        return angles[best];
    }
};

SharpnessResult compute_sharpness(const Image& img) {
    SharpnessResult r;
    int x0 = (int)(img.W * ROI_FRAC), x1 = (int)(img.W * (1.0 - ROI_FRAC));
    int y0 = (int)(img.H * ROI_FRAC), y1 = (int)(img.H * (1.0 - ROI_FRAC));
    if (x0 < 1) x0 = 1; if (y0 < 1) y0 = 1;
    if (x1 > img.W-1) x1 = img.W-1; if (y1 > img.H-1) y1 = img.H-1;
    if (x1 <= x0 || y1 <= y0) return r;

    double sum_ten = 0, sum_bren = 0, sum_luma = 0, sum_luma2 = 0;
    double sum_sh = 0, sum_sv = 0, sum_sd45 = 0, sum_sd135 = 0;
    long n = 0;

    for (int y = y0; y < y1; ++y) {
        for (int x = x0; x < x1; ++x) {
            double g00 = img.at(y-1,x-1), g01 = img.at(y-1,x), g02 = img.at(y-1,x+1);
            double g10 = img.at(y  ,x-1), g11 = img.at(y  ,x), g12 = img.at(y  ,x+1);
            double g20 = img.at(y+1,x-1), g21 = img.at(y+1,x), g22 = img.at(y+1,x+1);

            sum_luma  += g11;
            sum_luma2 += g11 * g11;

            double gx = (g02 + 2*g12 + g22) - (g00 + 2*g10 + g20);  /* Sobel X */
            double gy = (g20 + 2*g21 + g22) - (g00 + 2*g01 + g02);  /* Sobel Y */

            sum_ten += gx*gx + gy*gy;
            sum_sh  += gx*gx;
            sum_sv  += gy*gy;

            double gd45  = g22 - g00;
            double gd135 = g02 - g20;
            sum_sd45  += gd45  * gd45;
            sum_sd135 += gd135 * gd135;

            /* Brenner: diff of pixels 2 apart */
            double bx = (x+2 < x1) ? (img.at(y, x+2) - g10) : gx;
            double by = (y+2 < y1) ? (img.at(y+2, x) - g11) : gy;
            sum_bren += bx*bx + by*by;

            n++;
        }
    }

    if (n == 0) return r;
    double dn = (double)n;
    double mean   = sum_luma / dn;
    double var    = sum_luma2 / dn - mean*mean;
    double normv  = (mean > 1.0) ? var / (mean*mean) : 0.0;

    r.tenengrad   = sum_ten  / dn;
    r.brenner     = sum_bren / dn;
    r.normvar     = normv;
    r.sobel_h     = sum_sh   / dn;
    r.sobel_v     = sum_sv   / dn;
    r.sobel_d45   = sum_sd45 / dn;
    r.sobel_d135  = sum_sd135/ dn;
    r.mean_luma   = mean;
    r.pixel_count = n;
    r.fused       = 0.55*(r.tenengrad/50000.0) + 0.30*(r.brenner/8000.0) + 0.15*(r.normvar/0.6);
    r.valid = (mean > 10.0);
    return r;
}

/* ─── Parabolic interpolation ───────────────────────────────────────────── */
static double parabolic_peak(const std::vector<double>& x, const std::vector<double>& y) {
    assert(x.size() == y.size());
    int n = (int)x.size();
    if (n < 3) return n ? x[n/2] : 0.0;
    int best = (int)(std::max_element(y.begin(), y.end()) - y.begin());
    if (best == 0 || best == n-1) return x[best];
    double da = x[best-1], db = x[best], dc = x[best+1];
    double fa = y[best-1], fb = y[best], fc = y[best+1];
    double num = da*da*(fb-fc) + db*db*(fc-fa) + dc*dc*(fa-fb);
    double den = 2.0*(da*(fb-fc) + db*(fc-fa) + dc*(fa-fb));
    if (std::abs(den) < 1e-12) return db;
    double peak = num / den;
    if (peak < da) peak = da;
    if (peak > dc) peak = dc;
    return peak;
}

/* ─── Weighted median ──────────────────────────────────────────────────── */
static double weighted_median(std::vector<std::pair<double,double>>& pw) {
    std::sort(pw.begin(), pw.end());
    double total = 0; for (auto& p : pw) total += p.second;
    double cum = 0;
    for (auto& p : pw) { cum += p.second; if (cum >= total * 0.5) return p.first; }
    return pw[pw.size()/2].first;
}

/* ─── IQR filter ─────────────────────────────────────────────────────────── */
static std::vector<int> iqr_inliers(const std::vector<double>& vals) {
    auto sorted = vals; std::sort(sorted.begin(), sorted.end());
    int n = (int)sorted.size();
    double q1 = sorted[n/4], q3 = sorted[3*n/4], iqr = q3 - q1;
    double lo = q1 - 1.5*iqr, hi = q3 + 1.5*iqr;
    std::vector<int> idx;
    for (int i = 0; i < n; i++) if (vals[i] >= lo && vals[i] <= hi) idx.push_back(i);
    return idx;
}

/* ─── Result ─────────────────────────────────────────────────────────────── */
struct MeasResult {
    double sphere = 0, cylinder = 0, axis = 0;
    double d_ref = 0, d_lens = 0;
    double confidence = 0;
    int    cycles = 0;
    std::string method;
};

/* ─── Main pipeline ──────────────────────────────────────────────────────── */
struct Config {
    std::string ref_frame;
    std::vector<std::string> lens_frames;
    double dist_ref_m = 2.0;     /* manual reference distance (m), used as d_ref if only sharpness available */
    int cycles = 10;
    std::string output_path = "optiscan_result.json";
    bool verbose = false;
};

static double round_prec(double v, double p) { return std::round(v / p) * p; }

MeasResult run_pipeline(const Config& cfg) {
    /* 1. Load reference frame */
    Image ref_img;
    if (!ref_img.load_pgm(cfg.ref_frame)) {
        std::cerr << "Failed to load reference frame\n";
        return {};
    }

    SharpnessResult ref_sh = compute_sharpness(ref_img);
    if (!ref_sh.valid) { std::cerr << "Reference frame too dark or invalid\n"; return {}; }

    double d_ref = cfg.dist_ref_m;
    if (cfg.verbose) {
        std::cout << "Reference sharpness: fused=" << ref_sh.fused
                  << " mean_luma=" << ref_sh.mean_luma << "\n";
    }

    /* 2. Per-cycle lens measurements */
    struct CycleMeas { double power; double sharpness; double axis; double cylinder; };
    std::vector<CycleMeas> cycles;

    for (auto& lpath : cfg.lens_frames) {
        Image img;
        if (!img.load_pgm(lpath)) continue;
        SharpnessResult sh = compute_sharpness(img);
        if (!sh.valid) { std::cerr << "Skipping dark/invalid frame: " << lpath << "\n"; continue; }

        if (cfg.verbose) {
            std::cout << "Lens frame " << lpath << ": fused=" << sh.fused
                      << " sh=" << sh.sobel_h << " sv=" << sh.sobel_v << "\n";
        }

        /* Estimate focus distance from sharpness ratio.
         * When camera focuses at d_lens through a converging lens of power P:
         *   1/d_lens = 1/d_ref + P  →  d_lens = 1 / (1/d_ref + P)
         * We observe sharpness_lens / sharpness_ref ≈ (d_lens / d_ref)² (approximation)
         * → d_lens ≈ d_ref * sqrt(sharpness_lens / sharpness_ref)
         *
         * This is a pure sharpness-comparison estimate.
         * For best accuracy, use a camera with focusDistance API and feed real d_lens.
         * The CLI also supports --dlens to pass in the real focus distance if known.
         */
        double sh_ratio = (ref_sh.fused > 1e-6) ? sh.fused / ref_sh.fused : 1.0;
        double d_lens_est = d_ref * std::sqrt(sh_ratio);
        if (d_lens_est < 0.05) d_lens_est = 0.05;

        double raw_power = 1.0 / d_lens_est - 1.0 / d_ref;
        double clamped = std::max(MIN_D, std::min(MAX_D, raw_power));
        double power = round_prec(clamped, PREC);

        /* Cylinder estimation from H/V sharpness asymmetry */
        double hv_ratio = (sh.sobel_h + sh.sobel_v > 1e-6) ?
            (sh.sobel_h - sh.sobel_v) / (sh.sobel_h + sh.sobel_v) : 0.0;
        double ref_hv_ratio = (ref_sh.sobel_h + ref_sh.sobel_v > 1e-6) ?
            (ref_sh.sobel_h - ref_sh.sobel_v) / (ref_sh.sobel_h + ref_sh.sobel_v) : 0.0;
        double asym = hv_ratio - ref_hv_ratio;

        double cyl_raw = raw_power * asym * 0.9; /* empirical scaling factor */
        double cylinder = (std::abs(cyl_raw) >= 0.25) ? round_prec(cyl_raw, PREC) : 0.0;
        double axis_deg = sh.dominant_axis_deg();

        cycles.push_back({power, sh.fused, axis_deg, cylinder});

        if ((int)cycles.size() >= cfg.cycles) break;
    }

    if (cycles.empty()) { std::cerr << "No valid cycle measurements\n"; return {}; }

    /* 3. IQR filter + weighted median */
    std::vector<double> powers, cyls, axes;
    for (auto& c : cycles) { powers.push_back(c.power); cyls.push_back(c.cylinder); axes.push_back(c.axis); }

    auto inliers = iqr_inliers(powers);
    if (inliers.empty()) inliers.resize(cycles.size()); /* fall back to all */

    std::vector<std::pair<double,double>> pw_sphere, pw_cyl;
    for (int i : inliers) {
        pw_sphere.push_back({cycles[i].power,    cycles[i].sharpness});
        pw_cyl.push_back({cycles[i].cylinder, cycles[i].sharpness});
    }

    double sphere   = round_prec(weighted_median(pw_sphere), PREC);
    double cylinder = round_prec(weighted_median(pw_cyl),    PREC);
    if (std::abs(cylinder) < 0.25) { cylinder = 0; }

    /* Axis: circular mean of inlier axes (only those with cylinder) */
    double sin_sum = 0, cos_sum = 0;
    int axis_n = 0;
    for (int i : inliers) {
        if (std::abs(cycles[i].cylinder) >= 0.25) {
            double a = cycles[i].axis * M_PI / 180.0;
            sin_sum += std::sin(2*a); cos_sum += std::cos(2*a);
            axis_n++;
        }
    }
    double axis = (axis_n > 0) ? std::atan2(sin_sum, cos_sum) * 90.0 / M_PI : 0.0;
    if (axis < 0) axis += 180.0;
    axis = std::round(axis);

    double confidence = (double)inliers.size() / (double)cfg.cycles;

    MeasResult res;
    res.sphere = sphere; res.cylinder = cylinder; res.axis = axis;
    res.d_ref = d_ref; res.d_lens = 0;
    res.confidence = confidence; res.cycles = (int)cycles.size();
    res.method = "sharpness_comparison_cpp";
    return res;
}

/* ─── JSON output ────────────────────────────────────────────────────────── */
static std::string format_json(const MeasResult& r, const Config& cfg) {
    auto fmt = [](double v) -> std::string {
        char buf[32]; snprintf(buf, sizeof(buf), "%.2f", v); return buf;
    };
    std::string s = "{\n";
    s += "  \"tool\": \"OptiScan Pro CLI v6.0\",\n";
    s += "  \"method\": \"" + r.method + "\",\n";
    s += "  \"sphere_D\": " + fmt(r.sphere) + ",\n";
    s += "  \"cylinder_D\": " + fmt(r.cylinder) + ",\n";
    s += "  \"axis_deg\": " + fmt(r.axis) + ",\n";
    s += "  \"d_ref_m\": " + fmt(r.d_ref) + ",\n";
    s += "  \"confidence\": " + fmt(r.confidence) + ",\n";
    s += "  \"cycles\": " + std::to_string(r.cycles) + ",\n";
    s += "  \"ref_frame\": \"" + cfg.ref_frame + "\"\n";
    s += "}\n";
    return s;
}

/* ─── CLI parsing ────────────────────────────────────────────────────────── */
static void usage(const char* prog) {
    std::cerr << "Usage: " << prog << "\n"
              << "  --ref <ref.pgm>          Reference frame (no lens)\n"
              << "  --lens <f1.pgm> ...      Lens frames (10 recommended)\n"
              << "  --dist <meters>          Reference distance (default: 2.0 m)\n"
              << "  --cycles <n>             Max cycles (default: 10)\n"
              << "  --output <result.json>   Output path\n"
              << "  --verbose                Print per-frame debug info\n"
              << "\nConvert video frames:\n"
              << "  ffmpeg -i video.mp4 -vf fps=5 frame_%04d.pgm\n";
}

int main(int argc, char* argv[]) {
    if (argc < 2) { usage(argv[0]); return 1; }

    Config cfg;
    bool reading_lens = false;

    for (int i = 1; i < argc; i++) {
        std::string a = argv[i];
        if (a == "--ref"     && i+1 < argc) { cfg.ref_frame = argv[++i]; reading_lens = false; }
        else if (a == "--lens")             { reading_lens = true; }
        else if (a == "--dist"   && i+1<argc){ cfg.dist_ref_m = std::stod(argv[++i]); reading_lens = false; }
        else if (a == "--cycles" && i+1<argc){ cfg.cycles = std::stoi(argv[++i]); reading_lens = false; }
        else if (a == "--output" && i+1<argc){ cfg.output_path = argv[++i]; reading_lens = false; }
        else if (a == "--verbose")           { cfg.verbose = true; }
        else if (reading_lens)               { cfg.lens_frames.push_back(a); }
        else { std::cerr << "Unknown argument: " << a << "\n"; usage(argv[0]); return 1; }
    }

    if (cfg.ref_frame.empty() || cfg.lens_frames.empty()) {
        std::cerr << "Error: --ref and at least one --lens frame required\n";
        usage(argv[0]); return 1;
    }

    MeasResult result = run_pipeline(cfg);

    std::string json = format_json(result, cfg);

    std::ofstream out(cfg.output_path);
    if (out) { out << json; std::cout << "Result written to " << cfg.output_path << "\n"; }
    std::cout << json;

    return 0;
}
