// Full legality + points truth table for the §3.1 matrix — every terrain pair,
// dock variants, and both values of each rule flag.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TERRAINS, TERRAIN_NAMES, SOFT, isSoft, edgeRelation } from '../src/core/terrain.js';
import { cfg } from './helpers.js';
import { CONFIG } from '../src/core/config.js';

const SOFT_PTS = CONFIG.scoring.softMatch;
const HARD_PTS = CONFIG.scoring.hardMatch;

const ILLEGAL = { legal: false, points: 0, junction: null };

// Independent transcription of DESIGN §3.1/§3.2.
function expected(a, b, { aDock, bDock, mountainCoast, laneOceanRule }) {
  const soft = (t) => SOFT.has(t);
  if (soft(a) && soft(b)) return { legal: true, points: a === b ? SOFT_PTS : 0, junction: null };
  if (soft(a) || soft(b)) return ILLEGAL;
  if (a === b) return { legal: true, points: HARD_PTS, junction: null };
  const pair = [a, b].sort().join();
  if (pair === 'MT,RI') return { legal: true, points: HARD_PTS, junction: 'source' };
  if (pair === 'OC,RI') return { legal: true, points: HARD_PTS, junction: 'estuary' };
  if (pair === 'MT,OC') {
    return mountainCoast === 'cliff'
      ? { legal: true, points: 0, junction: 'cliff' }
      : ILLEGAL;
  }
  if (pair === 'LA,OC') {
    const dock = a === 'OC' ? aDock : bDock;
    if (dock) return { legal: true, points: HARD_PTS, junction: 'portCall' };
    return laneOceanRule === 'open'
      ? { legal: true, points: 0, junction: null }
      : ILLEGAL;
  }
  return ILLEGAL;
}

test('terrain enum: 9 types, names, soft set', () => {
  assert.equal(TERRAINS.length, 9);
  assert.deepEqual([...SOFT].sort(), ['FI', 'FO', 'GR', 'HO']);
  assert.equal(TERRAIN_NAMES.HO, 'House');
  assert.equal(TERRAIN_NAMES.LA, 'Lane');
  assert.ok(isSoft('GR') && !isSoft('OC'));
});

test('full matrix truth table — all pairs x dock combos x both config modes', () => {
  let checked = 0;
  for (const mountainCoast of ['repel', 'cliff']) {
    for (const laneOceanRule of ['open', 'sealed']) {
      const config = cfg({ mountainCoast, laneOceanRule });
      for (const a of TERRAINS) {
        for (const b of TERRAINS) {
          for (const aDock of a === 'OC' ? [false, true] : [false]) {
            for (const bDock of b === 'OC' ? [false, true] : [false]) {
              const got = edgeRelation(a, b, { aDock, bDock, config });
              const want = expected(a, b, { aDock, bDock, mountainCoast, laneOceanRule });
              const label = `${a}(${aDock})<->${b}(${bDock}) mc=${mountainCoast} lo=${laneOceanRule}`;
              assert.equal(got.legal, want.legal, `legal: ${label}`);
              assert.equal(got.points, want.points, `points: ${label}`);
              assert.equal(got.junction, want.junction, `junction: ${label}`);
              checked++;
            }
          }
        }
      }
    }
  }
  assert.equal(checked, 100 * 4); // 9x9 grid expanded by dock variants, 4 rule modes
});

test('matrix is symmetric (with docks swapped)', () => {
  const config = cfg({ mountainCoast: 'cliff', laneOceanRule: 'open' });
  for (const a of TERRAINS) {
    for (const b of TERRAINS) {
      for (const aDock of a === 'OC' ? [false, true] : [false]) {
        for (const bDock of b === 'OC' ? [false, true] : [false]) {
          const fwd = edgeRelation(a, b, { aDock, bDock, config });
          const rev = edgeRelation(b, a, { aDock: bDock, bDock: aDock, config });
          assert.deepEqual(fwd, rev, `${a}/${b}`);
        }
      }
    }
  }
});

test('hand-pinned anchor cells from DESIGN §3.1', () => {
  const eq = (got, want) => assert.deepEqual(got, want);
  eq(edgeRelation('GR', 'GR'), { legal: true, points: SOFT_PTS, junction: null });
  eq(edgeRelation('GR', 'FO'), { legal: true, points: 0, junction: null });
  eq(edgeRelation('GR', 'RI'), { legal: false, points: 0, junction: null });
  eq(edgeRelation('RI', 'RI'), { legal: true, points: HARD_PTS, junction: null });
  eq(edgeRelation('RI', 'MT'), { legal: true, points: HARD_PTS, junction: 'source' });
  eq(edgeRelation('RI', 'OC'), { legal: true, points: HARD_PTS, junction: 'estuary' });
  eq(edgeRelation('RI', 'RA'), { legal: false, points: 0, junction: null });
  eq(edgeRelation('RA', 'MT'), { legal: false, points: 0, junction: null });
  eq(edgeRelation('MT', 'OC'), { legal: false, points: 0, junction: null }); // repel default
  eq(edgeRelation('LA', 'OC'), { legal: true, points: 0, junction: null }); // open default
  eq(edgeRelation('LA', 'OC', { bDock: true }), { legal: true, points: HARD_PTS, junction: 'portCall' });
  eq(edgeRelation('OC', 'LA', { aDock: true }), { legal: true, points: HARD_PTS, junction: 'portCall' });
  eq(edgeRelation('LA', 'LA'), { legal: true, points: HARD_PTS, junction: null });
  eq(edgeRelation('LA', 'RI'), { legal: false, points: 0, junction: null });
  eq(edgeRelation('LA', 'MT'), { legal: false, points: 0, junction: null });
  eq(edgeRelation('HO', 'LA'), { legal: false, points: 0, junction: null });
});

test('cliff mode: Mt<->Oc legal, junction cliff, bonus comes from scoring', () => {
  const config = cfg({ mountainCoast: 'cliff' });
  assert.deepEqual(
    edgeRelation('MT', 'OC', { config }),
    { legal: true, points: 0, junction: 'cliff' },
  );
  assert.equal(config.scoring.junction.cliff, CONFIG.scoring.junction.cliff);
});

test('empty space is always legal, 0 points', () => {
  for (const a of TERRAINS) {
    assert.deepEqual(edgeRelation(a, null), { legal: true, points: 0, junction: null });
    assert.deepEqual(edgeRelation(a, undefined), { legal: true, points: 0, junction: null });
  }
});
