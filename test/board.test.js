// Board validation (matrix-driven, incl. mountain repel & lane open rules),
// frontier, flood-fill groups, network tracing, hinterland.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createBoard, tileAt, canPlace, placeTile, frontier, validPlacements,
  groups, largestGroupSize, traceNetworks, riverNetworks, laneRoutes,
  railNetworks, hinterland,
} from '../src/core/board.js';
import { tt, put, cfg, ALL } from './helpers.js';

test('first tile may go anywhere; later tiles need a placed neighbor', () => {
  const b = createBoard();
  assert.ok(canPlace(b, tt(ALL('GR')), 5, -3).legal);
  placeTile(b, tt(ALL('GR')), 0, 0);
  assert.ok(!canPlace(b, tt(ALL('GR')), 5, -3).legal);
  assert.ok(canPlace(b, tt(ALL('GR')), 1, 0).legal);
});

test('occupied cells are illegal', () => {
  const b = createBoard();
  placeTile(b, tt(ALL('GR')), 0, 0);
  const v = canPlace(b, tt(ALL('GR')), 0, 0);
  assert.ok(!v.legal);
  assert.deepEqual(v.reasons, ['occupied']);
});

test('every candidate edge is checked against every placed neighbor', () => {
  const b = createBoard();
  placeTile(b, tt(ALL('GR')), 0, 0);
  put(b, ALL('OC'), 2, -1);
  // (1,0) touches both; a river tile pointing RI at the grass is illegal
  const candidate = tt(['RI', 'GR', 'GR', 'RI', 'GR', 'GR']); // edge 3 RI faces (0,0)
  const v = canPlace(b, candidate, 1, 0);
  assert.ok(!v.legal);
  assert.match(v.reasons.join(';'), /edge 3/);
});

test('placeTile throws on illegal placement', () => {
  const b = createBoard();
  placeTile(b, tt(ALL('GR')), 0, 0);
  assert.throws(() => placeTile(b, tt(ALL('OC')), 1, 0), /illegal/);
  assert.equal(tileAt(b, 1, 0), null);
});

test('mountain repel: Mt may not touch Oc by default; cliff mode allows it', () => {
  const b = createBoard();
  placeTile(b, tt(ALL('OC')), 0, 0);
  assert.ok(!canPlace(b, tt(ALL('MT')), 1, 0).legal);
  assert.ok(canPlace(b, tt(ALL('MT')), 1, 0, cfg({ mountainCoast: 'cliff' })).legal);
});

test('mountain never touches soft land', () => {
  const b = createBoard();
  placeTile(b, tt(ALL('GR')), 0, 0);
  assert.ok(!canPlace(b, tt(ALL('MT')), 1, 0).legal);
  // MT edge 2 would face the grass tile's edge 5 from (0,1)
  assert.ok(!canPlace(b, tt(['MT', 'MT', 'MT', 'GR', 'GR', 'GR']), 0, 1).legal);
});

test('lane rules: open allows La vs plain Oc, sealed forbids; dock legal in both', () => {
  const b = createBoard();
  placeTile(b, tt(ALL('OC')), 0, 0);
  const lane = tt(['LA', 'OC', 'OC', 'LA', 'OC', 'OC']); // edge 3 (LA) faces (0,0) from (1,0)
  assert.ok(canPlace(b, lane, 1, 0).legal, 'open default');
  assert.ok(!canPlace(b, lane, 1, 0, cfg({ laneOceanRule: 'sealed' })).legal, 'sealed');

  const b2 = createBoard();
  placeTile(b2, tt(['OC', 'OC', 'GR', 'HO', 'GR', 'GR'], { dockEdges: [0] }), 0, 0);
  assert.ok(canPlace(b2, lane, 1, 0, cfg({ laneOceanRule: 'sealed' })).legal, 'dock ok sealed');
});

test('validPlacements returns {q,r,rotation} on frontier; origin on empty board', () => {
  const b = createBoard();
  const grass = tt(ALL('GR'));
  const vEmpty = validPlacements(b, grass);
  assert.equal(vEmpty.length, 6); // origin only, all 6 rotations
  assert.ok(vEmpty.every((p) => p.q === 0 && p.r === 0));

  placeTile(b, tt(ALL('OC')), 0, 0);
  const all = validPlacements(b, grass);
  assert.equal(all.length, 0, 'grass cannot touch ocean anywhere');

  const coast = tt(['OC', 'OC', 'GR', 'GR', 'GR', 'GR']);
  const some = validPlacements(b, coast);
  assert.ok(some.length > 0);
  for (const p of some) {
    assert.ok([0, 1, 2, 3, 4, 5].includes(p.rotation));
    assert.ok(!(p.q === 0 && p.r === 0));
  }
});

test('frontier lists empty cells adjacent to placed tiles, no duplicates', () => {
  const b = createBoard();
  placeTile(b, tt(ALL('GR')), 0, 0);
  assert.equal(frontier(b).length, 6);
  placeTile(b, tt(ALL('GR')), 1, 0);
  assert.equal(frontier(b).length, 8);
});

test('groups: flood-fill through matched edges of one terrain', () => {
  const b = createBoard();
  // forest pair matched through edge 0/3, plus an unconnected forest singleton
  put(b, ['FO', 'GR', 'GR', 'GR', 'GR', 'GR'], 0, 0);
  put(b, ['GR', 'GR', 'GR', 'FO', 'GR', 'GR'], 1, 0);
  put(b, ALL('FO'), 5, 5);
  const fo = groups(b, 'FO');
  const sizes = fo.map((g) => g.size).sort();
  assert.deepEqual(sizes, [1, 2]);
  assert.equal(largestGroupSize(b, 'FO'), 2);
  // adjacency without matched forest edges does NOT join a group
  put(b, ['GR', 'GR', 'GR', 'FO', 'GR', 'GR'], 1, -1); // its FO edge faces (0,-1): empty
  assert.equal(groups(b, 'FO').length, 3);
});

test('river networks: ends, source, mouth, completion', () => {
  const b = createBoard();
  put(b, ['RI', 'GR', 'GR', 'RI', 'GR', 'GR'], 0, 0);
  let [net] = riverNetworks(b);
  assert.equal(net.size, 1);
  assert.equal(net.openEnds, 2);
  assert.equal(net.completed, false);

  put(b, ALL('MT'), 1, 0); // source at edge 0
  [net] = riverNetworks(b);
  assert.equal(net.sources, 1);
  assert.equal(net.completed, false);

  put(b, ALL('OC'), -1, 0); // mouth at edge 3
  [net] = riverNetworks(b);
  assert.deepEqual(
    { sources: net.sources, mouths: net.mouths, openEnds: net.openEnds, completed: net.completed },
    { sources: 1, mouths: 1, openEnds: 0, completed: true },
  );
});

test('river networks join through matched Ri edges', () => {
  const b = createBoard();
  put(b, ['RI', 'GR', 'GR', 'RI', 'GR', 'GR'], 0, 0);
  put(b, ['RI', 'GR', 'GR', 'RI', 'GR', 'GR'], 1, 0);
  const nets = riverNetworks(b);
  assert.equal(nets.length, 1);
  assert.equal(nets[0].size, 2);
});

test('rail networks include the Crane Harbor Ra edge', () => {
  const b = createBoard();
  put(b, ['OC', 'OC', 'GR', 'HO', 'RA', 'GR'], 0, 0, { dockEdges: [0], crane: true });
  put(b, ['GR', 'RA', 'GR', 'GR', 'RA', 'GR'], -1, 1); // edge 1 meets harbor edge 4
  put(b, ['GR', 'RA', 'GR', 'GR', 'GR', 'GR'], -2, 2);
  const nets = railNetworks(b);
  assert.equal(nets.length, 1);
  assert.equal(nets[0].size, 3);
  assert.ok(nets[0].keys.has('0,0'));
});

test('lane routes: dock detection and completion at both ends', () => {
  const b = createBoard();
  put(b, ['OC', 'OC', 'GR', 'HO', 'GR', 'GR'], 0, 0, { dockEdges: [0] });
  put(b, ['LA', 'OC', 'OC', 'LA', 'OC', 'OC'], 1, 0); // LA edges 0 and 3
  let [route] = laneRoutes(b);
  assert.equal(route.dockEnds, 1);
  assert.equal(route.openEnds, 1);
  assert.equal(route.completed, false);

  put(b, ['HO', 'GR', 'GR', 'OC', 'OC', 'GR'], 2, 0, { dockEdges: [3] });
  [route] = laneRoutes(b);
  assert.equal(route.dockEnds, 2);
  assert.deepEqual([...route.dockHarborKeys].sort(), ['0,0', '2,0']);
  assert.equal(route.completed, true);
});

test('a lane end in open water blocks completion', () => {
  const b = createBoard();
  put(b, ['OC', 'OC', 'GR', 'HO', 'GR', 'GR'], 0, 0, { dockEdges: [0] });
  put(b, ['LA', 'OC', 'OC', 'LA', 'OC', 'OC'], 1, 0);
  put(b, ALL('OC'), 2, 0); // plain ocean facing the second LA end
  const [route] = laneRoutes(b);
  assert.equal(route.openWaterEnds, 1);
  assert.equal(route.completed, false);
});

test('traceNetworks() without terrain returns all three families', () => {
  const b = createBoard();
  put(b, ['RI', 'GR', 'GR', 'RI', 'GR', 'GR'], 0, 0);
  const all = traceNetworks(b);
  assert.ok('RI' in all && 'RA' in all && 'LA' in all);
  assert.equal(all.RI.length, 1);
  assert.equal(all.RA.length, 0);
});

test('hinterland: house group behind the harbor; 0 when unmatched', () => {
  const b = createBoard();
  put(b, ['OC', 'OC', 'GR', 'HO', 'GR', 'GR'], 0, 0, { dockEdges: [0] });
  assert.equal(hinterland(b, '0,0'), 0, 'unmatched House edge');
  put(b, ['HO', 'HO', 'GR', 'GR', 'GR', 'GR'], -1, 0); // edge 0 meets harbor edge 3
  assert.equal(hinterland(b, '0,0'), 2, 'harbor + 1 house tile');
  put(b, ['GR', 'GR', 'GR', 'GR', 'HO', 'GR'], 0, -1); // joins via (-1,0) edge 1
  assert.equal(hinterland(b, '0,0'), 3);
});
