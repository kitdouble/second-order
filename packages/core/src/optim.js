// Nelder-Mead minimiser. Small and dependency-free; used for meta-d' MLE.

export function nelderMead(f, x0, { maxIter = 2000, tol = 1e-8, step = 0.5 } = {}) {
  const n = x0.length;
  let simplex = [x0.slice()];
  for (let i = 0; i < n; i++) {
    const x = x0.slice();
    x[i] += x[i] !== 0 ? step * Math.abs(x[i]) + step * 0.1 : step;
    simplex.push(x);
  }
  let values = simplex.map(f);

  for (let iter = 0; iter < maxIter; iter++) {
    const order = values.map((v, i) => i).sort((a, b) => values[a] - values[b]);
    simplex = order.map((i) => simplex[i]);
    values = order.map((i) => values[i]);
    if (Math.abs(values[n] - values[0]) < tol * (Math.abs(values[0]) + tol)) break;

    const centroid = new Array(n).fill(0);
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) centroid[j] += simplex[i][j] / n;
    const worst = simplex[n];
    const point = (t) => centroid.map((c, j) => c + t * (worst[j] - c));

    const xr = point(-1);
    const fr = f(xr);
    if (fr < values[0]) {
      const xe = point(-2);
      const fe = f(xe);
      if (fe < fr) [simplex[n], values[n]] = [xe, fe];
      else [simplex[n], values[n]] = [xr, fr];
    } else if (fr < values[n - 1]) {
      [simplex[n], values[n]] = [xr, fr];
    } else {
      const outside = fr < values[n];
      const xc = point(outside ? -0.5 : 0.5);
      const fc = f(xc);
      if (fc < (outside ? fr : values[n])) {
        [simplex[n], values[n]] = [xc, fc];
      } else {
        for (let i = 1; i <= n; i++) {
          simplex[i] = simplex[i].map((v, j) => simplex[0][j] + 0.5 * (v - simplex[0][j]));
          values[i] = f(simplex[i]);
        }
      }
    }
  }
  let best = 0;
  for (let i = 1; i <= n; i++) if (values[i] < values[best]) best = i;
  return { x: simplex[best], fx: values[best] };
}
