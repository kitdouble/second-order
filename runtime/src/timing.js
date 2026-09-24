// Timing and attention measurements reported with each session.

export function createTimingMonitor() {
  const meta = { hidden_count: 0, blur_count: 0, refresh_hz: null, dropped_frame_prop: null };
  let late = 0;
  let shown = 0;
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") meta.hidden_count++;
  });
  window.addEventListener("blur", () => meta.blur_count++);

  /** Estimates the display refresh rate from 60 animation frames. */
  function measureRefresh() {
    return new Promise((resolve) => {
      const stamps = [];
      const tick = (t) => {
        stamps.push(t);
        if (stamps.length < 61) requestAnimationFrame(tick);
        else {
          const d = [];
          for (let i = 1; i < stamps.length; i++) d.push(stamps[i] - stamps[i - 1]);
          d.sort((a, b) => a - b);
          const med = d[Math.floor(d.length / 2)];
          meta.refresh_hz = med > 0 ? 1000 / med : null;
          resolve(meta.refresh_hz);
        }
      };
      requestAnimationFrame(tick);
    });
  }

  /** Records whether a stimulus stayed up for about as long as intended. */
  function recordStimulus(intendedMs, actualMs) {
    shown++;
    const frame = meta.refresh_hz ? 1000 / meta.refresh_hz : 16.7;
    if (Math.abs(actualMs - intendedMs) > 1.5 * frame) late++;
    meta.dropped_frame_prop = late / shown;
  }

  return {
    meta,
    measureRefresh,
    recordStimulus,
    snapshot() {
      return {
        ...meta,
        screen_w: window.screen?.width ?? null,
        screen_h: window.screen?.height ?? null,
        user_agent: navigator.userAgent,
      };
    },
  };
}
