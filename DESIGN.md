# Gridlands 2 — Tideline — Final Design Document

Sequel to GridLands (`/Users/juergs/Code/GridLands/index.html`). This document is the
authority on rules, numbers, and scoring (see `SPEC.md` for architecture). Every number
marked **(TUNE)** is a baseline for the headless simulation harness (`sim/balance.mjs`)
— change them in `CONFIG`, not in code.

Base design: the "depth" proposal (winner, both judges), with grafts from "economy"
(hinterland-priced trade routes, harbor pity timer, act-keyed weights, sim gates, quest
rerolls, themed rewards, cliffs, escalating perfects) and "feel" (flagged tile quests,
act announcements, winds-shift reroll, trade income, snowcaps, the five flagship
celebrations, sunset finale). All judge concerns are resolved inline; §12 maps each
concern to its resolution.

---

## 1. Overview & Design Pillars

GridLands 1 is a soft-edged scoring sandbox: mismatches cost nothing, so placement is
never forbidden, only suboptimal. Gridlands 2's thesis: **fun comes from hard
constraints that interact spatially.** Three new terrains each deform the board in a
different geometric way:

- **Mountains** cluster and seal (hard walls; Peaks invert perfect-placement).
- **Oceans** expand and consume frontier (the one terrain that spends your map).
- **Shipping lanes** thread through an already-constrained medium (investments priced
  by land decisions).

Pillars (tiebreakers for any future dispute):

1. **Readable legality.** Every rule must be guessable from tile art (blue meets blue,
   rock meets rock, dashes meet docks). The ghost tile teaches the whole matrix.
2. **Cozy mandate.** A no-legal-placement draw is dealer error, never player error — it
   is always resolved for free (§7.4). The game never punishes RNG.
3. **No new vocabulary.** Hard cap: 9 edge types, ever. Depth comes from interactions.
4. **Act 1 is literally GridLands 1.** New systems arrive in announced waves (§7.3).

---

## 2. Definitions (used by `board.js` / `scoring.js`)

- **Edge** — one of 6 hex sides; edge `i` faces neighbor `i`; the facing edge on the
  neighbor is `(i+3)%6`.
- **Match** — two facing edges that score against each other per the matrix in §3.
- **Group** — maximal flood-fill of tiles sharing a terrain feature through matched
  edges of that terrain (forest group, ocean group, mountain group, house group).
- **Network** — connected path-terrain trace: river network, rail network, lane route.
- **River end** — a river edge facing empty space, a Mountain edge (= **source**), or
  an Ocean edge (= **mouth/estuary**).
- **Completed river** — a single river network with ≥1 source at one end and ≥1 mouth
  at the other (each network pays at most one source bonus and one mouth bonus; extra
  junctions on the same network pay edge points only).
- **Dock** — a marked Ocean edge on a Harbor tile (edge *modifier*, not a 10th type).
- **Lane route** — maximal lane path; **completed** when both ends terminate at docks.
- **Hinterland(harbor)** — size of the House group connected to that Harbor tile's
  House edge (0 if that edge is unmatched).
- **Frontier** — empty cells adjacent to ≥1 placed tile.
- **Clean placement** — the placed tile has ≥2 placed neighbors AND every edge facing a
  placed neighbor matches (like-soft match, hard match, or scored junction). A
  placement with any mismatched soft edge facing a neighbor is **dirty**. A placement
  with <2 neighbors and no mismatch is **neutral** (neither clean nor dirty).
- **Peak candidate** — a tile with ≥4 printed Mountain edges (only the High Mountain
  archetype qualifies).

---

## 3. Terrain Types & Edge Matching Matrix

**9 edge types.** Soft edges may face anything land-soft (mismatch legal, 0 pts). Hard
edges must face a legal partner or empty space — otherwise the placement is illegal and
the ghost tile shows red on the offending edge with a soft denied-thunk.

Abbreviations: Gr Grass, Fo Forest, Fi Field, Ho House (GL1 "Village"), Ri River,
Ra Rail, Mt Mountain, Oc Ocean, La Lane.

### 3.1 Legality + scoring matrix

Cell = legality / points when the edge pair is created. `—` = illegal placement.
Matrix is symmetric. "soft" = Gr/Fo/Fi/Ho.

| ↔ | Gr | Fo | Fi | Ho | Ri | Ra | Mt | Oc | La | empty |
|---|----|----|----|----|----|----|----|----|----|-------|
| **Gr** | 10 | 0 | 0 | 0 | — | — | — | — | — | ok |
| **Fo** |  | 10 | 0 | 0 | — | — | — | — | — | ok |
| **Fi** |  |  | 10 | 0 | — | — | — | — | — | ok |
| **Ho** |  |  |  | 10 | — | — | — | — | — | ok |
| **Ri** |  |  |  |  | 15 | — | 15 + 30 **source** | 15 + 40 **estuary** | — | ok |
| **Ra** |  |  |  |  |  | 15 | — | — | — | ok |
| **Mt** |  |  |  |  |  |  | 15 | see §3.2 | — | ok |
| **Oc** |  |  |  |  |  |  |  | 15 | 0 (15 + 25 **port call** if dock) | ok |
| **La** |  |  |  |  |  |  |  |  | 15 | ok |

All point values (TUNE). Junction bonuses (source +30, estuary +40, port call +25) are
one-time, paid when the edge pair is created, and each river network pays at most one
source and one estuary bonus (extras: edge points only). Each lane route pays one port
call per dock end.

### 3.2 Rule decisions, spelled out (resolves judge concerns)

- **Rivers flow into oceans.** Ri↔Oc is the legal, rewarded **estuary**; Ri↔Mt is the
  **source**. A river capped at both ends is *completed* (§5.4). Rivers are a fuse you
  choose when to light.
- **Mountain ↔ Ocean** — `CONFIG.mountainCoast` (default `'repel'`):
  - `'repel'` (default): illegal. The two expanding masses may never touch; land
    corridors between range and sea become contested real estate.
  - `'cliff'` (designed fallback, fully shipped & tested): legal, scores **10 (TUNE)**,
    named junction `cliff`, rendered as a rock face dropping into surf. Mountains
    become coastal armor. The fallback is a feature, not a dead switch — `balance.mjs`
    runs both modes; `'repel'` ships only if it passes the mountain-heavy-seed strand
    gate in §10, otherwise `'cliff'` becomes the default.
  - Taught once via red-edge highlight + one-line tooltip: *"the range needs land
    before the sea"* (repel mode).
- **Mountain ↔ soft land: illegal.** Mountains are walls; the only legal mountain
  partners are Mountain, River (source), and empty. This is the corridor-pressure
  engine; its strand risk is mitigated by the winds-shift valve (§7.4) and gated by a
  mountain-heavy-seed sim metric (§10).
- **Lane ↔ plain Ocean** — `CONFIG.laneOceanRule` (default `'open'`):
  - `'open'` (default): **legal, 0 points** (semi-hard, per "economy"). Lanes are an
    investment, not a legality puzzle: legal to waste, costly to waste. An open lane
    end never bricks ocean growth around it.
  - `'sealed'` (strict, flag only): illegal — routes may not dead-end in open water.
    Adopted as default only if sim shows strand rate <1% AND lane engagement within
    10% of `'open'` (§10).
- **Lanes need harbors to PAY, not to exist.** Lane edges pay +15 only against Lane or
  dock; route completion bonus (§5.4) requires both ends at docks. Lane ↔ River,
  Lane ↔ land-soft, Lane ↔ Mountain: illegal always.
- **Ocean ↔ soft land: illegal.** Coast tiles are the only land/sea interface.
  Coastline is permanent map surgery.
- **Rail** meets only Rail (including the Rail edge on Crane Harbor tiles). No rail on
  water, no rail into mountains.

### 3.3 Ghost-tile teaching loop

Before commit, every edge of the ghost tile is colored: **green** (will match/score),
**grey** (legal, 0 pts — soft mismatch, lane-on-ocean, empty), **red** (illegal).
Illegal commit attempt: red flash on the offending edge + denied-thunk (reuse GL1
`thunk()` detuned). First occurrence of each junction type (source, estuary, port call,
cliff) shows a one-line tooltip. No manual needed; no new inputs.

---

## 4. Tile Catalog & Draw Weights

**12 archetypes** (+1 flag modifier), well under the 20 cap. Edges listed clockwise
from edge 0; generator randomizes rotation. Sub-splits are explicit so hard networks
stay geometrically buildable (resolves the rail bend/straight concern).

| # | Archetype | Edge layout | Hard edges | Notes |
|---|-----------|-------------|-----------|-------|
| 1 | Meadow Blend | 2–3 of {Gr,Fo,Fi} in contiguous runs; splits 3-3 / 4-2 / 2-2-2 at 40/35/25% (TUNE) | — | always placeable on land frontier; flag-eligible |
| 2 | Hamlet | 2–3 Ho contiguous + Gr/Fi filler; splits 2Ho/3Ho at 65/35% (TUNE) | — | flag-eligible |
| 3 | Pure Soft | 6× one of Fo/Fi/Ho (equal thirds) | — | flag-eligible |
| 4 | River | 2 Ri; **straight (opposite) 40% / wide bend (skip-one) 35% / tight bend (adjacent) 25%** (TUNE); rest soft | 2 | |
| 5 | Rail | 2 Ra; **straight 40% / wide 35% / tight 25%** (TUNE); rest soft | 2 | |
| 6 | Foothills | 2 Mt (adjacent 60% / skip-one 40%, TUNE); rest soft | 2 | river-source partner |
| 7 | High Mountain | Mt,Mt,Mt,Mt,Gr,Gr (4 Mt contiguous) | 4 | the only Peak candidate |
| 8 | Coast | 2 Oc (60%) or 3 Oc (40%) contiguous; rest soft | 2–3 | the coastline currency |
| 9 | Estuary | Ri at edge 3 or 4 (50/50); Oc at edges 0,1; rest soft (on-tile delta art) | 3 | teaches the mouth |
| 10 | Open Ocean | Oc ×6 | 6 | |
| 11 | Harbor | Oc(dock),Oc,Gr,Ho,Gr,Gr — **1 in 3 is a Crane Harbor**: Oc(dock),Oc,Gr,Ho,Ra,Gr | 2 (+1 Ra) | Crane = only land/sea network bridge |
| 12 | Lane | La,Oc,Oc,La,Oc,Oc straight 60% / La,Oc,La,Oc,Oc,Oc wide bend 40% (TUNE) | 6 | buoy-marked channel |

**Flag modifier:** 20% (TUNE) of placed-from-stack Meadow Blend / Hamlet / Pure Soft
tiles carry a quest flag (§6.3). Max 3 flagged groups active on board.

### 4.1 Stage weight tables (% of draws; each column sums to 100)

Stages are keyed to **total placements** (not deck position) so earned tiles respect
gating. All weights (TUNE).

| Archetype | Pastoral (pl. 1–12) | Highlands (13–24) | Tide (25–45) | Voyage (46+) |
|---|---|---|---|---|
| Meadow Blend | 36 | 30 | 24 | 22 |
| Hamlet | 14 | 12 | 9 | 8 |
| Pure Soft | 8 | 6 | 5 | 4 |
| River | 24 | 18 | 13 | 12 |
| Rail | 18 | 14 | 10 | 10 |
| Foothills | — | 15 | 10 | 10 |
| High Mountain | — | 5 | 4 | 4 |
| Coast | — | — | 12 | 12 |
| Estuary | — | — | 3 | 4 |
| Open Ocean | — | — | 3 | 4 |
| Harbor | — | — | 4 | 5 |
| Lane | — | — | 3 | 5 |

Stage boundaries (12 / 24 / 45) are (TUNE).

### 4.2 Dynamic weight engine — strict order of operations

Applied every draw, in this order (resolves the cap-interaction concern):

1. **Stage table** for current total-placement count.
2. **Lane tide gate**: Lane weight stays 0 until BOTH (a) largest ocean group ≥ 3
   tiles (TUNE) AND (b) ≥ 2 frontier cells (TUNE) admit a Lane tile in some rotation.
   Re-checked every draw; while closed, Lane weight redistributes 2/3 to Coast, 1/3 to
   Open Ocean (stays inside the ocean family, so family share is unchanged).
3. **Harbor pity timer**: if any lane route has ≥3 lane tiles and ≤1 connected harbor,
   Harbor weight ×3 for the next 10 draws (TUNE); refreshes while the condition holds.
4. **Mountain pity**: while an un-crowned Peak candidate is on the board, Foothills
   weight +4 percentage points (TUNE) (taken proportionally from soft archetypes).
4½. **Island pity** (AMENDED, tuning round 2): while The Island epic is active and
   incomplete, Coast weight +6 percentage points (TUNE), taken proportionally from
   soft archetypes (mirror of mountain pity — the ring's only currency is the 3-Oc
   coast). The family cap below still applies, so inside a capped family the bonus
   re-weights Coast against the other ocean archetypes.
5. **Finale**: during the last 15 tiles of the stack (including earned tiles), Harbor
   and Lane weights ×2 (TUNE).
6. **Ocean-family cap** (Coast+Estuary+Open Ocean+Harbor+Lane): enforced LAST, after
   all modifiers, by scaling the family down proportionally and renormalizing the
   table to 100. Cap = **25%** in Tide, **30%** in Voyage, **35%** during Finale (TUNE).
7. **Themed quest rewards** (§6.4) bypass this table 60% of the time.

---

## 5. Scoring

All constants live in `CONFIG.scoring` (every one TUNE). Target median run ≈ **2,800**
with distribution: edge matches 45% / streaks+perfects 15% / quests 25% /
structure+junction events 10% / end-game 5% (TUNE — this is `balance.mjs`'s primary
fitness target).

### 5.1 Per-edge (on placement)

- Soft like-match: **+10**. Soft mismatch: legal, 0.
- Hard match (Ri↔Ri, Ra↔Ra, Mt↔Mt, Oc↔Oc, La↔La, La↔dock): **+15**.
- Junction bonuses (one-time per edge pair): **source +30**, **estuary +40**,
  **port call +25**, **cliff +10** (cliff mode only).

### 5.2 Clean streak

Crisp predicate (replaces the undefined "no junction wasted" clause): a **clean**
placement (§2) extends the streak; a **dirty** placement resets it to 0; a **neutral**
placement leaves it unchanged. Streak pays **+5 × streak length, cap +50** (streak 10)
(TUNE). This is the moment-to-moment crescendo engine.

### 5.3 Perfect placement

6 placed neighbors, all 6 edges matched (junctions count as matched):
**+50, escalating +75, +100 for consecutive perfects (cap 100)** (TUNE), and **+1 bonus
tile** each (legacy).

### 5.4 Structure completions (one-time; named `networkEvents` for PlacementResult)

| Event name | Trigger | Points | Tiles |
|---|---|---|---|
| `riverCompleted` | river network gains both a source and a mouth | **+12 × river length (tiles)** | +2 |
| `laneCompleted` | lane route's both ends terminate at docks | **+20 × lane length + 5 × (hinterlandA + hinterlandB)** | +2 |
| `peakCrowned` | see §5.5 | **+60** | +1 |
| `tradeRoute` | see §5.6 | **+150** (extra same-placement pairs: +50, no tiles) | +4 |
| `snowline` | a mountain group first reaches 5 tiles | **+25** | — |
| `estuary` / `spring` / `portCall` / `cliff` | junction created (§5.1) | as §5.1 | — |

All values (TUNE). The hinterland term (graft from "economy") makes land decisions
price sea decisions: a harbor backed by a 12-house town is worth +60 more per route.

**Snowline once-only semantics:** keep a set of tile keys belonging to any group that
has fired `snowline`; a group fires only if it contains no key from that set; on fire,
add all its keys. Merges never re-fire.

### 5.5 Peak crowning — precise rule

A Peak candidate (≥4 printed Mt edges) is **crowned** when:

1. all 6 neighbor cells are occupied, AND
2. every Mountain edge of the candidate faces a Mountain edge (match) or a River edge
   (source junction) — both count as "engaged rock face";
3. non-Mountain edges only needed to be legal at placement; they need not match.

Checked after every placement; crowning is retroactive (fires the moment the 6th
neighbor lands, whichever tile completes it). Fires once per tile. Snowcap appears.

### 5.6 Trade Route — precise semantics

Definitions: rail network = maximal set of tiles connected by matched Ra edges. A Crane
Harbor belongs to a rail network via its Ra edge and to the sea via its dock.

A Trade Route fires for harbor pair `(A,B)`, keyed `sortedAxialKey(A)+"|"+sortedAxialKey(B)`
in a persistent `firedTradeRoutes` set, when, evaluated after a placement:

1. a completed lane route connects dock A to dock B, AND
2. A or B is a Crane Harbor whose rail network has **≥4 tiles** (counted at fire time;
   later growth or merges never re-fire a fired pair).

Per placement: collect all newly-satisfied pairs; the highest-value one fires the full
**+150 / +4 tiles**; remaining new pairs are added to the set and pay **+50 each, no
tiles** (TUNE). No retroactive cascades, ever. Ships spawn per completed lane route
(render cap 8 ships).

### 5.7 Trade income (`CONFIG.tradeIncome`, default `true`)

**+2 points per completed lane route on every subsequent placement, cap +10**
(5 routes) (TUNE). The only future-paying mechanic; rewards mid-game harbor tempo.
Flag-gated so the balance team can amputate it without touching other channels.

### 5.8 End-game bonuses

Longest rail **+10/tile** · longest river **+10/tile** · largest mountain group
**+8/tile** · largest ocean group **+5/tile** (all TUNE; ocean's is deliberately the
weakest — it is the anti-snowball knob).

---

## 6. Quests

**Visible at once: 3 standard + 1 Epic + up to 3 flags.** Standard quests respawn on
completion. The Epic is drawn at session start, shown immediately (gives the run an
identity), persists until done.

### 6.1 Standard pool

Reward formula for cluster/length quests: **points = 100 + 10 × target**,
**tiles = min(2 + ⌈target/4⌉, 4)** (TUNE). Scaling: numeric targets **+2 per standard
quest completed this session, capped at base+8** (TUNE). One-shot quests don't scale.

| Quest | Metric | Base target | Reward | Available from |
|---|---|---|---|---|
| Big Forest / Big Field / Big Village | largest matching group | 6 + d3 | formula | Pastoral |
| Long River | connected river tiles | 4 + d3 | formula | Pastoral |
| Rail Line | connected rail tiles | 4 + d3 | formula | Pastoral |
| Mountain Range | mountain group size | 5 + d3 | formula | Highlands |
| Grow the Ocean | largest ocean group | 5 + d3 | formula | Tide |
| River's End | create 1 estuary | 1 (one-shot) | 100 pts, 2 tiles | Tide |
| Twin Harbors | 2 harbors on the same ocean group | 1 (one-shot) | 150 pts, 2 tiles | Tide |
| Open the Route | complete a lane route, length ≥3 (AMENDED from ≥5) | 1 (one-shot) | 220 pts, 4 tiles | lanes unlocked |

All bases/dies/rewards retuned in round 1 — `CONFIG.quests` is authoritative.

**Dead-quest guard** (resolves late-game feasibility concern): on spawn, clamp
`target ≤ bestCurrentProgress + floor(tilesRemaining / divisor)` (TUNE); if even the
base target violates the guard, draw a different quest. One-shot quests leave the pool
after `oneShotMaxCompletions` completions each (TUNE; retuned 2 → 1 in round 2).

**AMENDED (tuning round 2) — the guard extends to ACTIVE quests:** a standard quest
whose remaining need exceeds the spawn allowance by more than a small slack
(`target − progress > floor(tilesRemaining / divisor) + autoRefreshSlack`, TUNE) could
never have spawned in that position — keeping it on screen is dealer error under the
cozy mandate (§1). It is silently replaced with a fresh quest, free of charge (no
reroll spent, no penalty; if no replacement fits the guard, it stays). UI: the slot
fades and re-deals like a flag fading — no fanfare.

**Rerolls:** 3 free standard-quest rerolls per session — 1 granted at start, +1 at the
Tide transition, +1 at Voyage. The comeback valve for dead quests.

### 6.2 Epic pool (one per run; +visible from start)

| Epic | Condition | Reward |
|---|---|---|
| The Island | a land region of ≥3 tiles fully sea-locked (AMENDED, see below) | 400 pts, 6 tiles |
| Transcontinental | Trade Route with rail network ≥4 and lane ≥2 (AMENDED from ≥6/≥5, round 2: lane ≥3 → ≥2) | 400 pts, 6 tiles |
| Crown the Range | crown **2** Peaks | 280 pts, 5 tiles |

(All TUNE. Crown the Range reduced from 3 to 2 peaks for feasibility at 4–5% High
Mountain draw weight.)

**DESIGN AMENDMENTS (balance tuning round 1, see `sim/TUNING.md`):**

- **The Island** originally required every neighbor cell of the region to hold a
  pure-water tile. Under the §3.1 legality matrix that is unbuildable: every
  boundary tile of a minimal region would need ≥4 water edges and no archetype
  has more than 3. Amended reading: the region (non-sea tiles connected through
  land contact) is an island when **every non-water edge facing empty space is
  eliminated** — i.e. its entire frontier is ocean. The smallest island is a
  7-tile flower: six 3-Oc coasts around a soft center. Implemented in
  `quests.isIslandRinged`.
- **Transcontinental** rail ≥6 → ≥4 (aligned with the Trade Route's own rail
  threshold, so any trade route over a long-enough lane qualifies) and lane
  ≥5 → ≥3: median lane-tile supply is ~4 draws per run, so a 5-lane route was
  out of budget by construction.
- **Transcontinental (round 2)** lane ≥3 → ≥2: the epic's identity is carried
  by the rail-≥4 trade route; median completed-lane length is ~1.5, and at
  lane ≥3 the epic completed in ~10% of its runs vs the ~55%±15 gate
  (`sim/TUNING.md`, round 2).
- **Open the Route** lane length ≥5 → ≥3, same supply argument.

### 6.3 Flagged tile quests (graft from "feel" — the genre's compulsion engine)

20% (TUNE) of stack-drawn Meadow Blend / Hamlet / Pure Soft tiles carry a visible flag.
On placement it reads: *"grow THIS group to current + (3 + d4)"* (TUNE). Reward:
**60 pts + 2 tiles** (TUNE). Max 3 flags active; flag-eligible tiles drawn while 3 are
active spawn unflagged. If the flagged group is sealed (zero open edges) before the
target, the flag fades quietly — no penalty (cozy mandate).

### 6.4 Themed reward tiles

**60%** (TUNE) of quest-reward tiles are drawn themed to a currently active quest
(e.g., active Long River → river tiles); 40% from the stage table. This is the main
lever for tuning quest completion rate.

---

## 7. Tile Economy & Session Arc

### 7.1 Stack

**Starting stack: 45** (slider 15–100 retained; Zen mode retained: infinite tiles,
stages still advance by placement count, flags and quests active, no game over).

### 7.2 Tiles-in budget (median run, all rows TUNE)

| Source | Expected count | Tiles |
|---|---|---|
| Starting stack | — | 45 |
| Perfect placements | ~7 | +7 |
| Standard quests | ~8 × 3 avg | +24 |
| Flag quests | ~3 × 2 | +6 |
| Rivers completed | ~2 × 2 | +4 |
| Lane routes | ~1.5 × 2 | +3 |
| Peaks | ~1 × 1 | +1 |
| Trade Routes | ~0.7 × 4 | +3 |
| Epic (55% × 6) | — | +3 |
| **Total placements** | | **≈ 96** |

**Reproduction check (R):** earned tiles ÷ placements ≈ 51/96 ≈ **0.53**. Sessions
converge to ≈ 45/(1−R) ≈ 96 placements. `balance.mjs` asserts **R < 0.65** and
**P90 placements ≤ 135** (hard gates; the +2 quest scaling, base+8 cap, and 4-tile
reward cap are the knobs that push R down late-game).

**Pace:** ~10 s/placement → **13–17 minute session.**

### 7.3 Session arc (stages from §4.1, all transitions announced)

- **Pastoral (1–12):** literally GL1 — soft land, rivers, rails. Low quest targets.
- **Highlands (13–24):** mountains arrive (horn-call sting + brief camera nudge to the
  first ridge). Walls appear exactly when the map has structure worth protecting.
- **Tide (25–45):** **"The Tide Comes In"** — gull cries, wave-wash, horizon gains sea
  haze. Coast/harbor flow begins; lanes unlock via the tide gate; first estuaries.
- **Voyage (46+):** full marine table, routes and peaks cash in, the Epic resolves.
- **Finale (last 15 stack tiles):** harbor/lane weights ×2, "final 10 tiles" warning,
  end-game tally preview. The run ends in triage: which open rivers, un-harbored
  lanes, and un-crowned peaks get capped before the stack dies.
- **Curtain call:** on the last placement the golden-hour sun finally *sets*; fireflies
  rise, ship lanterns light; the camera flies the longest river, longest rail, and
  each completed route during the score tally. The end screen is a reward.

### 7.4 No-dead-tiles valves (cozy mandate; resolves the −25 discard concern)

1. **Winds shift (automatic, free):** if the tile in hand has zero legal placements in
   any rotation anywhere on the frontier, it auto-rerolls once with a "the winds
   shift" toast + breeze sound. If the replacement is also unplaceable, it is swapped
   for a guaranteed Meadow Blend (all-soft). No penalty, ever — RNG is dealer error.
   Sim gate: fires in **<2% of draws** (TUNE).
2. **Strategic discard (player choice):** a discard button is always visible; costs
   **−25 points** (TUNE), unlimited uses. Penalizing a *choice* is fair; penalizing
   RNG is not — valve 1 always runs first.

### 7.5 Controls (unchanged from GL1 + one addition)

Click place · **R** rotate · arrows/right-drag pan · scroll zoom · **Ctrl+Z** single
undo (full state restore) · **M** mute · **D** / button: discard (§7.4.2). The
legality layer needs zero new inputs — illegal cells simply show red.

---

## 8. The Fun Thesis — three new decision tensions

Vanilla Dorfromantik's tension is greedy-match vs. group-growth vs. not-walling-in.
Tideline keeps that and adds three decisions of genuinely different shapes, one per new
terrain:

1. **The river's destiny (mountains × oceans).** Every river has two cap types at
   opposite ends of the map's geography: a source in the rock, a mouth in the sea.
   "Cash this 6-tile river now (+72 + source + estuary) or stretch it three more tiles
   past the hamlet?" is a push-your-luck bet repriced on every river draw — and it
   makes mountains and oceans matter *to each other* through a third system.
2. **The coastline ratchet (oceans).** Ocean edges accept only ocean, so every ocean
   tile irreversibly converts frontier into sea — the one terrain that spends your
   map. Coast tiles are the scarce currency that freezes a coastline. Letting the sea
   grow (end bonus, lane room, The Island) vs. cauterizing it before it swallows your
   village's expansion space is a spatial-economy decision Dorfromantik doesn't have.
3. **Threading the needle (lanes), sealing the ring (mountains).** Lanes are a network
   inside a hard medium — profitable routes must be premeditated in the ocean's shape,
   and their value is set by the house-groups behind each harbor, so land decisions
   price sea decisions. Meanwhile the Peak inverts perfect-placement: you deliberately
   construct a 6-tile ring around the most-constrained tile in the game. Both are
   plans measured in many turns, paid off in one click.

Under repel mode the mountain–ocean repulsion quietly upgrades the whole board: the two
expanding masses can never touch, so land corridors become contested real estate that
rivers, rails, and villages all compete for. The map stops being a canvas and becomes
an opponent. The clean streak and trade income stitch the three tensions together
moment-to-moment, so even routine draws carry tension late-game.

---

## 9. Presentation & Audio — fixed scope

Carry forward GL1: golden-hour light, procedural WebAudio (no files), placement bounce,
score popups, sheep/trains/boats. The bespoke-juice list below is **complete and
closed** — nothing else bespoke ships in v1 (resolves the animation-budget concern):

1. Ghost-edge legality colors (green/grey/red) + denied-thunk. (The teaching loop.)
2. **Source-to-Sea celebration:** on `riverCompleted`, the score tally physically rides
   the river to its mouth (reuse GL1 CatmullRom vehicle-path code).
3. **Ship horn + ship spawn** on `laneCompleted` / `tradeRoute` (ships sail the route
   forever; render cap 8).
4. **Snowcaps** on `snowline` (cone-mesh swap) and on `peakCrowned` (bigger cap + brief
   eagle circle = one looping sprite path).
5. Stage transition stings: Highlands horn-call; **"The Tide Comes In"** (gulls +
   wave-wash + horizon haze tint).
6. **Sunset finale** camera flight (§7.3) — reuses existing camera + path data.

Everything else (fish, growing peaks, lighthouse beams, per-quest camera nudges) is
explicitly cut from v1 scope.

---

## 10. Balance Targets & Simulation Acceptance Gates

`sim/balance.mjs`, 200 seeded games per policy per config. Named gates (build fails red
if violated):

| Gate | Target |
|---|---|
| Median score, quest-aware bot | ≈ 2,800 ± 20% (TUNE) |
| Median score, greedy edge bot | ≈ 1,400 (TUNE) |
| **Land-only bot ≤ 55% of mixed-strategy bot** (no dominant strategy) | hard gate |
| Score distribution (quest-aware) | 45/15/25/10/5 ±5 pts per channel (§5) |
| Winds-shift fire rate | < 2% of draws |
| Runs reaching a dead board (no legal placement even after valves) | < 0.5% |
| **Same, on mountain-heavy seeds** (top-decile mountain draws) | < 1% — validated separately, repel mode |
| Placements P10–P90 | 72–135 (P10 amended 80 → 72, tuning round 3 — see note below); **P90 ≤ 135** hard gate |
| Tile reproduction R | **< 0.65** hard gate |
| Quest completion rate | 60–75%; Epic ≈ 55% |
| Engagement: ≥1 completed river / lane route / crowned peak | ≥70% / ≥50% / ≥40% of runs (TUNE) |
| `laneOceanRule:'sealed'` adoption test | strand <1% AND lane engagement within 10% of `'open'` — else `'open'` stays default |
| `mountainCoast:'repel'` adoption test | passes mountain-heavy gate above — else `'cliff'` becomes default |

> **DESIGN AMENDMENT (tuning round 3) — placements P10 gate 80 → 72.** The
> original floor is jointly infeasible with the **P90 ≤ 135 hard gate**, the
> ≈1,400 greedy ceiling and the §7.2 pace budget: tile earnings are
> success-conditional by design (quest / structure / epic rewards), so the
> placement distribution is the image of a multiplicative economy whose
> P10 : P90 ratio stays ≈ 0.55–0.60 under every (TUNE) lever. Measured in
> round 3 (~20 experiments): each +1 placement bought at P10 costs ≈ +1.3 at
> P90 and ≈ +21 greedy median; flattening rewards far enough to detach the
> tails guts the completion economy the game is built on. 72 placements still
> gives the bottom decile a ≥ 12-minute session at the §7.2 pace. Round-3
> close: P10 75.9–76.8 / P90 127–128 on both verification seeds (P10 was
> 62–64 at round-1 baseline).

---

## 11. CONFIG summary (single object in `src/core/`)

```js
CONFIG = {
  rules: {
    mountainCoast: 'repel',      // 'repel' | 'cliff'  (§3.2, §10)
    laneOceanRule: 'open',       // 'open'  | 'sealed' (§3.2, §10)
    tradeIncome:   true,         // §5.7
  },
  stack: { start: 45, slider: [15, 100], finaleWindow: 15 },
  stages: { pastoral: 12, highlands: 24, tide: 45 },     // upper bounds, placements
  weights: { /* §4.1 table + §4.2 modifiers, every number TUNE */ },
  scoring: { /* every constant in §5, all TUNE */ },
  quests:  { /* §6 tables: bases, +2 scaling, base+8 cap, guard divisor 4,
                rerolls 3, themed 0.60, flagRate 0.20, maxFlags 3 */ },
  valves:  { windsShift: true, discardCost: -25, harborPity: { lanes: 3, mult: 3, draws: 10 } },
}
```

Every numeric literal above is (TUNE); the flags are design decisions resolvable only
by the §10 sim gates.

---

## 12. Risks → Resolutions (judge-concern traceability)

| Concern (judges) | Resolution |
|---|---|
| "Clean streak / junction wasted" undefined | Replaced with the crisp clean/dirty/neutral predicate (§2, §5.2) — pure boolean per placement, trivially testable |
| Lane↔plain-ocean illegality strands draws / bricks ocean | Default flipped to semi-hard `'open'` (legal, 0 pts); `'sealed'` behind flag with explicit sim adoption test (§3.2, §10) |
| −25 discard punishes RNG | Free automatic winds-shift reroll first (with all-soft fallback); discard remains only as a *strategic choice* (§7.4) |
| Rail archetype needs bend/straight split | Explicit 40/35/25 straight/wide/tight split for River AND Rail (§4) |
| Mountain–ocean repulsion arbitrary / fallback undefined | Cliff junction fully designed (legal, +10, own art + event name); flag with sim-driven default selection (§3.2, §10) |
| No score-distribution / median target | Adopted: median 2,800, 45/15/25/10/5 split as the primary sim fitness target (§5, §10) |
| Trade Route identity / re-fire cascades | Persistent fired-pair set keyed by sorted axial keys; conditions counted at fire time; max one full fire per placement, extras +50 (§5.6) |
| Quest scaling vs. placement budget (R₀ unverified) | Budget table + R ≈ 0.53 computed; hard gates R < 0.65, P90 ≤ 135; scaling cap base+8; reward cap 4 tiles; dead-quest guard (§6.1, §7.2, §10) |
| Mountain strand risk concentrates late | High Mountain capped at 4–5% weight; winds-shift valve; dedicated mountain-heavy-seed sim gate (§10) |
| Peak rule underspecified | Precise 3-clause rule incl. retroactive crowning and river-source faces (§5.5) |
| "Act 1 plays like GL1" unmechanized | Explicit Pastoral column: zero mountain/ocean weight, placements 1–12 (§4.1) |
| Ocean-family cap vs. tide-gate redistribution | Lane redistribution stays inside the family; cap enforced last in a strict order of operations (§4.2) |
| Dead-end lane = negative tempo / theft | Harbor pity timer ×3/10 draws; lanes still pay +15/edge vs lane+dock; port calls pay per end; Open the Route + Twin Harbors subsidize (§4.2, §6.1) |
| Ocean snowball | Family cap 25/30/35 by stage, enforced post-modifiers; ocean end bonus weakest at +5/tile (§4.2, §5.8) |
| Animation budget sinks logic | Closed 6-item juice list; everything else explicitly cut (§9) |
| Complexity overload | 9 edge types (hard cap), 12 archetypes, staged arrival with announced events, ghost-tile teaching, junctions all theme-guessable (§1, §3.3, §7.3) |
