// DOM HUD wiring: score count-up, stack/streak pills, quest panel (standard +
// epic + flags with progress bars), tile previews, score popups, toasts, stage
// banners (DESIGN §7.3 names), junction first-time tooltips (§3.3), game-over
// tally. Pure DOM — no three.js; main.js feeds it game state and screen coords.

const QUEST_NAMES = {
  bigForest: 'Big Forest', bigField: 'Big Field', bigVillage: 'Big Village',
  longRiver: 'Long River', railLine: 'Rail Line', mountainRange: 'Mountain Range',
  growTheOcean: 'Grow the Ocean', riversEnd: "River's End", twinHarbors: 'Twin Harbors',
  openTheRoute: 'Open the Route', theIsland: 'The Island',
  transcontinental: 'Transcontinental', crownTheRange: 'Crown the Range',
};

const TERRAIN_LABEL = { GR: 'meadow', FO: 'forest', FI: 'field', HO: 'village' };

// Stage announcements (DESIGN §7.3).
const STAGE_BANNERS = {
  pastoral: { title: 'Pastoral', sub: 'soft land, rivers, rails' },
  highlands: { title: 'Highlands', sub: 'the mountains arrive' },
  tide: { title: 'The Tide Comes In', sub: 'gulls cry — the coast awakens' },
  voyage: { title: 'Voyage', sub: 'full sail — routes and peaks cash in' },
  finale: { title: 'Finale', sub: 'the last tiles — cap rivers, crown peaks' },
};

// Junction first-time tooltips (DESIGN §3.3). Point values come from the live
// CONFIG (the authority on tunables) so retuning can never desync this copy.
const JUNCTION_TIPS = {
  spring: (j) => `Spring — a river begins in the rock (+${j.source})`,
  estuary: (j) => `Estuary — the river meets the sea (+${j.estuary})`,
  portCall: (j) => `Port call — a lane reaches the dock (+${j.portCall})`,
  cliff: (j) => `Cliff — the range drops into the surf (+${j.cliff})`,
  mountainCoast: () => 'The range needs land before the sea — mountains never touch open water',
};

// Top-down hex preview colors (warm cousins of the renderer PALETTE).
const PREVIEW_FILL = {
  GR: '#699e3d', FO: '#356b39', FI: '#dcb74e', HO: '#c27e5e',
  RI: '#3f97d4', RA: '#535b66', MT: '#8d8578', OC: '#2a7fb8', LA: '#3d97c9',
};

const CHANNEL_LABELS = [
  ['edges', 'Edge matches'],
  ['streaksPerfects', 'Streaks & perfects'],
  ['quests', 'Quests'],
  ['structures', 'Structures & junctions'],
  ['endGame', 'End-game bonuses'],
];

export function createUI(handlers = {}) {
  const el = (id) => document.getElementById(id);
  const dom = {
    hud: el('hud'), score: el('score'), stack: el('stack'),
    streak: el('streak'), streakPill: el('streak-pill'), streakDots: el('streak-dots'),
    banner: el('stage-banner'), toasts: el('toasts'), popups: el('popups'),
    questList: el('quest-list'), rerollCount: el('reroll-count'),
    cvCurrent: el('cv-current'), cvNext1: el('cv-next1'), cvNext2: el('cv-next2'),
    muteLabel: el('mute-label'),
    goScreen: el('gameover-screen'), goSub: el('go-sub'), goScore: el('go-score'),
    goChannels: el('go-channels'), goStructures: el('go-structures'),
  };

  for (let i = 0; i < 10; i++) dom.streakDots.appendChild(document.createElement('i'));

  let game = null;
  let displayScore = 0;
  let shownTips = new Set();
  let bannerTimer = null;
  let lastStreak = 0;

  function bindGame(g) {
    game = g;
    displayScore = g.score;
    shownTips = new Set();
    lastStreak = g.ctx?.streak || 0;
    dom.streakPill.classList.remove('pulse', 'broken');
    dom.score.textContent = String(g.score);
    dom.hud.classList.remove('hidden');
    dom.goScreen.classList.add('hidden');
    refresh();
  }

  // --- score / stack / streak ---

  function update(dt) {
    if (!game) return;
    const target = game.score;
    if (displayScore !== target) {
      const diff = target - displayScore;
      displayScore += diff * Math.min(1, dt * 5);
      if (Math.abs(target - displayScore) < 0.8) displayScore = target;
      dom.score.textContent = String(Math.round(displayScore));
    }
  }

  function bumpScore() {
    dom.score.classList.remove('bump');
    void dom.score.offsetWidth; // restart the animation
    dom.score.classList.add('bump');
  }

  // restartable one-shot animation class on the streak pill
  function flashStreakPill(cls) {
    dom.streakPill.classList.remove('pulse', 'broken');
    void dom.streakPill.offsetWidth; // restart the animation
    dom.streakPill.classList.add(cls);
  }

  function refreshStats() {
    dom.stack.textContent = game.zen ? '∞' : String(Math.max(0, game.stackRemaining));
    const streak = game.ctx.streak || 0;
    dom.streak.textContent = String(streak);
    dom.streakPill.classList.toggle('live', streak > 0);
    if (streak > lastStreak) flashStreakPill('pulse');
    else if (streak < lastStreak) flashStreakPill('broken');
    lastStreak = streak;
    [...dom.streakDots.children].forEach((d, i) => d.classList.toggle('on', i < streak));
  }

  // --- quest panel ---

  function questRow(q, { epic = false, flag = false, index = -1 } = {}) {
    const row = document.createElement('div');
    row.className = 'quest' + (epic ? ' epic' : '') + (flag ? ' flag' : '') + (q.done ? ' done' : '');
    const name = flag
      ? `⚑ Grow this ${TERRAIN_LABEL[q.terrain] || 'group'}`
      : (QUEST_NAMES[q.id] || q.id);
    const prog = Math.min(q.progress, q.target);
    const meta = q.target > 1 ? `${prog} / ${q.target}` : (q.done || prog >= q.target ? 'done' : '');
    const reward = `+${q.points} pts · +${q.tiles} tiles`;
    const pct = Math.round(100 * Math.min(1, q.target ? prog / q.target : 0));
    const canReroll = index >= 0 && game.quests.rerolls > 0 && !game.over;
    row.innerHTML = `
      ${epic ? '<div class="epic-tag">Epic</div>' : ''}
      <div class="qrow">
        <span class="qname"></span>
        <span class="qmeta">${meta}${canReroll ? ` <button class="btn-reroll" title="Reroll this quest">↻</button>` : ''}</span>
      </div>
      <div class="qreward">${reward}</div>
      <div class="bar"><div class="fill" style="width:${pct}%"></div></div>`;
    row.querySelector('.qname').textContent = name;
    const btn = row.querySelector('.btn-reroll');
    if (btn) btn.addEventListener('click', () => handlers.onReroll && handlers.onReroll(index));
    return row;
  }

  function refreshQuests() {
    dom.questList.textContent = '';
    const qs = game.quests;
    qs.standard.forEach((q, i) => dom.questList.appendChild(questRow(q, { index: i })));
    if (qs.epic) dom.questList.appendChild(questRow(qs.epic, { epic: true }));
    for (const f of qs.flags) dom.questList.appendChild(questRow(f, { flag: true }));
    dom.rerollCount.textContent = qs.rerolls > 0 ? `↻ ×${qs.rerolls}` : '';
  }

  // --- tile previews (top-down hex, edge wedges colored by terrain) ---

  function drawTilePreview(canvas, tile) {
    const c = canvas.getContext('2d');
    const w = canvas.width;
    const h = canvas.height;
    c.clearRect(0, 0, w, h);
    if (!tile) return;
    const cx = w / 2;
    const cy = h / 2;
    const R = Math.min(w, h) / 2 - 4;
    const corner = (deg) => {
      const a = (deg * Math.PI) / 180;
      return [cx + R * Math.cos(a), cy + R * Math.sin(a)];
    };
    for (let i = 0; i < 6; i++) {
      const a = -i * 60; // edge i center angle; screen y = world z
      const [x1, y1] = corner(a - 30);
      const [x2, y2] = corner(a + 30);
      c.beginPath();
      c.moveTo(cx, cy);
      c.lineTo(x1, y1);
      c.lineTo(x2, y2);
      c.closePath();
      c.fillStyle = PREVIEW_FILL[tile.edges[i]] || '#999';
      c.fill();
    }
    // hex outline
    c.beginPath();
    for (let i = 0; i < 6; i++) {
      const [x, y] = corner(-i * 60 + 30);
      if (i === 0) c.moveTo(x, y); else c.lineTo(x, y);
    }
    c.closePath();
    c.lineWidth = Math.max(2, R * 0.09);
    c.strokeStyle = 'rgba(74, 58, 42, 0.55)';
    c.stroke();
    // lane dashes + dock marks
    for (let i = 0; i < 6; i++) {
      const a = (-i * 60 * Math.PI) / 180;
      const mx = cx + R * 0.72 * Math.cos(a);
      const my = cy + R * 0.72 * Math.sin(a);
      if (tile.edges[i] === 'LA') {
        c.fillStyle = '#f5f0e8';
        c.beginPath();
        c.arc(mx, my, R * 0.07, 0, Math.PI * 2);
        c.fill();
      }
      if (tile.dockEdges && tile.dockEdges.includes(i)) {
        c.fillStyle = '#8a6a48';
        c.save();
        c.translate(mx, my);
        c.rotate(a + Math.PI / 2);
        c.fillRect(-R * 0.16, -R * 0.07, R * 0.32, R * 0.14);
        c.restore();
      }
    }
    if (tile.flag) {
      c.fillStyle = '#c0533a';
      c.font = `800 ${Math.round(R * 0.55)}px system-ui`;
      c.textAlign = 'center';
      c.fillText('⚑', cx, cy + R * 0.2);
    }
  }

  function refreshPreviews() {
    drawTilePreview(dom.cvCurrent, game.currentTile);
    const next = game.over ? [] : game.nextTiles(2);
    drawTilePreview(dom.cvNext1, next[0] || null);
    drawTilePreview(dom.cvNext2, next[1] || null);
  }

  function refresh() {
    if (!game) return;
    refreshStats();
    refreshQuests();
    refreshPreviews();
  }

  // --- popups (floating +N at a screen position, color-coded by channel) ---

  // recent spawn positions, so simultaneous popups never overlap
  const activePopups = [];

  function popup(x, y, text, channel = 'edges', delay = 0, sub = '') {
    const make = () => {
      const now = performance.now();
      for (let i = activePopups.length - 1; i >= 0; i--) {
        if (now - activePopups[i].t > 1300) activePopups.splice(i, 1);
      }
      let py = y;
      let hit = true;
      let guard = 0;
      while (hit && guard++ < 30) {
        hit = false;
        for (const p of activePopups) {
          if (Math.abs(p.x - x) < 130 && Math.abs(p.y - py) < 42) {
            py = p.y - 42; // stack upward, never on top of a live popup
            hit = true;
          }
        }
      }
      activePopups.push({ x, y: py, t: now });
      const d = document.createElement('div');
      d.className = `popup ${channel}`;
      d.textContent = text;
      if (sub) {
        const s = document.createElement('small');
        s.textContent = sub;
        d.appendChild(s);
      }
      d.style.left = `${Math.round(x)}px`;
      d.style.top = `${Math.round(py)}px`;
      dom.popups.appendChild(d);
      setTimeout(() => d.remove(), 2000);
    };
    if (delay > 0) setTimeout(make, delay); else make();
  }

  // --- toasts ---

  function toast(text, { tip = false } = {}) {
    const d = document.createElement('div');
    d.className = 'toast' + (tip ? ' tip' : '');
    d.textContent = text;
    dom.toasts.appendChild(d);
    while (dom.toasts.children.length > 4) dom.toasts.firstChild.remove();
    setTimeout(() => d.remove(), 3500);
  }

  function junctionTip(type) {
    if (shownTips.has(type) || !JUNCTION_TIPS[type] || !game) return;
    shownTips.add(type);
    toast(JUNCTION_TIPS[type](game.config.scoring.junction), { tip: true });
  }

  // --- stage banner ---

  function banner(stage, detail = '') {
    const b = STAGE_BANNERS[stage];
    if (!b) return;
    if (bannerTimer) clearTimeout(bannerTimer);
    dom.banner.querySelector('.title').textContent = b.title;
    dom.banner.querySelector('.sub').textContent = detail || b.sub;
    dom.banner.classList.remove('show');
    void dom.banner.offsetWidth;
    dom.banner.classList.add('show');
    bannerTimer = setTimeout(() => dom.banner.classList.remove('show'), 3500);
  }

  function setMuted(m) {
    dom.muteLabel.textContent = m ? 'Muted' : 'Sound on';
  }

  function questName(q) {
    if (q.flag) return `flag — ${TERRAIN_LABEL[q.terrain] || 'group'} grown`;
    if (q.epic) return `Epic — ${QUEST_NAMES[q.id] || q.id}`;
    return QUEST_NAMES[q.id] || q.id;
  }

  // --- game over tally ---

  function showGameOver(g, { deadBoard = false } = {}) {
    dom.goSub.textContent = deadBoard
      ? 'The land locked itself away'
      : (g.zen ? 'The tide rests' : 'The stack is spent');
    dom.goScore.textContent = String(g.score);

    dom.goChannels.textContent = '';
    const max = Math.max(1, ...CHANNEL_LABELS.map(([k]) => Math.abs(g.channels[k] || 0)));
    CHANNEL_LABELS.forEach(([k, label], i) => {
      const v = g.channels[k] || 0;
      const row = document.createElement('div');
      row.className = 'go-row';
      row.style.animationDelay = `${0.15 + i * 0.12}s`;
      row.innerHTML = `
        <span class="name">${label}</span>
        <div class="bar"><div class="fill" style="width:0%"></div></div>
        <span class="val">${v}</span>`;
      dom.goChannels.appendChild(row);
      const fill = row.querySelector('.fill');
      setTimeout(() => { fill.style.width = `${Math.round(100 * Math.abs(v) / max)}%`; },
        200 + i * 120);
    });

    const eg = g.endGameResult || { longestRiver: 0, longestRail: 0, largestMountain: 0, largestOcean: 0 };
    const st = g.stats.structures || {};
    dom.goStructures.textContent = '';
    const stats = [
      ['Longest river', `${eg.longestRiver} tiles`],
      ['Longest rail', `${eg.longestRail} tiles`],
      ['Largest range', `${eg.largestMountain} tiles`],
      ['Largest ocean', `${eg.largestOcean} tiles`],
      ['Rivers completed', String(st.riverCompleted || 0)],
      ['Lane routes', String(st.laneCompleted || 0)],
      ['Peaks crowned', String(st.peakCrowned || 0)],
      ['Trade routes', String(st.tradeRoute || 0)],
    ];
    for (const [label, val] of stats) {
      const d = document.createElement('div');
      d.className = 'go-stat';
      d.innerHTML = `${label} <b>${val}</b>`;
      dom.goStructures.appendChild(d);
    }
    dom.goScreen.classList.remove('hidden');
  }

  return {
    bindGame, update, refresh, refreshPreviews, bumpScore,
    popup, toast, junctionTip, banner, setMuted, showGameOver, questName,
  };
}
