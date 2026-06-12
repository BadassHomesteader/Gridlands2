# Gridlands 2 — Tideline

Build your world by connecting tiles — now with mountains to crown, oceans that
reshape your map, and shipping lanes to thread between harbors.

The sequel to [GridLands](https://github.com/BadassHomesteader/GridLands): a cozy
Dorfromantik-style 3D hex tile-laying game. No build step, no assets — three.js from a
CDN, procedural audio, everything else vanilla ES modules.

**Play:** open `index.html` via any static server (`npm run serve` → http://localhost:8714).

## What's new in 2

- **Mountains** — hard walls that only meet rock, rivers (a river **source**), or open
  space. Ring a 4-peak tile on all six sides to **crown the Peak**.
- **Oceans** — ocean edges only accept ocean, so every ocean tile permanently turns map
  into sea. Coast tiles are the scarce currency that freezes a coastline. Rivers can now
  end in an **estuary**.
- **Shipping lanes** — buoy-marked channels through the ocean that only pay at harbor
  **docks**. Route value scales with the size of the towns behind each harbor; crane
  harbors link rail networks to the sea for **Trade Routes**.
- **A session arc** — runs build from pastoral farmland through the highlands until
  *The Tide Comes In*, ending in a sunset finale flight along everything you built.
- **Hard-edge placement** — illegal placements are shown, not punished: the ghost tile
  colors every edge green (scores), grey (legal), or red (illegal) before you commit.
- **Quest flags, epics, and rerolls** — flagged tiles ask you to grow *that* group; one
  run-defining Epic quest is dealt at the start; unplaceable draws reroll free
  ("the winds shift") — bad RNG is never your problem.

## How to play

| Input | Action |
| --- | --- |
| Click | Place tile |
| R | Rotate tile |
| Arrows / Right-drag | Pan |
| Scroll | Zoom |
| Ctrl+Z | Undo last placement |
| D | Discard tile (−25) |
| M | Mute |

Match edges to score; rivers, rails, mountains, ocean, and lanes must match their own
kind. Cap a river with a source *and* an estuary to complete it. Connect two harbors by
lane to open a route. Complete quests to earn tiles; the run ends when the stack is out.

## Development

```
npm run serve   # dev server :8714
npm test        # core unit tests (node:test)
npm run sim     # 200-game-per-policy balance simulation vs DESIGN.md §10 gates
npm run shot    # playwright screenshot smoke test
```

- `src/core/` — pure headless game engine (no DOM/three.js; seeded RNG). All tunable
  numbers live in `src/core/config.js`.
- `src/render/` — three.js scene, tile meshes, effects. `src/ui.js`, `src/audio.js`,
  `src/main.js` — HUD, procedural audio, input.
- `sim/` — AI players (greedy / quest-aware / land-only / random) and the balance
  harness; tuning history in `sim/TUNING.md`.
- `DESIGN.md` — full game design (rules authority). `SPEC.md` — architecture contract.
