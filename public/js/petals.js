// Falling sakura petals — canvas layer, GPU-friendly (single rAF loop,
// transforms only), low density, disabled under prefers-reduced-motion.

const PETAL_COUNT = 18;
const COLORS = [
  [255, 158, 196],
  [255, 183, 213],
  [255, 205, 226],
  [232, 93, 150],
];

function makePetal(w, h, initial) {
  const [r, g, b] = COLORS[(Math.random() * COLORS.length) | 0];
  return {
    x: Math.random() * w,
    y: initial ? Math.random() * h : -30,
    size: 5 + Math.random() * 7,          // petal length
    speedY: 0.35 + Math.random() * 0.75,  // slow fall
    drift: 0.4 + Math.random() * 0.9,     // horizontal sway amplitude
    sway: Math.random() * Math.PI * 2,    // sway phase
    swaySpeed: 0.004 + Math.random() * 0.008,
    rot: Math.random() * Math.PI * 2,
    rotSpeed: (Math.random() - 0.5) * 0.02,
    alpha: 0.35 + Math.random() * 0.4,
    color: `rgba(${r},${g},${b},`,
  };
}

function drawPetal(ctx, p) {
  ctx.save();
  ctx.translate(p.x, p.y);
  ctx.rotate(p.rot + Math.sin(p.sway) * 0.35);
  const s = p.size;
  ctx.beginPath();
  ctx.moveTo(0, -s);
  ctx.bezierCurveTo(s * 0.9, -s * 0.55, s * 0.75, s * 0.45, 0, s);
  ctx.bezierCurveTo(-s * 0.75, s * 0.45, -s * 0.9, -s * 0.55, 0, -s);
  ctx.closePath();
  ctx.fillStyle = p.color + p.alpha + ")";
  ctx.fill();
  // subtle deeper blush toward the base
  ctx.beginPath();
  ctx.ellipse(0, s * 0.25, s * 0.22, s * 0.4, 0, 0, Math.PI * 2);
  ctx.fillStyle = p.color + (p.alpha * 0.5) + ")";
  ctx.fill();
  ctx.restore();
}

export function initPetals() {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  if (document.getElementById("petal-canvas")) return;

  const canvas = document.createElement("canvas");
  canvas.id = "petal-canvas";
  canvas.setAttribute("aria-hidden", "true");
  // Critical layout/interaction styles are set here in JS so the layer never
  // intercepts pointer events or distorts the layout on pages that don't link
  // styles.css (e.g. the login page, which has its own inline stylesheet).
  Object.assign(canvas.style, {
    position: "fixed",
    inset: "0",
    zIndex: "3",
    pointerEvents: "none",
  });
  document.body.appendChild(canvas);
  const ctx = canvas.getContext("2d");

  let w = 0;
  let h = 0;
  let petals = [];

  function resize() {
    w = canvas.width = window.innerWidth;
    h = canvas.height = window.innerHeight;
    // keep density roughly constant across sizes
    const target = Math.min(PETAL_COUNT, Math.max(10, Math.round((w * h) / 60000)));
    while (petals.length < target) petals.push(makePetal(w, h, true));
    petals.length = target;
  }
  resize();
  window.addEventListener("resize", resize);

  function frame() {
    ctx.clearRect(0, 0, w, h);
    for (const p of petals) {
      p.y += p.speedY;
      p.sway += p.swaySpeed;
      p.x += Math.sin(p.sway) * p.drift * 0.6;
      p.rot += p.rotSpeed;
      if (p.y > h + 40 || p.x < -60 || p.x > w + 60) {
        Object.assign(p, makePetal(w, h, false));
      }
      drawPetal(ctx, p);
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}