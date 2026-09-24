// Descriptive statistics and the JZS Bayes factor t-test (Rouder et al., 2009),
// matching BayesFactor::ttestBF's default Cauchy prior on effect size.
import { lgamma } from "./dist.js";

export const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
export function sd(xs) {
  if (xs.length < 2) return null;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1));
}
export function median(xs) {
  if (!xs.length) return null;
  const s = xs.slice().sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Pooled-variance two-sample t. */
export function tTwoSample(x, y) {
  const n1 = x.length;
  const n2 = y.length;
  if (n1 < 2 || n2 < 2) return null;
  const sp2 = ((n1 - 1) * sd(x) ** 2 + (n2 - 1) * sd(y) ** 2) / (n1 + n2 - 2);
  if (!(sp2 > 0)) return null;
  const t = (mean(x) - mean(y)) / Math.sqrt(sp2 * (1 / n1 + 1 / n2));
  return { t, df: n1 + n2 - 2, n1, n2, d: (mean(x) - mean(y)) / Math.sqrt(sp2) };
}

// Composite Simpson integration of f over [a, b] with n (even) intervals.
function simpson(f, a, b, n) {
  const h = (b - a) / n;
  let s = f(a) + f(b);
  for (let i = 1; i < n; i++) s += f(a + i * h) * (i % 2 ? 4 : 2);
  return (s * h) / 3;
}

/**
 * Two-sided JZS BF10 by integrating over g (Rouder et al., 2009, eq. 1, two-sample form).
 * Prior: delta ~ Cauchy(0, r).
 */
export function jzsBf10(t, n1, n2, r = 0.707) {
  const neff = (n1 * n2) / (n1 + n2);
  const df = n1 + n2 - 2;
  const logNull = (-(df + 1) / 2) * Math.log1p((t * t) / df);
  const logIntegrand = (g) =>
    -0.5 * Math.log1p(neff * g) +
    (-(df + 1) / 2) * Math.log1p((t * t) / ((1 + neff * g) * df)) +
    Math.log(r) - 0.5 * Math.log(2 * Math.PI) - 1.5 * Math.log(g) - (r * r) / (2 * g);
  // Substitute g = exp(u); dg = g du.
  const f = (u) => {
    const g = Math.exp(u);
    return Math.exp(logIntegrand(g) + u - logNull);
  };
  return simpson(f, -25, 25, 4000);
}

// log density of the non-central t at t, via integration over the chi-square variable.
function logNctDensityRatio(t, df, ncp) {
  // Returns the density up to a constant that is the same for every ncp, which
  // is all a likelihood ratio needs. Substitution v = df * exp(w).
  const lc = (df / 2) * Math.log(df / 2) - lgamma(df / 2);
  const f = (w) => {
    const s = Math.exp(w / 2); // sqrt(v / df)
    const z = t * s - ncp;
    // chi2 density in w: (df/2)^(df/2)/Gamma(df/2) * exp(w*df/2 - df*e^w/2)
    return Math.exp(-0.5 * z * z + Math.log(s) + lc + (w * df) / 2 - (df * Math.exp(w)) / 2);
  };
  const spread = 12 / Math.sqrt(df) + 1;
  return Math.log(simpson(f, -spread * 1.5, spread, 1200));
}

/**
 * JZS BF by integrating the non-central t likelihood over a Cauchy prior on delta.
 * side: 'two' | 'positive' | 'negative'. Independent of jzsBf10's method, so the
 * two-sided results cross-check each other.
 */
export function jzsBfDirectional(t, n1, n2, r = 0.707, side = "two") {
  const neff = (n1 * n2) / (n1 + n2);
  const df = n1 + n2 - 2;
  const l0 = logNctDensityRatio(t, df, 0);
  // delta = r * tan(theta): a Cauchy(0, r) prior becomes uniform on theta.
  const f = (th) => Math.exp(logNctDensityRatio(t, df, r * Math.tan(th) * Math.sqrt(neff)) - l0);
  const e = 1e-9;
  if (side === "positive") return (2 / Math.PI) * simpson(f, 0, Math.PI / 2 - e, 400);
  if (side === "negative") return (2 / Math.PI) * simpson(f, -Math.PI / 2 + e, 0, 400);
  return (1 / Math.PI) * simpson(f, -Math.PI / 2 + e, Math.PI / 2 - e, 800);
}

/**
 * Independent-samples JZS test. `x` is the group predicted to be higher when
 * the hypothesis is directional.
 */
export function bfTTestIndependent(x, y, { r = 0.707, directional = false } = {}) {
  const tt = tTwoSample(x, y);
  if (!tt) return null;
  const bf10 = directional ? jzsBfDirectional(tt.t, tt.n1, tt.n2, r, "positive") : jzsBf10(tt.t, tt.n1, tt.n2, r);
  return { ...tt, bf10, r, directional, mean_x: mean(x), mean_y: mean(y) };
}
