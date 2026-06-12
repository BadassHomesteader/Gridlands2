# Gridlands 2 — Engineering Spec

Sequel to GridLands (`/Users/juergs/Code/GridLands/index.html`). Cozy Dorfromantik-style
hex tile-laying game with three new terrain systems: **mountains, oceans, shipping lanes**.
Game mechanics are defined in `DESIGN.md` — that document is the authority on rules,
numbers, and scoring. This document is the authority on architecture and code contracts.

## Architecture

**Hard rule: `src/core/` is pure JS — no DOM, no three.js, no `window`, no timers.**
Core modules must run unmodified in Node 25 (`node --test`) and in the browser as ES
modules. All randomness in core goes through an injected RNG (mulberry32 with a seed)
so simulations are reproducible.

```
Gridlands2/
  index.html              — shell: canvas, HUD overlay, start screen (ES module entry: src/main.js)
  src/
    core/
      rng.js              — mulberry32(seed) -> () => float; helpers: pick, shuffle, weighted
      hex.js              — axial coords; key "q,r"; neighbors; edge i faces neighbor i; opposite = (i+3)%6
      terrain.js          — terrain enum, edge-compatibility matrix, terrain metadata (from DESIGN.md)
      tiles.js            — tile catalog + draw weights (from DESIGN.md), tile = { edges: [6], ...features }
      board.js            — placed-tile Map, placement validation (hard constraints), group/flood-fill,
                            network tracing (rivers, rails, lanes), open-edge queries
      scoring.js          — placement scoring, perfect placement detection, combos, end bonuses
      quests.js           — quest generation, progress tracking, completion (from DESIGN.md)
      game.js             — Game class orchestrating the above: state, draw stack, place(), undo(),
                            serialize()/deserialize() for snapshots
    render/
      scene.js            — three.js scene, camera, lights, picking, pan/zoom
      tilemesh.js         — builds a THREE.Group per tile from tile data (terrain props, seeded variation)
      effects.js          — placement animations, score popups, vehicles (trains/boats/ships), particles
    ui.js                 — HUD: score, stack count, quest panel, next-tile preview, toasts, game over
    audio.js              — procedural WebAudio (carry forward GridLands patterns; no audio files)
    main.js               — boot, input wiring, game loop, exposes window.GL2 test hooks
  sim/
    autoplay.mjs          — headless AI player: policies (greedy / quest-aware / random) over core API
    balance.mjs           — run N seeded games per policy, print metrics table + JSON to sim/results/
  test/
    *.test.js             — node:test suites for every core module
  tools/
    serve.mjs             — static dev server (exists; port 8714)
    screenshot.mjs        — playwright screenshot harness (exists; uses window.GL2 hooks)
```

three.js loads from CDN via import map (use `three@0.160.0` modules build). No bundler,
no npm runtime deps (playwright is invoked via `npx`, already installed globally).

## Core API contract

```js
// game.js
const game = new Game({ seed: 12345, tileCount: <from DESIGN.md>, zen: false });
game.currentTile            // tile in hand: { edges: [t0..t5], id, ...features }
game.nextTiles(n)           // peek upcoming n tiles (for HUD preview)
game.rotate(dir = 1)        // rotate tile in hand
game.legalPlacements()      // -> [{ q, r, rotations: [r0..] }] all legal spots for tile in hand
game.canPlace(q, r)         // -> { legal, reasons: [] } for current rotation
game.place(q, r)            // -> PlacementResult or null if illegal
game.undo()                 // single-level undo, restores full state
game.over                   // boolean; game.score; game.stats (for end screen + sim metrics)
game.serialize() / Game.deserialize(json)

// PlacementResult — everything the renderer/UI needs to animate the consequences:
// { tile, q, r, edgeMatches: [{ dir, matched, terrain }], points, breakdown: {...},
//   perfect, combo, questsCompleted: [...], questsProgressed: [...], tilesAwarded,
//   groupsExtended: [{ terrain, size }], networkEvents: [e.g. river reached ocean,
//   lane connected two harbors — DESIGN.md names these] }
```

`board.js` exposes pure helpers the sim can use directly: `validPlacements(board, tile)`,
`scorePlacement(board, tile, q, r)` (dry-run), `groups(board)`, `traceNetworks(board)`.

## Test hooks (required, used by tools/screenshot.mjs and verify steps)

`window.GL2 = { game, testStart(seed?), testAutoplay(n) /* greedy-places n tiles with small delays */,
testPlace(q,r,rot), version }` — set in main.js. `testStart` must skip the start screen.

## Definition of done (every build phase ends green)

1. `npm test` — all core suites pass.
2. `npm run sim` — completes 200 games/policy without throwing; prints metrics.
3. `npm run shot` — exits 0 (no console errors) and produces menu/start/midgame PNGs
   where the midgame shot visibly shows ≥10 placed tiles with distinct terrains.

## Simulation metrics (balance.mjs must report per policy)

- score: mean / p10 / p90;  tiles placed: mean;  session length proxy (tiles placed)
- quest completion rate; perfect placement rate; % games ending with >0 legal moves remaining
- terrain group sizes (mean largest per terrain); count of "stuck" states (tile in hand, no legal placement)
- new-terrain engagement: % games where a lane connects harbors, river reaches ocean, mountain bonus triggers

## Visual bar

Carry forward GridLands' look (warm light, soft shadows, procedural props: trees,
houses, fields) and add: snowcapped peaks on mountains, animated water with waves on
ocean, dashed/buoyed shipping lanes with sailing ships, beaches where ocean meets land.
Pastel-cozy palette, score popups, smooth tile-drop animation with a little bounce.
