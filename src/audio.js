// Procedural WebAudio (GL1 AudioSys patterns, module form). Everything is
// synthesized — no asset files. Master mute is wired to M in main.js.

let ctx = null;
let master = null;
let muted = false;
let tideArrived = false;
let birdTimer = null;
let gullTimer = null;

export function init() {
  if (ctx) {
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    return;
  }
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = muted ? 0 : 0.5;
    master.connect(ctx.destination);
    startAmbient();
  } catch {
    ctx = null;
  }
}

export function isMuted() {
  return muted;
}

export function setMuted(m) {
  muted = !!m;
  if (master) master.gain.value = muted ? 0 : 0.5;
  return muted;
}

export function toggleMute() {
  return setMuted(!muted);
}

// --- synth primitives (GL1 tone() carried forward) ---

function tone(freq, dur, type, vol, delay = 0, slideTo = null) {
  if (!ctx) return;
  const t = ctx.currentTime + delay;
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t);
  if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(vol, t + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  osc.connect(g);
  g.connect(master);
  osc.start(t);
  osc.stop(t + dur + 0.05);
}

// Brass-ish voice: sawtooth through a lowpass with a slow attack.
function horn(freq, dur, vol, delay = 0, { attack = 0.08, cutoff = 700, detune = 0 } = {}) {
  if (!ctx) return;
  const t = ctx.currentTime + delay;
  const osc = ctx.createOscillator();
  osc.type = 'sawtooth';
  osc.frequency.setValueAtTime(freq, t);
  osc.detune.value = detune;
  const f = ctx.createBiquadFilter();
  f.type = 'lowpass';
  f.frequency.value = cutoff;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(vol, t + attack);
  g.gain.setValueAtTime(vol, t + dur * 0.7);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  osc.connect(f);
  f.connect(g);
  g.connect(master);
  osc.start(t);
  osc.stop(t + dur + 0.1);
}

let noiseBuf = null;
function getNoiseBuf() {
  if (!noiseBuf) {
    const len = ctx.sampleRate * 2;
    noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = noiseBuf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
  }
  return noiseBuf;
}

// Filtered noise with a swell envelope (waves, breeze).
function wash(dur, vol, { type = 'lowpass', freq = 600, sweepTo = null, attack = null, delay = 0 } = {}) {
  if (!ctx) return;
  const t = ctx.currentTime + delay;
  const src = ctx.createBufferSource();
  src.buffer = getNoiseBuf();
  src.loop = true;
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.frequency.setValueAtTime(freq, t);
  if (sweepTo) f.frequency.exponentialRampToValueAtTime(sweepTo, t + dur);
  const g = ctx.createGain();
  const att = attack ?? dur * 0.45;
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(vol, t + att);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  src.connect(f);
  f.connect(g);
  g.connect(master);
  src.start(t);
  src.stop(t + dur + 0.1);
}

// One gull cry: a sine that swoops up then falls ("kee-aw").
function gull(delay = 0, vol = 0.07) {
  if (!ctx) return;
  const t = ctx.currentTime + delay;
  const osc = ctx.createOscillator();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(950, t);
  osc.frequency.exponentialRampToValueAtTime(1500, t + 0.12);
  osc.frequency.exponentialRampToValueAtTime(700, t + 0.34);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(vol, t + 0.04);
  g.gain.linearRampToValueAtTime(vol * 0.6, t + 0.16);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.38);
  osc.connect(g);
  g.connect(master);
  osc.start(t);
  osc.stop(t + 0.45);
}

// --- one-shots ---

export function place() {
  tone(160, 0.18, 'triangle', 0.5, 0, 50);
  tone(80, 0.12, 'sine', 0.4, 0, 40);
}

// Denied: the GL1 thunk detuned into a flat, beating pair.
export function denied() {
  tone(130, 0.22, 'triangle', 0.35, 0, 55);
  tone(138, 0.22, 'triangle', 0.3, 0, 58);
  tone(65, 0.16, 'sine', 0.3, 0, 45);
}

const CHIME_NOTES = [523.25, 587.33, 659.25, 783.99, 880, 1046.5, 1174.66, 1318.51, 1567.98];

// Soft match chime; the run starts higher as the clean streak grows.
export function chime(matches, streak = 0) {
  if (matches <= 0) return;
  const start = Math.min(streak, 4);
  const n = Math.min(matches, 5);
  for (let i = 0; i < n; i++) tone(CHIME_NOTES[start + i], 0.35, 'sine', 0.18, i * 0.07);
}

export function perfect(consecutive = 1) {
  const run = [523.25, 659.25, 783.99, 1046.5, 1318.5];
  run.forEach((f, i) => tone(f, 0.5, 'triangle', 0.2, i * 0.09));
  if (consecutive > 1) tone(1567.98, 0.7, 'sine', 0.16, 0.5); // escalation sparkle
}

export function quest() {
  [392, 523.25, 659.25, 783.99].forEach((f, i) => tone(f, 0.6, 'triangle', 0.22, i * 0.13));
  tone(1046.5, 0.9, 'sine', 0.15, 0.5);
}

// Ship horn for laneCompleted / tradeRoute (two blasts for a trade route).
export function shipHorn(kind = 'laneCompleted') {
  const blast = (d) => {
    horn(98, 0.8, 0.3, d, { attack: 0.05, cutoff: 420 });
    horn(98, 0.8, 0.2, d, { attack: 0.05, cutoff: 420, detune: 9 });
    horn(147, 0.8, 0.12, d, { attack: 0.05, cutoff: 500 });
  };
  blast(0);
  if (kind === 'tradeRoute') blast(0.95);
}

// Highlands sting: a horn-call rising over the new ridge.
export function hornCall() {
  horn(196, 0.55, 0.2, 0, { cutoff: 800 });
  horn(261.63, 0.55, 0.2, 0.4, { cutoff: 850 });
  horn(329.63, 1.1, 0.22, 0.8, { cutoff: 900 });
  horn(196, 1.1, 0.1, 0.8, { cutoff: 700 });
  horn(329.63, 0.9, 0.07, 1.7, { cutoff: 650 }); // distant echo
}

// "The Tide Comes In": gull cries over a wave-wash swell.
export function tideIn() {
  wash(2.6, 0.13, { freq: 750, sweepTo: 350 });
  wash(2.2, 0.08, { freq: 600, sweepTo: 300, delay: 1.6 });
  gull(0.5, 0.08);
  gull(1.1, 0.06);
  gull(1.5, 0.05);
  tideArrived = true;
  startGulls();
}

// Winds-shift valve: a quick breeze through the rigging.
export function breeze() {
  wash(1.0, 0.16, { type: 'bandpass', freq: 450, sweepTo: 1300, attack: 0.25 });
  tone(880, 0.5, 'sine', 0.05, 0.15, 1175);
}

// Finale theme swell: a warm pad chord with sparkles on top.
export function finaleSwell() {
  const pad = [261.63, 329.63, 392, 523.25];
  pad.forEach((f) => horn(f, 3.5, 0.07, 0, { attack: 1.2, cutoff: 1000 }));
  [1046.5, 1318.51, 1567.98].forEach((f, i) => tone(f, 0.9, 'sine', 0.07, 1.2 + i * 0.3));
}

// Curtain call: the sun sets — gentle descending close.
export function curtain() {
  finaleSwell();
  [1567.98, 1318.51, 1046.5, 783.99].forEach((f, i) => tone(f, 1.0, 'sine', 0.08, 2.2 + i * 0.35));
  wash(4, 0.06, { freq: 500, sweepTo: 250, delay: 1 });
}

export function discard() {
  tone(330, 0.2, 'triangle', 0.2, 0, 165);
  tone(165, 0.25, 'sine', 0.18, 0.06, 90);
}

export function rotateTick() {
  tone(660, 0.06, 'square', 0.04);
}

export function undoSound() {
  tone(440, 0.16, 'sine', 0.14, 0, 330);
  tone(330, 0.2, 'sine', 0.1, 0.08, 262);
}

// Stage-transition dispatch (DESIGN §7.3 / §9 item 5).
export function sting(stage) {
  if (stage === 'highlands') hornCall();
  else if (stage === 'tide') tideIn();
  else if (stage === 'voyage') {
    horn(261.63, 0.7, 0.16, 0, { cutoff: 900 });
    horn(392, 1.2, 0.18, 0.45, { cutoff: 950 });
    gull(0.9, 0.06);
  } else if (stage === 'finale') finaleSwell();
}

// --- ambient loop: GL1 wind + occasional birdsong (gulls after the Tide) ---

function startAmbient() {
  const src = ctx.createBufferSource();
  src.buffer = getNoiseBuf();
  src.loop = true;
  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = 350;
  const windGain = ctx.createGain();
  windGain.gain.value = 0.035;
  const lfo = ctx.createOscillator();
  const lfoGain = ctx.createGain();
  lfo.frequency.value = 0.08;
  lfoGain.gain.value = 0.02;
  lfo.connect(lfoGain);
  lfoGain.connect(windGain.gain);
  src.connect(filter);
  filter.connect(windGain);
  windGain.connect(master);
  src.start();
  lfo.start();
  startBirds();
}

function startBirds() {
  if (birdTimer) return;
  const sing = () => {
    if (ctx && !muted) {
      const base = 2100 + Math.random() * 900;
      const n = 3 + Math.floor(Math.random() * 3);
      for (let i = 0; i < n; i++) {
        tone(base * (1 + Math.random() * 0.18), 0.09, 'sine', 0.035,
          i * 0.13 + Math.random() * 0.04, base * (1.1 + Math.random() * 0.25));
      }
    }
    birdTimer = setTimeout(sing, 3500 + Math.random() * 6500);
  };
  birdTimer = setTimeout(sing, 2000);
}

function startGulls() {
  if (gullTimer || !tideArrived) return;
  const cry = () => {
    if (ctx && !muted && Math.random() < 0.7) gull(0, 0.04 + Math.random() * 0.03);
    gullTimer = setTimeout(cry, 9000 + Math.random() * 12000);
  };
  gullTimer = setTimeout(cry, 6000);
}

export function dispose() {
  if (birdTimer) clearTimeout(birdTimer);
  if (gullTimer) clearTimeout(gullTimer);
  birdTimer = gullTimer = null;
}
