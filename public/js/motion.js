
export function reduceMotion() {
  if (document.documentElement.classList.contains("calm")) return true;
  return Boolean(window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches);
}

export function spring(el, keyframes, opts = {}) {
  if (!el || reduceMotion() || typeof el.animate !== "function") return null;
  return el.animate(keyframes, {
    duration: 520,
    easing: "cubic-bezier(0.16, 1, 0.3, 1)",
    fill: "both",
    ...opts,
  });
}

export function stagger(nodes, keyframes, opts = {}) {
  const list = [...nodes];
  const step = opts.step ?? 55;
  return list.map((el, i) => spring(el, keyframes, { ...opts, delay: (opts.delay || 0) + i * step }));
}

export function withViewTransition(fn) {
  if (reduceMotion() || typeof document.startViewTransition !== "function") {
    fn();
    return;
  }
  document.startViewTransition(fn);
}
