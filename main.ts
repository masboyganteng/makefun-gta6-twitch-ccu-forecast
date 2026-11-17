// GTA VI Twitch CCU forecaster — make.fun gta6-twitch-ccu-forecast-01
// Forecast hours 2..24 of a launch day's Twitch category viewers as five
// quantiles each, anchored on the hour-1 print.
//
// Method (written from the competition spec + the practice data's shape):
//   * Anchor p = hour-1 print (known[0].viewers), >= 1.
//   * Pool: past launches in `comparables` (except the target's own
//     pre-release history). Each launch contributes its 24 release-day
//     hourly counts as log-ratios L_h = ln(v_h / v_1), weighted by tier:
//     comparable 1.0, early-access-contaminated 0.5, weak 0.25.
//   * The launch-day curve's shape depends on HOW the game unlocked and on
//     its scale. GTA VI unlocks at rolling midnight local time on console
//     only, so the regression pool is the rolling-midnight subset: unlock
//     text mentioning "midnight local" or "rolling", and NOT a simultaneous
//     global unlock ("simultaneous" / "single global" / "single time").
//     Simultaneous launches already peak in hour 1 and decay; rolling
//     launches ramp through the day — mixing them flattens the shape.
//   * Scale effect: within the rolling subset, later hours' log-ratios fall
//     with ln(v_1) (a bigger hour-1 print means a flatter day). Per hour
//     h = 2..24, fit a tier-weighted least-squares line
//         L_h ~ a_h + b_h * ln(v_1)
//     and predict mu_h = a_h + b_h * ln(p). The spread is the weighted
//     residual standard deviation sd_h, shrunk by SPREAD_K = 0.8:
//         q_tau = p * exp(mu_h + z_tau * sd_h * 0.8)
//     with z the standard normal quantiles. (Practice: loss ~0.159, typical
//     miss ~26%, 90% coverage ~0.91 — versus 0.387 for the house baseline.)
//   * Fallbacks, per hour, in order: rolling-subset OLS -> all-pool OLS ->
//     weighted empirical quantiles of the all-pool log-ratios -> the
//     persistence-baseline shape. The whole forecast is wrapped so the
//     program never crashes: any failure degrades to the baseline shape.
//   * Deterministic: no randomness, no clock, comparables sorted by name
//     with a plain code-unit comparison.
//
// Node 22, standard library only, no network.
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const LEVELS = [0.05, 0.25, 0.5, 0.75, 0.95];
const Z = [-1.645, -0.674, 0, 0.674, 1.645]; // normal quantiles
const SPREAD_K = 0.8; // shrink factor on the residual spread
const MIN_POOL = 4; // minimum launches for a regression fit

const TIER_WEIGHT: Record<string, number> = {
  comparable: 1.0,
  "early-access-contaminated": 0.5,
  weak: 0.25,
};

type HourlyPoint = { from?: string; viewers?: unknown; channels?: unknown };
type RatioRow = { ratio: number; logV1: number; weight: number };

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

// Weighted empirical quantile (used by the quantile fallback only).
function weightedQuantile(pairs: Array<[number, number]>, level: number): number {
  const sorted = pairs.slice().sort((a, b) => a[0] - b[0]);
  let total = 0;
  for (const [, w] of sorted) total += w;
  if (total <= 0 || sorted.length === 0) return 0;
  const target = level * total;
  let cum = 0;
  for (let i = 0; i < sorted.length; i++) {
    const prev = cum;
    cum += sorted[i][1];
    if (cum >= target) {
      if (i === 0) return sorted[0][0];
      const span = cum - prev;
      const frac = span > 0 ? (target - prev) / span : 0;
      return sorted[i - 1][0] + frac * (sorted[i][0] - sorted[i - 1][0]);
    }
  }
  return sorted[sorted.length - 1][0];
}

// Tier of a comparable, parsed from its free-text `unlock` field:
// "Tier: comparable" / "Tier: early-access-contaminated" / "Tier: weak" /
// "Tier: target-history". Anything unrecognised defaults to comparable.
function tierOf(comp: any): string {
  const unlock = typeof comp?.unlock === "string" ? comp.unlock : "";
  const m = /Tier:\s*([a-z][a-z-]*)?/.exec(unlock);
  if (m && m[1]) return m[1];
  return "comparable";
}

// True for a rolling-midnight-local unlock with no simultaneous global
// unlock (the GTA VI unlock shape): the text says "midnight local" or
// "rolling" and does not say "simultaneous", "single global" or
// "single time". Case-insensitive; unrecognised text is not rolling.
function isRolling(comp: any): boolean {
  const u = typeof comp?.unlock === "string" ? comp.unlock.toLowerCase() : "";
  const rolling = u.includes("midnight local") || u.includes("rolling");
  const simul =
    u.includes("simultaneous") || u.includes("single global") || u.includes("single time");
  return rolling && !simul;
}

// Release-day hourly viewer counts for one comparable: the 24 points whose
// hour offset from day_start is 0..23. Missing / non-positive counts are null
// (never interpolated). Returns null when no release-day point exists at all.
function releaseDay(comp: any): Array<number | null> | null {
  const hourly: HourlyPoint[] = Array.isArray(comp?.hourly) ? comp.hourly : [];
  const ds = typeof comp?.day_start === "string" ? Date.parse(comp.day_start) : NaN;
  if (!Number.isFinite(ds) || hourly.length === 0) return null;
  const day: Array<number | null> = new Array(24).fill(null);
  let found = false;
  for (const pt of hourly) {
    if (typeof pt?.from !== "string") continue;
    const t = Date.parse(pt.from);
    if (!Number.isFinite(t)) continue;
    const off = Math.round((t - ds) / 3600000);
    if (off >= 0 && off < 24) {
      const v = num(pt.viewers);
      day[off] = v !== null && v > 0 ? v : null;
      found = true;
    }
  }
  return found ? day : null;
}

// Anchor: hour-1 print; else the last valid history point; else 1.
function anchorOf(c: any): number {
  const known = Array.isArray(c?.known) ? c.known : [];
  // Prefer the row explicitly marked hour 1; otherwise the first row.
  const h1 = known.find((r: any) => r?.hour === 1) ?? known[0];
  if (h1) {
    const v = num(h1?.viewers);
    if (v !== null && v > 0) return v;
  }
  const hist = Array.isArray(c?.history) ? c.history : [];
  for (let i = hist.length - 1; i >= 0; i--) {
    const v = num(hist[i]?.viewers);
    if (v !== null && v > 0) return v;
  }
  return 1;
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

// Force a 5-quantile row valid: finite, > 0, <= 1e9, non-decreasing.
function enforce(q: number[]): number[] {
  let prev = 0;
  const out: number[] = [];
  for (let i = 0; i < 5; i++) {
    let v = q[i];
    if (!Number.isFinite(v) || v <= 0) v = prev > 0 ? prev : 1;
    if (v < prev) v = prev;
    if (v > 1e9) v = 1e9;
    v = round2(v);
    if (v < prev) v = prev; // rounding must not break monotonicity
    out.push(v);
    prev = v;
  }
  return out;
}

// Persistence-baseline shape, used only as the anti-failure fallback.
function fallbackRow(p: number, h: number): number[] {
  const s = 0.15 * Math.sqrt(h - 1);
  return enforce(Z.map((z) => p * Math.exp(z * s)));
}

function fallbackRows(p: number): Array<{ hour: number; q: number[] }> {
  const rows: Array<{ hour: number; q: number[] }> = [];
  for (let h = 2; h <= 24; h++) rows.push({ hour: h, q: fallbackRow(p, h) });
  return rows;
}

// Tier-weighted least squares of y on x. Returns null when the fit is
// degenerate (too few points or no spread in x).
function wls(rows: RatioRow[]): { a: number; b: number; sd: number } | null {
  if (rows.length < MIN_POOL) return null;
  let sw = 0;
  for (const r of rows) sw += r.weight;
  if (sw <= 0) return null;
  let mx = 0;
  let my = 0;
  for (const r of rows) {
    mx += r.weight * r.logV1;
    my += r.weight * r.ratio;
  }
  mx /= sw;
  my /= sw;
  let sxx = 0;
  let sxy = 0;
  for (const r of rows) {
    sxx += r.weight * (r.logV1 - mx) * (r.logV1 - mx);
    sxy += r.weight * (r.logV1 - mx) * (r.ratio - my);
  }
  if (!(sxx > 0)) return null;
  // Clamp the slope: a launch-day shape must not rise with scale, and
  // absolute late-hour levels must not fall as hour 1 grows. The clamp
  // only bites far outside the pool's scale range (the final's hour-1
  // print may exceed every comparable's); inside the range the fitted
  // slopes (about -0.5..+0.05) are untouched.
  const b = Math.max(-1, Math.min(0.25, sxy / sxx));
  const a = my - b * mx;
  let varSum = 0;
  for (const r of rows) {
    const e = r.ratio - (a + b * r.logV1);
    varSum += r.weight * e * e;
  }
  const sd = Math.sqrt(varSum / sw);
  if (!Number.isFinite(sd) || sd <= 0) return null;
  return { a, b, sd };
}

function forecastCase(c: any): Array<{ hour: number; q: number[] }> {
  const p = anchorOf(c);
  const logP = Math.log(p);
  try {
    const comps: any[] = Array.isArray(c?.comparables) ? c.comparables : [];
    // Sort by name for a fixed iteration order (determinism). Plain
    // code-unit comparison, not locale-aware, so the order never depends
    // on the runtime's locale data.
    const sorted = comps.slice().sort((a, b) => {
      const na = String(a?.name ?? "");
      const nb = String(b?.name ?? "");
      return na < nb ? -1 : na > nb ? 1 : 0;
    });
    // Per forecast hour h (2..24): log-ratio rows for the rolling subset
    // and for the whole pool (fallback).
    const rolling: RatioRow[][] = [];
    const all: RatioRow[][] = [];
    for (let h = 0; h < 23; h++) {
      rolling.push([]);
      all.push([]);
    }
    for (const comp of sorted) {
      const name = String(comp?.name ?? "");
      const tier = tierOf(comp);
      if (tier === "target-history") continue;
      if (/grand theft auto vi/i.test(name)) continue; // the target's own history
      const w = TIER_WEIGHT[tier] ?? 1.0;
      const day = releaseDay(comp);
      if (!day) continue;
      // Denominator: hour-1 count when present, else the first valid hour.
      let denom: number | null = day[0];
      if (denom === null) {
        for (const v of day) if (v !== null) { denom = v; break; }
      }
      if (denom === null || denom <= 0) continue;
      const logDenom = Math.log(denom);
      const roll = isRolling(comp);
      for (let h = 1; h < 24; h++) {
        const v = day[h];
        if (v === null) continue;
        const row: RatioRow = { ratio: Math.log(v) - logDenom, logV1: logDenom, weight: w };
        all[h - 1].push(row);
        if (roll) rolling[h - 1].push(row);
      }
    }
    const rows: Array<{ hour: number; q: number[] }> = [];
    for (let h = 2; h <= 24; h++) {
      const idx = h - 2;
      // Primary: rolling-subset OLS. Fallback: all-pool OLS.
      const fit = wls(rolling[idx]) ?? wls(all[idx]);
      if (fit) {
        const mu = fit.a + fit.b * logP;
        const s = fit.sd * SPREAD_K;
        rows.push({ hour: h, q: enforce(Z.map((z) => p * Math.exp(mu + z * s))) });
        continue;
      }
      // Last resort before the baseline shape: weighted empirical
      // quantiles of the all-pool log-ratios for this hour.
      const pool = all[idx];
      if (pool.length >= 3) {
        const pairs: Array<[number, number]> = pool.map((r) => [r.ratio, r.weight]);
        const qs = LEVELS.map((lv) => weightedQuantile(pairs, lv));
        rows.push({ hour: h, q: enforce(qs.map((lq) => p * Math.exp(lq))) });
        continue;
      }
      rows.push({ hour: h, q: fallbackRow(p, h) });
    }
    return rows;
  } catch {
    return fallbackRows(p);
  }
}

function main(): void {
  const inDir = process.env.MAKEFUN_INPUT_DIR || "/input/";
  const outDir = process.env.MAKEFUN_OUTPUT_DIR || "/output/";
  mkdirSync(outDir, { recursive: true });
  const files = readdirSync(inDir)
    .filter((f) => f.endsWith(".in"))
    .sort();
  for (const f of files) {
    const id = f.slice(0, -3);
    let rows: Array<{ hour: number; q: number[] }>;
    try {
      const c = JSON.parse(readFileSync(join(inDir, f), "utf8"));
      rows = forecastCase(c);
    } catch {
      rows = fallbackRows(1);
    }
    const out = JSON.stringify({ hours: rows });
    writeFileSync(join(outDir, id + ".out"), out, "utf8");
  }
}

main();
