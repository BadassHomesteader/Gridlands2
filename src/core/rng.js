// Seeded RNG — all core randomness flows through an injected mulberry32 instance.

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function pick(rng, arr) {
  return arr[Math.floor(rng() * arr.length)];
}

// Fisher-Yates, in place; returns the array.
export function shuffle(rng, arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// weighted(rng, [[item, weight], ...]) — weights need not be normalized.
export function weighted(rng, pairs) {
  let total = 0;
  for (const [, w] of pairs) if (w > 0) total += w;
  if (total <= 0) return undefined;
  let roll = rng() * total;
  for (const [item, w] of pairs) {
    if (w <= 0) continue;
    roll -= w;
    if (roll < 0) return item;
  }
  return pairs[pairs.length - 1][0];
}
