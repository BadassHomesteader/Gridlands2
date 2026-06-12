// Axial hex helpers (pointy-top). Fixed conventions from SPEC.md:
// edge i faces neighbor i; the facing edge on the neighbor is (i+3)%6.

export const DIRS = [[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]];

export function key(q, r) {
  return q + ',' + r;
}

export function parseKey(k) {
  const i = k.indexOf(',');
  return { q: Number(k.slice(0, i)), r: Number(k.slice(i + 1)) };
}

export function neighbor(q, r, dir) {
  const d = DIRS[dir];
  return { q: q + d[0], r: r + d[1] };
}

export function neighbors(q, r) {
  return DIRS.map((d) => ({ q: q + d[0], r: r + d[1] }));
}

export function opposite(dir) {
  return (dir + 3) % 6;
}

export function distance(q1, r1, q2, r2) {
  const dq = q1 - q2;
  const dr = r1 - r2;
  return (Math.abs(dq) + Math.abs(dr) + Math.abs(dq + dr)) / 2;
}

export const SQRT3 = Math.sqrt(3);

// World position (same mapping as GL1): x = size*(√3*q + √3/2*r), z = size*(3/2*r).
export function toWorld(q, r, size = 1) {
  return { x: size * (SQRT3 * q + (SQRT3 / 2) * r), z: size * 1.5 * r };
}
