// Pure maths for the Insights ring (js/donut-3d.js): slice angles, how high each slice is lifted,
// the dim/brighten colour maths and the spin physics. No DOM and no three.js, so Node can test it.
//
// Angles are radians. A slice at ring angle a sits at world angle a + r, where r is the ring's
// rotation, and world angle 0 is the front (nearest the viewer). The "front point" is the ring
// angle currently at the front: (−r) mod 2π.

export const TAU = Math.PI * 2;
const DEG = Math.PI / 180;

/** The chosen look (see the prototype's handoff note). */
export const RING = {
  minSlice: 14 * DEG,     // smallest drawn slice, so tiny categories stay visible and tappable
  lift: 1.5,              // peak raise, in ring thicknesses
  width: 25 * DEG,        // a slice whose centre is this far from the front point is not raised
  plateauMin: 90 * DEG,   // a slice at least this wide is "big"...
  plateauShare: 0.7,      // ...and holds full lift over this share of its arc,
  plateauOverrun: 0.4,    // then falls off to 0 this many widths past its own edges
  dim: 0.15,              // how far un-raised slices fade toward the card colour
};

/** The spin physics: drag, fling with friction, then a spring snap to a slice centre. */
export const MOTION = {
  friction: 2.6,          // 1/s: exponential decay of a fling
  flingToSnap: 2.2,       // rad/s: below this speed the snap spring takes over
  lead: 0.12,             // s: aim the snap where the ring would be this much later
  snapK: 90,              // spring stiffness
  snapDamping: 0.78,      // share of critical damping: just under, for a small settle
  maxSpeed: 28,           // rad/s: fastest fling
  sampleMs: 90,           // how much drag history measures the release speed
  staleMs: 60,            // a pause longer than this before release means no fling
  tapPx: 6,               // a press that moves less than this (|dx| + |dy|)...
  tapMs: 400,             // ...and is released within this is a tap
  maxDt: 1 / 30,          // longest physics step (s), so a stalled tab does not jump
};

export const wrapPi = (x) => ((((x + Math.PI) % TAU) + TAU) % TAU) - Math.PI;
const wrap2Pi = (x) => ((x % TAU) + TAU) % TAU;

/** 1 at d = 0, falling along half a cosine to 0 at d >= w. */
export const bell = (d, w) => (d >= w ? 0 : 0.5 + 0.5 * Math.cos((Math.PI * d) / w));

/**
 * Drawn angles for slices with these values, in order from angle 0. A slice under `min` is drawn at
 * `min`; the rest share what is left in proportion. Text elsewhere shows the true values.
 * Returns [{ a0, a1, span, mid }].
 */
export function sliceAngles(values, min = RING.minSlice) {
  const n = values.length;
  if (!n) return [];
  const total = values.reduce((t, v) => t + Math.max(0, v), 0);
  const share = values.map((v) => (total ? Math.max(0, v) / total : 1 / n));
  const floor = Math.min(min, TAU / n); // never more than an equal share
  let small = new Set(share.map((s, i) => (s * TAU < floor ? i : -1)).filter((i) => i >= 0));
  let span;
  for (;;) {
    const bigShare = share.reduce((t, s, i) => (small.has(i) ? t : t + s), 0);
    const left = TAU - small.size * floor;
    span = share.map((s, i) => (small.has(i) ? floor : bigShare ? (s / bigShare) * left : left / (n - small.size)));
    const more = span.map((s, i) => (!small.has(i) && s < floor ? i : -1)).filter((i) => i >= 0);
    if (!more.length) break;
    small = new Set([...small, ...more]);
  }
  let a = 0;
  return span.map((s) => {
    const out = { a0: a, a1: a + s, span: s, mid: a + s / 2 };
    a += s;
    return out;
  });
}

/** The index of the slice at the front for rotation r. */
export function frontIndex(angles, r) {
  const f = wrap2Pi(-r);
  const i = angles.findIndex((g) => f >= g.a0 && f < g.a1);
  return i < 0 ? 0 : i;
}

/** The rotation that puts slice i's centre at the front, taking the short way round from `from`. */
export const targetFor = (angles, i, from) => from + wrapPi(-angles[i].mid - from);

/**
 * How high each slice is raised (0–1) for rotation r. A pure function of r, so the lift animates as
 * the ring turns and needs no spring of its own.
 * - Small and mid slices: bell(distance from the slice centre to the front point, width).
 * - Big slices (span >= plateauMin): full lift while the front point is within the middle
 *   plateauShare of the arc, then a bell that ends plateauOverrun × width past the slice's edges,
 *   so something stays raised as a big slice passes the front.
 */
export function sliceWeights(angles, r, p = RING) {
  if (angles.length === 1) return [1];
  const f = wrap2Pi(-r);
  return angles.map((g) => {
    const dc = Math.abs(wrapPi(g.mid - f));
    if (g.span >= p.plateauMin) {
      const hold = (p.plateauShare * g.span) / 2;
      const fall = Math.max(p.width, g.span / 2 - hold) + p.plateauOverrun * p.width;
      return bell(Math.max(0, dc - hold), fall);
    }
    return bell(dc, p.width);
  });
}

/**
 * Slice colours for weight w, in linear RGB ([r, g, b], 0–1). Un-raised slices fade toward the card
 * colour (`surface`, so the effect suits the theme) and lose some saturation; raised ones glow.
 * `glow` is the theme's --ring-glow.
 */
export function sliceColour(base, surface, w, glow, dim = RING.dim) {
  const k = dim * (1 - w);
  const grey = 0.2126 * base[0] + 0.7152 * base[1] + 0.0722 * base[2];
  const t = Math.min(1, 1.5 * k);
  const colour = base.map((c, i) => {
    const desat = c + (grey - c) * t;
    return desat + (surface[i] - desat) * k;
  });
  const g = (glow + (dim > 0 ? 0.6 * dim : 0)) * w;
  return { colour, emissive: base.map((c) => c * g) };
}

/**
 * One physics step. `m` is { r, v, target, phase: 'idle' | 'drag' | 'fling' | 'snap' }; it is
 * updated in place. Returns true when the step brought the ring to rest (a snap finished).
 */
export function stepMotion(m, angles, dt) {
  dt = Math.min(MOTION.maxDt, Math.max(0, dt));
  if (m.phase === 'fling') {
    m.r += m.v * dt;
    m.v *= Math.exp(-MOTION.friction * dt);
    if (Math.abs(m.v) < MOTION.flingToSnap) {
      m.target = targetFor(angles, frontIndex(angles, m.r + m.v * MOTION.lead), m.r);
      m.phase = 'snap';
    }
  } else if (m.phase === 'snap') {
    const c = 2 * Math.sqrt(MOTION.snapK) * MOTION.snapDamping;
    m.v += (-MOTION.snapK * (m.r - m.target) - c * m.v) * dt;
    m.r += m.v * dt;
    if (Math.abs(m.r - m.target) < 0.0008 && Math.abs(m.v) < 0.004) {
      m.r = m.target;
      m.v = 0;
      m.phase = 'idle';
      return true;
    }
  }
  return false;
}

/** Release speed (rad/s) from drag samples [{ t, r }] (ms, radians), released at `now`. */
export function releaseVelocity(samples, now) {
  if (samples.length < 2) return 0;
  const a = samples[0];
  const b = samples[samples.length - 1];
  if (b.t - a.t <= 8 || now - b.t >= MOTION.staleMs) return 0;
  const v = (b.r - a.r) / ((b.t - a.t) / 1000);
  return Math.max(-MOTION.maxSpeed, Math.min(MOTION.maxSpeed, v));
}

/** What a release does: fling on, or snap to the slice the ring is heading for. Updates `m`. */
export function release(m, angles, v) {
  m.v = v;
  if (Math.abs(v) > MOTION.flingToSnap) m.phase = 'fling';
  else {
    m.phase = 'snap';
    m.target = targetFor(angles, frontIndex(angles, m.r + v * MOTION.lead), m.r);
  }
}

export const isTap = (dx, dy, ms) => Math.abs(dx) + Math.abs(dy) <= MOTION.tapPx && ms < MOTION.tapMs;
