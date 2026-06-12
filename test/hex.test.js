import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DIRS, key, parseKey, neighbor, neighbors, opposite, distance, toWorld, SQRT3,
} from '../src/core/hex.js';

test('direction order matches the fixed convention', () => {
  assert.deepEqual(DIRS, [[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]]);
});

test('key/parseKey round-trip, including negatives', () => {
  for (const [q, r] of [[0, 0], [3, -2], [-7, 11], [-1, -1]]) {
    assert.equal(key(q, r), `${q},${r}`);
    assert.deepEqual(parseKey(key(q, r)), { q, r });
  }
});

test('opposite edge is (i+3)%6 and is an involution', () => {
  for (let i = 0; i < 6; i++) {
    assert.equal(opposite(i), (i + 3) % 6);
    assert.equal(opposite(opposite(i)), i);
  }
});

test('neighbor in dir i, then dir opposite(i), returns home', () => {
  for (let i = 0; i < 6; i++) {
    const n = neighbor(4, -2, i);
    assert.deepEqual(neighbor(n.q, n.r, opposite(i)), { q: 4, r: -2 });
  }
});

test('neighbors returns the 6 cells in dir order', () => {
  const ns = neighbors(0, 0);
  assert.equal(ns.length, 6);
  ns.forEach((n, i) => assert.deepEqual(n, { q: DIRS[i][0], r: DIRS[i][1] }));
});

test('all neighbors are at distance 1; self at 0', () => {
  assert.equal(distance(2, 3, 2, 3), 0);
  for (const n of neighbors(2, 3)) assert.equal(distance(2, 3, n.q, n.r), 1);
});

test('world position follows the GL1 mapping', () => {
  assert.deepEqual(toWorld(0, 0, 2), { x: 0, z: 0 });
  const w = toWorld(2, 1, 1);
  assert.ok(Math.abs(w.x - (SQRT3 * 2 + SQRT3 / 2)) < 1e-12);
  assert.equal(w.z, 1.5);
});
