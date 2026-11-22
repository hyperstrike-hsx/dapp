import type * as THREE from "three";
import type { Cue, CueName } from "./cues";
import type { RangeMapId } from "./mapList";
import type { RangeSound } from "./sound";

// The soundscape of each range: continuous beds (wind, room tone, machinery, water, a far city)
// and the one-off sounds of range/cues.ts. All of it is synthesised; nothing is downloaded.
//
// How it is put together:
//   - Every one-off voice (a bird phrase, a bell, a passing train) is a small recipe of oscillators
//     and filtered noise, rendered ahead of time with an OfflineAudioContext in a few takes, so
//     playing one costs a buffer, a gain and a panner. The richer continuous textures (a
//     fountain, mains hum, a generator) are rendered the same way into seamless loops.
//   - A map is a list of beds (a noise or loop source fanned through filters whose level, cutoff
//     and position wander) and a list of events (a voice, how often, where, how loud). Nothing is
//     driven by a fixed clock, so no two minutes are the same.
//   - The engine runs on any BaseAudioContext, which is how it is measured offline.
//   - No human voices, on purpose: no crowds, calls, announcements or speech-like murmur. They pull
//     attention from the range. Places are told by air, water, machines, animals and work.

// ---- Numbers ------------------------------------------------------------------------------------
const RATE = 44100;
const rand = (lo: number, hi: number) => lo + Math.random() * (hi - lo);
const between = (range: readonly [number, number]) => rand(range[0], range[1]);
const pick = <T>(list: readonly T[]): T => list[Math.floor(Math.random() * list.length)];
const gainOf = (decibels: number) => 10 ** (decibels / 20);
const clamp = (value: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, value));

// ---- Noise --------------------------------------------------------------------------------------
// Four looping sources shared by every recipe and every bed. Each is filtered with its state
// carried round the end of the buffer, so the loop point is inaudible.
type NoiseKind = "white" | "pink" | "brown" | "crackle";
type Noise = Record<NoiseKind, AudioBuffer> & { rms: Record<NoiseKind, number> };
let noiseBank: Noise | null = null;

function noises(): Noise {
  if (noiseBank) return noiseBank;
  const rms: Record<NoiseKind, number> = { white: 0, pink: 0, brown: 0, crackle: 0 };
  const make = (kind: NoiseKind, seconds: number, fill: (data: Float32Array) => void, level: number | null) => {
    const buffer = new AudioBuffer({ length: Math.floor(RATE * seconds), sampleRate: RATE, numberOfChannels: 1 });
    const data = buffer.getChannelData(0);
    fill(data);
    let mean = 0;
    for (let i = 0; i < data.length; i += 1) mean += data[i];
    mean /= data.length;
    let power = 0, peak = 0;
    for (let i = 0; i < data.length; i += 1) { data[i] -= mean; power += data[i] * data[i]; peak = Math.max(peak, Math.abs(data[i])); }
    const scale = level === null ? 1 / peak : level / Math.sqrt(power / data.length);
    for (let i = 0; i < data.length; i += 1) data[i] *= scale;
    rms[kind] = Math.sqrt(power / data.length) * scale;
    return buffer;
  };
  const white = (data: Float32Array) => { for (let i = 0; i < data.length; i += 1) data[i] = Math.random() * 2 - 1; };
  /** Runs a recursive filter twice round the buffer and keeps the second lap. */
  const lapped = (data: Float32Array, filter: (input: number) => number) => {
    const input = Float32Array.from(data);
    for (let i = 0; i < input.length; i += 1) filter(input[i]);
    for (let i = 0; i < input.length; i += 1) data[i] = filter(input[i]);
  };
  noiseBank = {
    white: make("white", 3.1, white, 0.2),
    pink: make("pink", 7.3, (data) => {
      white(data);
      let b0 = 0, b1 = 0, b2 = 0;
      lapped(data, (w) => {
        b0 = 0.99765 * b0 + w * 0.099046; b1 = 0.963 * b1 + w * 0.2965164; b2 = 0.57 * b2 + w * 1.0526913;
        return b0 + b1 + b2 + w * 0.1848;
      });
    }, 0.2),
    // Leaky integrator with its corner near 40 Hz: no energy wasted below hearing.
    brown: make("brown", 9.1, (data) => { white(data); let y = 0; lapped(data, (w) => (y = 0.9943 * y + w)); }, 0.2),
    // Sparse clicks of every size: embers, grit, snow, static.
    crackle: make("crackle", 5.3, (data) => {
      for (let i = 0; i < data.length; i += 1) data[i] = Math.random() < 260 / RATE ? (Math.random() * 2 - 1) * Math.random() ** 2 : 0;
      let y = 0;
      lapped(data, (w) => (y = 0.55 * y + w));
    }, null),
    rms,
  };
  return noiseBank;
}

// ---- Recipe kit ---------------------------------------------------------------------------------
type Kit = { c: BaseAudioContext; out: AudioNode; n: Noise };
/** Breakpoints: [seconds after the start, value]. */
type Points = Array<[number, number]>;
const scale = (points: Points, by: number): Points => points.map(([at, value]) => [at, value * by]);
const steady = (level: number): Points => [[0, level]];

function ramp(param: AudioParam, t: number, points: Points | number, exp = false) {
  if (typeof points === "number") { param.value = points; return; }
  const floor = (value: number) => (exp ? Math.max(value, 1e-4) : value);
  param.value = floor(points[0][1]);
  points.forEach(([at, value], index) => {
    if (index === 0) param.setValueAtTime(floor(value), t + at);
    else if (exp) param.exponentialRampToValueAtTime(floor(value), t + at);
    else param.linearRampToValueAtTime(floor(value), t + at);
  });
}

function biquad(k: Kit, type: BiquadFilterType, hz: number, q = 0.7) {
  const node = k.c.createBiquadFilter();
  node.type = type; node.frequency.value = hz; node.Q.value = q;
  return node;
}

/** A filter already wired to the output (or to `to`): something to play into. */
function through(k: Kit, type: BiquadFilterType, hz: number, q = 0.7, to?: AudioNode) {
  const node = biquad(k, type, hz, q);
  node.connect(to ?? k.out);
  return node;
}

function amp(k: Kit, level: number, to?: AudioNode) {
  const node = k.c.createGain();
  node.gain.value = level;
  if (to) node.connect(to);
  return node;
}

function source(k: Kit, kind: NoiseKind, t: number, d: number, rate = 1) {
  const node = k.c.createBufferSource();
  node.buffer = k.n[kind]; node.loop = true; node.playbackRate.value = rate;
  node.start(t, Math.random() * (k.n[kind].duration - 0.1));
  node.stop(t + d + 0.05);
  return node;
}

type NoiseOptions = { src?: NoiseKind; t: number; d: number; type?: BiquadFilterType; f: Points | number; q?: number; g: Points; exp?: boolean; rate?: number; to?: AudioNode };
/** Noise through one filter, with the cutoff and the level drawn as breakpoints. */
function noise(k: Kit, o: NoiseOptions) {
  const band = biquad(k, o.type ?? "bandpass", 1000, o.q ?? 0.7);
  ramp(band.frequency, o.t, o.f, true);
  const volume = k.c.createGain();
  ramp(volume.gain, o.t, o.g, o.exp);
  source(k, o.src ?? "white", o.t, o.d, o.rate).connect(band).connect(volume).connect(o.to ?? k.out);
  return { band, volume };
}

type ToneOptions = { t: number; d: number; type?: OscillatorType; wave?: PeriodicWave; f: Points | number; g: Points; exp?: boolean; to?: AudioNode };
function tone(k: Kit, o: ToneOptions) {
  const osc = k.c.createOscillator();
  if (o.wave) osc.setPeriodicWave(o.wave); else osc.type = o.type ?? "sine";
  ramp(osc.frequency, o.t, o.f, true);
  const volume = k.c.createGain();
  ramp(volume.gain, o.t, o.g, o.exp);
  osc.connect(volume).connect(o.to ?? k.out);
  osc.start(o.t); osc.stop(o.t + o.d + 0.02);
  return { osc, volume };
}

/** Partials that ring and die, [ratio, level, seconds]: bells, plate, glass, chain. */
function ring(k: Kit, t: number, base: number, partials: Array<[number, number, number]>, to?: AudioNode, attack = 0.002) {
  for (const [ratio, level, decay] of partials) {
    if (base * ratio > 15000) continue;
    tone(k, { t, d: decay, f: base * ratio, g: [[0, 0], [attack, level], [decay, 0]], exp: true, to });
  }
}

/** One oscillator carrying a whole harmonic series. */
function harmonics(c: BaseAudioContext, levels: number[]) {
  const imag = new Float32Array(levels.length + 1);
  levels.forEach((level, index) => { imag[index + 1] = level; });
  return c.createPeriodicWave(new Float32Array(levels.length + 1), imag);
}

/** A train of narrow pulses (peak 1, a little below zero between them): firing strokes, rotor blades, wing beats. */
function pulse(c: BaseAudioContext, sharpness: number) {
  const real = new Float32Array(sharpness + 1).fill(1);
  real[0] = 0;
  return c.createPeriodicWave(real, new Float32Array(sharpness + 1));
}

/** An oscillator into a parameter. */
function lfo(k: Kit, param: AudioParam, t: number, d: number, hz: Points | number, depth: number, wave?: PeriodicWave | OscillatorType) {
  const osc = k.c.createOscillator();
  if (typeof wave === "string") osc.type = wave as OscillatorType; else if (wave) osc.setPeriodicWave(wave);
  ramp(osc.frequency, t, hz, true);
  osc.connect(amp(k, depth)).connect(param);
  osc.start(t); osc.stop(t + d + 0.02);
}

/** A slow random signal into a parameter: moves at about `hz`, swinging ±depth. */
function wobble(k: Kit, param: AudioParam, t: number, d: number, hz: number, depth: number) {
  source(k, "white", t, d, hz / 11025).connect(amp(k, depth * 2.9)).connect(param);
}

/** A random open-and-shut envelope (0 .. depth) into a gain: syllables, bubbles, gusts. */
function gate(k: Kit, param: AudioParam, t: number, d: number, hz: number, duty = 0.5, depth = 1) {
  const shaper = k.c.createWaveShaper();
  const curve = new Float32Array(257), threshold = 1 - 2 * duty;
  for (let i = 0; i < curve.length; i += 1) {
    const open = clamp((i / 128 - 1 - threshold) / 0.4, 0, 1);
    curve[i] = open * open * (3 - 2 * open);
  }
  shaper.curve = curve;
  source(k, "white", t, d, hz / 11025).connect(amp(k, 2.9)).connect(shaper).connect(amp(k, depth)).connect(param);
}

/** A whistled note: a sine that glides, optionally frequency-modulated for a burr or a trill. */
function chirp(k: Kit, t: number, d: number, hz: Points, level: number, o: { mod?: number; index?: number; to?: AudioNode } = {}) {
  const note = tone(k, { t, d, f: hz, g: [[0, 0], [d * 0.2, level], [d * 0.65, level * 0.75], [d, 0]], to: o.to });
  if (o.mod && o.index) lfo(k, note.osc.frequency, t, d, o.mod, o.index);
  return note;
}

type Formant = [hz: number, q: number, level: number];
/** A reedy source through resonances: throats, hinges, anything that sings through a body. */
function reed(k: Kit, t: number, d: number, hz: Points, formants: Formant[], level: number, o: { rough?: number; rate?: number; chatter?: number; jitter?: number; to?: AudioNode } = {}) {
  const body = k.c.createGain();
  for (const [at, q, gain] of formants) body.connect(biquad(k, "bandpass", at, q)).connect(amp(k, gain, o.to ?? k.out));
  const note = tone(k, { t, d, type: "sawtooth", f: hz, g: [[0, 0], [d * 0.15, level], [d * 0.75, level * 0.8], [d, 0]], to: body });
  if (o.rough) lfo(k, note.osc.frequency, t, d, o.rate ?? 55, hz[0][1] * o.rough);
  if (o.jitter) wobble(k, note.osc.frequency, t, d, 30, hz[0][1] * o.jitter);
  if (o.chatter) wobble(k, note.volume.gain, t, d, 28, level * o.chatter);
  return note;
}

/** Heard from a long way off: dulled, with one slap back off a far wall. */
function faraway(k: Kit, hz: number, echo = 0, back = 0.3): AudioNode {
  const dull = biquad(k, "lowpass", hz, 0.5);
  dull.connect(k.out);
  if (echo > 0) {
    const delay = k.c.createDelay(1.5);
    delay.delayTime.value = echo;
    dull.connect(delay).connect(biquad(k, "lowpass", hz * 0.6, 0.5)).connect(amp(k, back, k.out));
  }
  return dull;
}

/** A bubble: the pitch dips and runs up as it closes. */
const blip = (k: Kit, t: number, hz: number, level: number, to?: AudioNode) =>
  tone(k, { t, d: 0.09, f: [[0, hz], [0.016, hz * 0.82], [0.075, hz * rand(1.7, 2.3)]], g: [[0, 0], [0.003, level], [0.085, 0]], exp: true, to });
/** A burst of noise that dies away: an impact, a puff, a click. */
const puff = (k: Kit, t: number, src: NoiseKind, type: BiquadFilterType, hz: number, q: number, decay: number, level: number, to?: AudioNode) =>
  noise(k, { src, t, d: decay + 0.01, type, f: hz, q, g: [[0, 0], [Math.min(0.003, decay * 0.2), level], [decay, 0]], exp: true, to });
/** A falling sine: the weight behind an impact. */
const thud = (k: Kit, t: number, from: number, to: number, decay: number, level: number, out?: AudioNode) =>
  tone(k, { t, d: decay, f: [[0, from], [decay * 0.7, to]], g: [[0, 0], [0.004, level], [decay, 0]], exp: true, to: out });

// ---- Voices: every name in range/cues.ts ----------------------------------------------------------
type Voice = {
  /** Seconds rendered (silence at the end is trimmed). */
  len: number;
  /** Peak level in dBFS, heard from right beside it. */
  db: number;
  /** How far it carries: distance counts for this much less. */
  reach?: number;
  /** Least seconds between two of them. */
  gap?: number;
  /** How many different renders to keep. */
  takes?: number;
  /** Something that travels: given one place, it passes through it. */
  glide?: boolean;
  build: (k: Kit, t: number) => void;
};

const VOICES: Record<CueName, Voice> = {
  // ---- Animals ----
  wingsFlush: { len: 2.4, db: -10, reach: 1.5, build(k, t) {
    const birds = 5 + Math.floor(Math.random() * 4);
    for (let bird = 0; bird < birds; bird += 1) {
      const rate = rand(9, 14), start = t + rand(0, 0.3), flaps = Math.floor(rand(8, 18)), hz = rand(700, 1500), whistles = Math.random() < 0.4;
      for (let i = 0; i < flaps; i += 1) {
        const at = start + i / rate + rand(-0.008, 0.008), fade = Math.exp((-2.4 * i) / flaps);
        noise(k, { src: "pink", t: at, d: 0.07, f: [[0, hz * 1.6], [0.05, hz * 0.7]], q: 1.1, g: [[0, 0], [0.008, fade], [0.06, 0]] });
        if (whistles) tone(k, { t: at, d: 0.04, f: [[0, 2300], [0.035, 2900]], g: [[0, 0], [0.01, fade * 0.07], [0.035, 0]] });
      }
    }
  } },
  pigeonCoo: { len: 1.7, db: -12, build(k, t) {
    const base = rand(330, 410), soft = biquad(k, "lowpass", 1100, 0.5);
    soft.connect(k.out);
    for (const [at, d, level] of [[0, 0.3, 0.8], [0.45, 0.55, 1], [1.12, 0.36, 0.7]]) {
      const hz: Points = [[0, base * 0.9], [d * 0.3, base * 1.06], [d, base * 0.84]];
      const g: Points = [[0, 0], [d * 0.3, level], [d * 0.7, level * 0.8], [d, 0]];
      const note = tone(k, { t: t + at, d, f: hz, g, to: soft });
      lfo(k, note.volume.gain, t + at, d, rand(20, 26), level * 0.28);
      tone(k, { t: t + at, d, f: scale(hz, 2), g: scale(g, 0.2), to: soft });
      noise(k, { src: "pink", t: t + at, d, f: base * 2.2, q: 2.5, g: scale(g, 0.06), to: soft });
    }
  } },
  sparrowChirp: { len: 1.5, db: -10, build(k, t) {
    const count = 2 + Math.floor(Math.random() * 4), key = rand(3600, 5200);
    let at = t;
    for (let i = 0; i < count; i += 1) {
      const d = rand(0.045, 0.09), level = rand(0.55, 1);
      const hz: Points = Math.random() < 0.3 ? [[0, key * 0.8], [d * 0.5, key * 1.25], [d, key * 0.95]] : [[0, key * 1.3], [d * 0.4, key * 0.96], [d, key * 0.7]];
      chirp(k, at, d, hz, level, { mod: rand(80, 160), index: rand(200, 700) });
      chirp(k, at, d, scale(hz, 2), level * 0.18);
      at += d + rand(0.07, 0.2);
    }
  } },
  gullCry: { len: 4.2, db: -9, reach: 3, build(k, t) {
    const cries = 2 + Math.floor(Math.random() * 4), key = rand(950, 1250);
    let at = t;
    for (let i = 0; i < cries; i += 1) {
      const late = i / cries, d = rand(0.3, 0.46) * (1 + late * 0.5), top = key * (1.5 - late * 0.25);
      reed(k, at, d, [[0, key * 0.85], [d * 0.25, top], [d * 0.6, top * 0.92], [d, key * 0.7]], [[2100, 1.4, 1], [3300, 2, 0.5], [1150, 1, 0.4]], 1 - late * 0.3, { rough: 0.05, rate: rand(40, 70) });
      at += d + rand(0.1, 0.2) * (1 + late);
    }
  } },
  crowCaw: { len: 1.6, db: -9, reach: 4, build(k, t) {
    const caws = 1 + Math.floor(Math.random() * 3), key = rand(400, 480);
    for (let i = 0; i < caws; i += 1) {
      const at = t + i * rand(0.42, 0.5), d = rand(0.26, 0.36);
      reed(k, at, d, [[0, key * 1.1], [d * 0.3, key * 1.18], [d, key * 0.82]], [[1200, 2.5, 1], [2100, 3, 0.6], [650, 2, 0.5]], 1, { rough: 0.2, rate: rand(55, 75), chatter: 0.3 });
      noise(k, { src: "pink", t: at, d, f: 1600, q: 1, g: [[0, 0], [d * 0.2, 0.22], [d, 0]] });
    }
  } },
  chickenCluck: { len: 2.1, db: -12, build(k, t) {
    const clucks = 2 + Math.floor(Math.random() * 4), key = rand(420, 560);
    let at = t;
    for (let i = 0; i < clucks; i += 1) {
      const d = rand(0.05, 0.085);
      reed(k, at, d, [[0, key * 0.8], [d * 0.6, key * 1.3], [d, key * 1.1]], [[1100, 3, 1], [2400, 4, 0.5]], rand(0.6, 1), { rough: 0.06 });
      at += d + rand(0.12, 0.38);
    }
  } },
  chickenSquawk: { len: 1.7, db: -11, build(k, t) {
    const key = rand(440, 540);
    let at = t;
    for (let i = 0; i < 2 + Math.floor(Math.random() * 2); i += 1) {
      reed(k, at, 0.07, [[0, key * 0.8], [0.04, key * 1.3], [0.07, key * 1.1]], [[1100, 3, 1], [2400, 4, 0.5]], 0.6, { rough: 0.06 });
      at += rand(0.14, 0.22);
    }
    const d = rand(0.4, 0.55);
    reed(k, at, d, [[0, key], [d * 0.35, key * 2.1], [d * 0.7, key * 1.9], [d, key * 1.2]], [[1300, 2.5, 1], [2600, 3, 0.7]], 1, { rough: 0.12, rate: 45, chatter: 0.2 });
  } },
  dogBarkFar: { len: 2.6, db: -11, reach: 8, build(k, t) {
    const barks = 2 + Math.floor(Math.random() * 3), key = rand(210, 290), far = faraway(k, 1700, rand(0.22, 0.34));
    let at = t;
    for (let i = 0; i < barks; i += 1) {
      const d = rand(0.14, 0.2);
      reed(k, at, d, [[0, key * 1.25], [d * 0.25, key * 1.4], [d, key * 0.75]], [[520, 2, 1], [1150, 2.5, 0.7]], rand(0.7, 1), { rough: 0.18, rate: rand(38, 55), to: far });
      puff(k, at, "pink", "bandpass", 900, 1, 0.03, 0.5, far);
      at += d + (i === 1 ? rand(0.5, 0.8) : rand(0.22, 0.4));
    }
  } },
  swiftScream: { len: 2.6, db: -15, reach: 3, build(k, t) {
    let at = t;
    for (let i = 0; i < 1 + Math.floor(Math.random() * 3); i += 1) {
      const d = rand(0.35, 0.7);
      chirp(k, at, d, [[0, rand(6200, 7200)], [d * 0.3, 6600], [d, rand(4800, 5600)]], rand(0.6, 1), { mod: rand(38, 52), index: 480 });
      at += d + rand(0.08, 0.25);
    }
  } },

  // ---- Wind and things it moves ----
  windGust: { len: 5, db: -14, reach: 3, gap: 2.5, build(k, t) {
    const body = noise(k, { src: "pink", t, d: 4.9, f: [[0, 320], [1.4, rand(650, 950)], [2.4, 520], [4.8, 280]], q: 1.4, g: [[0, 0], [1.3, 1], [2.2, 0.7], [4.8, 0]] });
    wobble(k, body.volume.gain, t, 4.9, 5, 0.12);
    noise(k, { src: "pink", t, d: 4.9, type: "highpass", f: 2500, g: [[0, 0], [1.5, 0.1], [4.5, 0]] });
    noise(k, { t, d: 4.9, f: [[0, 1200], [1.5, rand(1500, 2100)], [4.8, 1100]], q: 14, g: [[0, 0], [1.4, 0.1], [3, 0.04], [4.8, 0]] });
  } },
  clothSnap: { len: 1, db: -10, build(k, t) {
    let at = t;
    for (let i = 0; i < 2 + Math.floor(Math.random() * 3); i += 1) {
      const level = rand(0.5, 1);
      noise(k, { src: "pink", t: at, d: 0.11, type: "lowpass", f: [[0, 900], [0.06, 300]], g: [[0, 0], [0.004, level], [0.1, 0]], exp: true });
      puff(k, at, "white", "highpass", 2800, 0.7, 0.02, level * 0.45);
      at += rand(0.09, 0.2);
    }
  } },
  leafRustle: { len: 2.4, db: -12, build(k, t) {
    const leaves = noise(k, { src: "crackle", t, d: 2.3, rate: 1.6, f: rand(3500, 6000), q: 0.8, g: [[0, 0], [0.5, 1], [1.2, 0.6], [2.3, 0]] });
    wobble(k, leaves.volume.gain, t, 2.3, 9, 0.35);
    const air = noise(k, { src: "pink", t, d: 2.3, type: "highpass", f: 2200, g: [[0, 0], [0.6, 0.3], [2.3, 0]] });
    wobble(k, air.volume.gain, t, 2.3, 6, 0.12);
  } },
  chimeTinkle: { len: 4.6, db: -12, build(k, t) {
    const base = rand(1250, 1700), tubes = [1, 1.19, 1.41, 1.68, 1.88];
    let at = t;
    for (let i = 0; i < 3 + Math.floor(Math.random() * 5); i += 1) {
      const hz = base * pick(tubes), level = rand(0.3, 1);
      ring(k, at, hz, [[1, level, 1.6], [2.76, level * 0.45, 0.7], [5.4, level * 0.2, 0.3]]);
      puff(k, at, "white", "bandpass", 5200, 1.5, 0.004, level * 0.3);
      at += rand(0.06, 0.45);
    }
  } },
  ropeClank: { len: 1, db: -10, build(k, t) {
    const base = rand(950, 1400);
    let at = t;
    for (let i = 0; i < 1 + Math.floor(Math.random() * 3); i += 1) {
      const level = i ? rand(0.35, 0.7) : 1;
      ring(k, at, base * rand(0.97, 1.03), [[1, level, 0.22], [2.32, level * 0.5, 0.14], [3.85, level * 0.3, 0.09], [0.31, level * 0.5, 0.12]]);
      puff(k, at, "white", "bandpass", 3000, 1.5, 0.008, level * 0.5);
      at += rand(0.1, 0.28);
    }
  } },
  shutterCreak: { len: 1.4, db: -12, build(k, t) {
    const d = rand(0.5, 0.9);
    reed(k, t, d, [[0, rand(140, 165)], [d * 0.6, 230], [d, 190]], [[820, 6, 1], [1900, 8, 0.6], [3100, 9, 0.3]], 1, { jitter: 0.07, chatter: 0.45 });
    if (Math.random() < 0.5) { puff(k, t + d + 0.05, "pink", "lowpass", 420, 0.7, 0.05, 0.6); thud(k, t + d + 0.05, 120, 80, 0.06, 0.4); }
  } },
  signCreak: { len: 2.2, db: -11, build(k, t) {
    const d = rand(0.35, 0.5), low = rand(480, 560), back = t + rand(0.8, 1.1);
    reed(k, t, d, [[0, low], [d, low * 1.45]], [[1500, 10, 1], [2900, 12, 0.6]], 1, { jitter: 0.05, chatter: 0.4 });
    reed(k, back, d, [[0, low * 1.4], [d, low * 0.96]], [[1500, 10, 1], [2900, 12, 0.6]], 0.7, { jitter: 0.05, chatter: 0.4 });
    ring(k, t + d + rand(0.05, 0.2), rand(2900, 3600), [[1, 0.15, 0.08], [1.7, 0.08, 0.05]]);
  } },
  metalCreak: { len: 1.2, db: -11, build(k, t) {
    ring(k, t, rand(1300, 2600), [[1, 1, 0.09], [2.71, 0.6, 0.06], [4.4, 0.3, 0.04]]);
    puff(k, t, "white", "bandpass", 3600, 1.2, 0.004, 0.5);
    if (Math.random() < 0.6) {
      const d = rand(0.3, 0.6);
      reed(k, t + 0.04, d, [[0, rand(110, 170)], [d, rand(150, 240)]], [[430, 5, 1], [1150, 7, 0.5]], 0.45, { jitter: 0.08, chatter: 0.5 });
      if (Math.random() < 0.5) ring(k, t + d + 0.08, rand(1500, 2800), [[1, 0.5, 0.07], [2.6, 0.3, 0.04]]);
    }
  } },

  // ---- Water and weather ----
  drip: { len: 0.45, db: -11, gap: 0.12, build(k, t) {
    const hz = rand(650, 1500);
    blip(k, t, hz, 1);
    puff(k, t, "white", "highpass", 3500, 0.7, 0.025, 0.2);
    if (Math.random() < 0.6) blip(k, t + rand(0.1, 0.22), hz * 1.4, 0.3);
  } },
  splash: { len: 1.4, db: -10, build(k, t) {
    noise(k, { t, d: 1.2, f: [[0, 700], [0.08, 2600], [0.9, 1200]], q: 0.8, g: [[0, 0], [0.012, 1], [0.25, 0.3], [1.1, 0]], exp: true });
    puff(k, t, "pink", "lowpass", 500, 0.7, 0.3, 0.8);
    for (let i = 0; i < 4 + Math.floor(Math.random() * 5); i += 1) blip(k, t + rand(0.15, 0.95), rand(900, 2400), rand(0.1, 0.3));
  } },
  waveSlap: { len: 2.4, db: -10, reach: 2, gap: 0.8, build(k, t) {
    noise(k, { src: "pink", t, d: 1.3, type: "lowpass", f: [[0, 180], [0.1, 420], [0.9, 160]], g: [[0, 0], [0.07, 1], [0.3, 0.5], [1.2, 0]] });
    noise(k, { src: "pink", t, d: 2.3, f: [[0, 900], [0.25, rand(1800, 2600)], [1.8, 900]], q: 0.7, g: [[0, 0], [0.2, 0.5], [0.6, 0.3], [2.2, 0]] });
    for (let i = 0; i < 2 + Math.floor(Math.random() * 4); i += 1) blip(k, t + rand(0.3, 1.6), rand(280, 700), rand(0.12, 0.28));
  } },
  icicleDrop: { len: 1.1, db: -11, build(k, t) {
    ring(k, t, rand(2600, 3800), [[1, 1, 0.12], [1.73, 0.6, 0.08], [2.9, 0.4, 0.05]]);
    const land = t + rand(0.25, 0.45);
    for (let i = 0; i < 4 + Math.floor(Math.random() * 5); i += 1) {
      const level = rand(0.2, 0.7), decay = rand(0.03, 0.08);
      ring(k, land + rand(0, 0.12), rand(3000, 6500), [[1, level, decay], [1.9, level * 0.4, decay * 0.6]]);
    }
    puff(k, land, "brown", "lowpass", 220, 0.7, 0.14, 0.7);
  } },
  snowSlide: { len: 3.2, db: -12, reach: 2, build(k, t) {
    noise(k, { src: "pink", t, d: 3.1, f: [[0, 900], [1.2, 520], [2.6, 260]], q: 0.8, g: [[0, 0], [0.7, 0.8], [1.5, 1], [2.2, 0.4], [3, 0]] });
    noise(k, { src: "crackle", t, d: 3.1, f: 2500, q: 0.7, g: [[0, 0], [0.8, 0.5], [2.2, 0.2], [3, 0]] });
    const land = t + rand(1.7, 2.1);
    thud(k, land, 90, 45, 0.3, 0.9);
    puff(k, land, "brown", "lowpass", 300, 0.7, 0.25, 0.8);
  } },

  // ---- Trains and stations ----
  trainPass: { len: 12, db: -14, reach: 15, gap: 8, glide: true, build(k, t) {
    noise(k, { src: "brown", t, d: 11.9, type: "lowpass", f: [[0, 90], [5, 240], [7, 240], [11.9, 90]], g: [[0, 0], [4.5, 1], [7.5, 1], [11.8, 0]] });
    noise(k, { src: "pink", t, d: 11.9, f: [[0, 300], [5.5, 650], [11.8, 280]], q: 0.6, g: [[0, 0], [5, 0.45], [7, 0.45], [11.8, 0]] });
    const beat = rand(0.38, 0.5);
    for (let at = 1.5; at < 10.5; at += beat) {
      const level = Math.sin(((at - 1.5) / 9) * Math.PI) ** 1.5 * 0.9;
      for (const lag of [0, 0.085]) { puff(k, t + at + lag, "brown", "lowpass", 360, 0.7, 0.07, level); puff(k, t + at + lag, "white", "bandpass", 2400, 2, 0.012, level * 0.12); }
    }
    tone(k, { t, d: 11.9, f: [[0, 420], [5, 560], [7, 540], [11.9, 330]], g: [[0, 0], [5, 0.04], [7, 0.04], [11.8, 0]] });
    const squeal = noise(k, { t, d: 9, f: rand(2600, 3200), q: 18, g: [[0, 0], [5, 0.03], [6.5, 0.06], [8.9, 0]] });
    wobble(k, squeal.volume.gain, t, 9, 4, 0.03);
  } },
  trainBrake: { len: 3.2, db: -17, reach: 10, gap: 2, build(k, t) {
    const base = rand(1900, 2400);
    for (const [ratio, level] of [[1, 1], [1.61, 0.6], [2.27, 0.35]]) {
      const hz = base * ratio;
      const note = tone(k, { t, d: 2.5, f: [[0, hz * 1.04], [1.6, hz], [2.4, hz * 0.93]], g: [[0, 0], [0.4, level], [1.6, level * 0.8], [2.4, 0]] });
      wobble(k, note.volume.gain, t, 2.5, 30, level * 0.3);
      wobble(k, note.osc.frequency, t, 2.5, 6, hz * 0.01);
    }
    noise(k, { src: "pink", t, d: 2.7, f: 420, q: 2, g: [[0, 0], [0.5, 0.3], [2.2, 0.2], [2.6, 0]] });
    puff(k, t + 2.3, "white", "highpass", 3000, 0.7, 0.6, 0.5);
  } },
  trainDoors: { len: 2.2, db: -12, reach: 2, gap: 1.5, build(k, t) {
    const speaker = biquad(k, "lowpass", 3000, 0.7);
    speaker.connect(k.out);
    for (let i = 0; i < 3; i += 1) tone(k, { t: t + i * 0.22, d: 0.12, type: "triangle", f: 1650, g: [[0, 0], [0.008, 0.22], [0.1, 0.22], [0.115, 0]], to: speaker });
    puff(k, t + 0.75, "white", "bandpass", 4200, 0.8, 0.3, 0.45);
    noise(k, { src: "pink", t: t + 0.85, d: 0.8, f: [[0, 260], [0.7, 420]], q: 1.5, g: [[0, 0], [0.1, 0.6], [0.65, 0.5], [0.75, 0]] });
    thud(k, t + 1.62, 110, 60, 0.18, 1);
    puff(k, t + 1.62, "pink", "bandpass", 700, 1.2, 0.06, 0.6);
    ring(k, t + 1.63, 900, [[1, 0.2, 0.12], [2.4, 0.1, 0.07]]);
  } },
  paChime: { len: 3.2, db: -15, reach: 4, gap: 3, takes: 1, build(k, t) {
    const first = rand(620, 700), speaker = biquad(k, "bandpass", 1400, 0.5);
    speaker.connect(k.out);
    for (const [at, hz] of [[0, first], [0.62, first * 0.794]]) ring(k, t + at, hz, [[1, 1, 1.6], [2, 0.35, 1], [3, 0.15, 0.6], [4.2, 0.08, 0.3]], speaker, 0.006);
  } },
  paTone: { len: 3.5, db: -18, reach: 4, gap: 3, takes: 1, build(k, t) {
    const hz = rand(430, 500), speaker = biquad(k, "bandpass", 1300, 0.5), g: Points = [[0, 0], [0.5, 1], [2.2, 0.9], [3.3, 0]];
    speaker.connect(k.out);
    for (const [ratio, level] of [[1, 1], [2, 0.2], [3, 0.08]]) {
      const note = tone(k, { t, d: 3.4, f: hz * ratio, g: scale(g, level), to: speaker });
      lfo(k, note.volume.gain, t, 3.4, 5, level * 0.08);
    }
  } },

  // ---- Harbour, airfield and street ----
  craneMotor: { len: 4.3, db: -14, reach: 5, gap: 3, build(k, t) {
    const top = rand(105, 125), dull = biquad(k, "lowpass", 1400, 0.6);
    dull.connect(k.out);
    tone(k, { t, d: 4.2, wave: harmonics(k.c, [1, 0.6, 0.5, 0.3, 0.25, 0.15, 0.12, 0.1, 0.2, 0.06]), f: [[0, 38], [0.7, top], [3.2, top * 0.98], [4, 40]], g: [[0, 0], [0.3, 0.8], [3.2, 0.8], [4.1, 0]], to: dull });
    tone(k, { t, d: 4.2, f: [[0, 400], [0.7, top * 10.6], [3.2, top * 10.4], [4, 420]], g: [[0, 0], [0.6, 0.07], [3.2, 0.07], [4, 0]] });
    noise(k, { src: "brown", t, d: 4.2, type: "lowpass", f: 220, g: [[0, 0], [0.5, 0.5], [3.3, 0.5], [4.1, 0]] });
    puff(k, t + 3.95, "pink", "bandpass", 600, 1.2, 0.07, 0.5);
  } },
  containerClang: { len: 2.6, db: -14, reach: 8, gap: 1, build(k, t) {
    const base = rand(160, 210);
    tone(k, { t, d: 1.2, f: [[0, rand(75, 95)], [0.6, 55]], g: [[0, 0], [0.006, 1], [1.1, 0]], exp: true });
    ring(k, t, base, [[1, 0.7, 1.6], [1.47, 0.5, 1.3], [2.09, 0.45, 1.1], [2.56, 0.3, 0.9], [3.3, 0.25, 0.7], [4.12, 0.2, 0.5], [5.3, 0.15, 0.4], [6.9, 0.1, 0.3]]);
    puff(k, t, "pink", "lowpass", 2500, 0.7, 0.09, 0.9);
    const again = t + rand(0.14, 0.22);
    ring(k, again, base * 1.31, [[1, 0.3, 0.7], [1.6, 0.2, 0.5], [2.7, 0.12, 0.3]]);
    puff(k, again, "pink", "lowpass", 1800, 0.7, 0.05, 0.35);
  } },
  shipHorn: { len: 5.6, db: -15, reach: 60, gap: 5, build(k, t) {
    const d = rand(2.4, 3.8), hz = rand(98, 128), far = faraway(k, 1100, 0.9, 0.22), wave = harmonics(k.c, [1, 0.8, 0.65, 0.5, 0.35, 0.25, 0.15, 0.1, 0.06]);
    for (const detune of [1, 1.007]) tone(k, { t, d: d + 0.8, wave, f: [[0, hz * detune * 0.97], [0.25, hz * detune], [d, hz * detune], [d + 0.5, hz * detune * 0.96]], g: [[0, 0], [0.3, 0.5], [d, 0.48], [d + 0.7, 0]], to: far });
    noise(k, { src: "pink", t, d: d + 0.7, f: 600, q: 0.8, g: [[0, 0], [0.3, 0.1], [d, 0.1], [d + 0.6, 0]], to: far });
  } },
  buoyBell: { len: 3.6, db: -14, reach: 12, gap: 1, takes: 1, build(k, t) {
    const base = rand(560, 700);
    let at = t;
    for (let i = 0; i < 1 + Math.floor(Math.random() * 2); i += 1) {
      const level = i ? 0.55 : 1;
      ring(k, at, base, [[1, level, 2.4], [1.006, level * 0.6, 2.2], [2.76, level * 0.5, 1.4], [5.4, level * 0.25, 0.7], [8.93, level * 0.1, 0.3]]);
      puff(k, at, "white", "bandpass", 2500, 1.2, 0.005, level * 0.4);
      at += rand(0.5, 1.1);
    }
  } },
  forkliftBeep: { len: 2.8, db: -15, reach: 3, gap: 2.6, build(k, t) {
    const hz = rand(1150, 1350), speaker = biquad(k, "lowpass", 3200, 0.7);
    speaker.connect(k.out);
    for (let i = 0; i < 3 + Math.floor(Math.random() * 2); i += 1) tone(k, { t: t + i * 0.72, d: 0.37, type: "triangle", f: hz, g: [[0, 0], [0.01, 1], [0.34, 1], [0.36, 0]], to: speaker });
  } },
  airWrench: { len: 1.5, db: -12, reach: 1.5, gap: 0.5, build(k, t) {
    const d = rand(0.45, 1), rate = rand(24, 32);
    for (let i = 0; i < d * rate; i += 1) {
      const at = t + 0.08 + i / rate;
      puff(k, at, "white", "bandpass", 1900, 1.2, 0.028, 1);
      ring(k, at, 2900, [[1, 0.3, 0.03], [1.9, 0.15, 0.02]]);
    }
    tone(k, { t, d: d + 0.2, type: "sawtooth", f: [[0, 300], [0.1, 620], [d, 680], [d + 0.15, 250]], g: [[0, 0], [0.05, 0.25], [d, 0.25], [d + 0.18, 0]], to: through(k, "bandpass", 1200, 1) });
    noise(k, { t, d: d + 0.35, type: "highpass", f: 4000, g: [[0, 0], [0.03, 0.2], [d, 0.2], [d + 0.02, 0.35], [d + 0.3, 0]] });
  } },
  jetWhine: { len: 11, db: -10, reach: 80, gap: 8, glide: true, build(k, t) {
    const roar = noise(k, { src: "pink", t, d: 10.9, type: "lowpass", f: [[0, 300], [4.5, 1500], [6, 1100], [10.9, 250]], g: [[0, 0], [4.5, 1], [6.5, 0.8], [10.8, 0]] });
    wobble(k, roar.volume.gain, t, 10.9, 12, 0.1);
    noise(k, { src: "brown", t, d: 10.9, type: "lowpass", f: 150, g: [[0, 0], [5.5, 0.7], [10.8, 0]] });
    for (const ratio of [1, 1.52]) tone(k, { t, d: 10.5, f: [[0, 2900 * ratio], [4.5, 2700 * ratio], [5.5, 2100 * ratio], [10.5, 1950 * ratio]], g: [[0, 0], [3.5, 0.03 / ratio], [5, 0.045 / ratio], [7, 0.01], [10, 0]] });
  } },
  propPass: { len: 9, db: -14, reach: 30, gap: 6, glide: true, build(k, t) {
    const blade = rand(92, 108), wave = harmonics(k.c, [1, 0.9, 0.7, 0.55, 0.4, 0.3, 0.2, 0.15, 0.1, 0.08]), dull = biquad(k, "lowpass", 1600, 0.6);
    dull.connect(k.out);
    for (const [detune, level] of [[1, 1], [1.012, 0.8]]) tone(k, { t, d: 8.9, wave, f: [[0, blade * detune * 1.06], [4, blade * detune * 1.04], [5, blade * detune * 0.94], [8.9, blade * detune * 0.92]], g: [[0, 0], [3.8, level * 0.5], [5, level * 0.45], [8.8, 0]], to: dull });
    tone(k, { t, d: 8.6, f: [[0, 3400], [4, 3300], [5, 2950], [8.6, 2900]], g: [[0, 0], [4, 0.025], [5.5, 0.015], [8.5, 0]] });
    noise(k, { src: "pink", t, d: 8.9, f: 500, q: 0.5, g: [[0, 0], [4.2, 0.35], [8.8, 0]] });
  } },
  heliPass: { len: 13, db: -13, reach: 30, gap: 9, glide: true, build(k, t) {
    const rotor = rand(17, 21), beat: Points = [[0, rotor * 1.03], [6, rotor * 1.01], [7.5, rotor * 0.98], [12.9, rotor * 0.97]], blades = pulse(k.c, 9);
    const thump = k.c.createGain(), slap = k.c.createGain();
    thump.gain.value = 0.15; slap.gain.value = 0.05;
    lfo(k, thump.gain, t, 12.9, beat, 1, blades);
    lfo(k, slap.gain, t, 12.9, beat, 0.6, blades);
    thump.connect(k.out); slap.connect(k.out);
    noise(k, { src: "brown", t, d: 12.9, type: "lowpass", f: 190, g: [[0, 0], [5.5, 1], [7.5, 1], [12.8, 0]], to: thump });
    noise(k, { src: "pink", t, d: 12.9, f: 620, q: 0.8, g: [[0, 0], [5, 0.3], [6.5, 0.5], [8, 0.25], [12.8, 0]], to: slap });
    tone(k, { t, d: 12.5, f: [[0, 1900], [6.5, 1840], [12.5, 1700]], g: [[0, 0], [6, 0.015], [12, 0]] });
    noise(k, { t, d: 12.5, f: 5200, q: 2, g: [[0, 0], [6.2, 0.025], [12, 0]] });
    tone(k, { t, d: 12.6, type: "sawtooth", f: scale(beat, 5.4), g: [[0, 0], [6, 0.07], [12.5, 0]], to: through(k, "bandpass", 500, 2) });
  } },
  sirenFar: { len: 11, db: -16, reach: 25, gap: 9, glide: true, build(k, t) {
    const far = faraway(k, 1500, 0.4, 0.25), mouth = biquad(k, "bandpass", 1050, 0.9);
    mouth.connect(far);
    const note = tone(k, { t, d: 10.9, type: "sawtooth", f: [[0, 930], [5, 915], [6.5, 880], [10.9, 865]], g: [[0, 0], [3.5, 0.8], [5.5, 1], [7.5, 0.7], [10.8, 0]], to: mouth });
    if (Math.random() < 0.5) lfo(k, note.osc.frequency, t, 10.9, rand(0.22, 0.3), 330);
    else {
      const low = rand(430, 470), step = rand(0.5, 0.6);
      note.osc.frequency.cancelScheduledValues(0);
      for (let i = 0; i * step < 11; i += 1) note.osc.frequency.setValueAtTime((i % 2 ? low : low * 1.335) * (i * step < 6 ? 1.02 : 0.98), t + i * step);
    }
  } },
  carPass: { len: 6, db: -15, reach: 10, gap: 2.5, glide: true, build(k, t) {
    noise(k, { src: "pink", t, d: 5.9, f: [[0, 600], [2.6, 1100], [3.2, 900], [5.9, 500]], q: 0.6, g: [[0, 0], [2.5, 1], [3.3, 0.8], [5.8, 0]] });
    tone(k, { t, d: 5.9, wave: harmonics(k.c, [1, 0.7, 0.5, 0.3, 0.2]), f: [[0, 86], [2.6, 84], [3.3, 76], [5.9, 74]], g: [[0, 0], [2.6, 0.3], [5.8, 0]], to: through(k, "lowpass", 600, 0.6) });
    noise(k, { src: "brown", t, d: 5.9, type: "lowpass", f: 200, g: [[0, 0], [2.7, 0.4], [5.8, 0]] });
  } },
  hornFar: { len: 1.9, db: -15, reach: 12, gap: 1, build(k, t) {
    const far = faraway(k, 1700, rand(0.25, 0.4), 0.22), mouth = biquad(k, "bandpass", 1900, 0.8), low = rand(400, 440);
    mouth.connect(far);
    const d = rand(0.22, 0.6), taps = Math.random() < 0.35 ? 2 : 1;
    for (let i = 0; i < taps; i += 1) for (const hz of [low, low * 1.26]) tone(k, { t: t + i * (d + 0.12), d: d + 0.06, type: "sawtooth", f: hz, g: [[0, 0], [0.015, 0.5], [d, 0.5], [d + 0.05, 0]], to: mouth });
  } },
  scooterPass: { len: 7, db: -14, reach: 6, gap: 4, glide: true, build(k, t) {
    const revs: Points = [[0, 88], [1.2, 118], [1.3, 96], [2.8, 128], [3.6, 112], [6.9, 98]], g: Points = [[0, 0], [2.6, 1], [3.6, 0.8], [6.8, 0]];
    const body = k.c.createGain();
    body.connect(biquad(k, "bandpass", 950, 1.2)).connect(k.out);
    body.connect(biquad(k, "bandpass", 2400, 2)).connect(amp(k, 0.4, k.out));
    const engine = tone(k, { t, d: 6.9, type: "sawtooth", f: revs, g, to: body });
    wobble(k, engine.volume.gain, t, 6.9, 14, 0.12);
    const fade = amp(k, 0, k.out);
    ramp(fade.gain, t, [[0, 0], [2.8, 1], [6.5, 0]]);
    const rasp = noise(k, { t, d: 6.9, f: 2800, q: 1, g: steady(0.03), to: fade });
    lfo(k, rasp.volume.gain, t, 6.9, revs, 0.2, pulse(k.c, 5));
  } },
  doorSlamFar: { len: 1.2, db: -13, reach: 6, gap: 0.6, build(k, t) {
    const far = faraway(k, 1200, rand(0.16, 0.24), 0.3);
    thud(k, t, 95, 52, 0.28, 1, far);
    puff(k, t, "pink", "lowpass", 500, 0.7, 0.09, 0.8, far);
    puff(k, t + 0.05, "white", "bandpass", 1800, 2, 0.02, 0.25, far);
  } },

  // ---- Plant and workshop ----
  steamHiss: { len: 2.6, db: -13, reach: 1.5, gap: 0.8, build(k, t) {
    const d = rand(0.7, 1.8);
    const jet = noise(k, { t, d: d + 0.75, type: "highpass", f: [[0, 1800], [0.08, 3800], [d, 3200], [d + 0.6, 1500]], g: [[0, 0], [0.05, 1], [d, 0.8], [d + 0.7, 0]] });
    wobble(k, jet.volume.gain, t, d + 0.75, 18, 0.1);
    noise(k, { src: "pink", t, d: d + 0.55, f: 950, q: 0.8, g: [[0, 0], [0.06, 0.35], [d, 0.25], [d + 0.5, 0]] });
  } },
  valveClunk: { len: 1, db: -11, reach: 1.5, build(k, t) {
    thud(k, t, 105, 58, 0.2, 1);
    puff(k, t, "pink", "bandpass", 420, 1.4, 0.07, 0.8);
    ring(k, t, rand(620, 780), [[1, 0.3, 0.25], [2.3, 0.15, 0.15], [3.7, 0.08, 0.1]]);
    puff(k, t + 0.14, "white", "highpass", 3200, 0.7, 0.22, 0.3);
  } },
  relayClack: { len: 0.3, db: -11, gap: 0.04, build(k, t) {
    puff(k, t, "white", "bandpass", rand(2100, 2700), 3, 0.012, 1);
    puff(k, t + rand(0.022, 0.045), "white", "bandpass", rand(1300, 1700), 3, 0.012, 0.7);
    thud(k, t, 190, 140, 0.04, 0.4);
  } },
  alarmBlip: { len: 1.3, db: -17, reach: 5, gap: 1, takes: 1, build(k, t) {
    const hz = rand(820, 980), far = faraway(k, 2200, 0.21, 0.2);
    for (let i = 0; i < 2 + Math.floor(Math.random() * 2); i += 1) tone(k, { t: t + i * 0.27, d: 0.16, type: "triangle", f: hz, g: [[0, 0], [0.012, 1], [0.13, 1], [0.15, 0]], to: far });
  } },
  sparkZap: { len: 0.6, db: -11, gap: 0.1, build(k, t) {
    const d = rand(0.15, 0.4);
    const arc = noise(k, { t, d, type: "highpass", f: 2500, g: [[0, 0], [0.003, 0.5], [d * 0.5, 0.3], [d, 0]] });
    lfo(k, arc.volume.gain, t, d, 100, 0.3, "square");
    for (let i = 0; i < 3 + Math.floor(Math.random() * 5); i += 1) puff(k, t + rand(0, d), "white", "bandpass", rand(3000, 7000), 1, 0.004, rand(0.4, 1));
    tone(k, { t, d, type: "sawtooth", f: 100, g: [[0, 0], [0.004, 0.2], [d, 0]], to: through(k, "bandpass", 800, 1) });
  } },
  neonBuzz: { len: 1.6, db: -13, reach: 2, gap: 1, build(k, t) {
    const flicker = k.c.createGain();
    flicker.gain.value = 0;
    flicker.connect(k.out);
    let at = 0;
    while (at < 1.3) {
      const on = rand(0.04, 0.3);
      flicker.gain.setValueAtTime(0, t + at);
      flicker.gain.linearRampToValueAtTime(1, t + at + 0.003);
      flicker.gain.setValueAtTime(1, t + at + on);
      flicker.gain.linearRampToValueAtTime(0, t + at + on + 0.004);
      ring(k, t + at, rand(3800, 4600), [[1, 0.12, 0.03]]);
      at += on + rand(0.02, 0.16);
    }
    const glass = biquad(k, "highpass", 1500, 0.7);
    glass.connect(biquad(k, "bandpass", 3200, 0.7)).connect(flicker);
    tone(k, { t, d: 1.5, type: "sawtooth", f: 100, g: steady(1), to: glass });
    const fizz = noise(k, { t, d: 1.5, type: "highpass", f: 5000, g: steady(0.2), to: flicker });
    lfo(k, fizz.volume.gain, t, 1.5, 100, 0.2, "square");
  } },
  tubeFlicker: { len: 0.8, db: -12, gap: 0.3, build(k, t) {
    puff(k, t, "white", "bandpass", 2600, 2, 0.006, 0.8);
    ring(k, t + 0.004, rand(2900, 3500), [[1, 1, 0.14], [1.83, 0.5, 0.09], [2.71, 0.25, 0.05]]);
    const d = rand(0.12, 0.3);
    tone(k, { t: t + 0.05, d: d + 0.04, type: "sawtooth", f: 100, g: [[0, 0], [0.01, 0.9], [d, 0.7], [d + 0.03, 0]], to: through(k, "bandpass", 2800, 0.8, amp(k, 0.3, k.out)) });
    if (Math.random() < 0.5) puff(k, t + d + 0.1, "white", "bandpass", 2400, 2, 0.006, 0.5);
  } },
  hammerClank: { len: 1.1, db: -9, reach: 3, gap: 0.12, build(k, t) {
    ring(k, t, rand(430, 700), [[1, 1, 0.5], [1.58, 0.7, 0.4], [2.24, 0.6, 0.32], [2.92, 0.45, 0.25], [3.46, 0.3, 0.2], [4.3, 0.25, 0.15], [5.1, 0.15, 0.1]]);
    puff(k, t, "white", "bandpass", 2600, 0.9, 0.018, 1);
    thud(k, t, 130, 80, 0.08, 0.6);
  } },
  chainRattle: { len: 1.9, db: -10, reach: 2, build(k, t) {
    for (let i = 0; i < 14 + Math.floor(Math.random() * 12); i += 1) {
      const along = Math.random() ** 1.6, at = t + along * 1.4, level = rand(0.3, 1) * (1 - 0.5 * along), decay = rand(0.03, 0.07);
      ring(k, at, rand(2200, 5200), [[1, level, decay], [1.47, level * 0.6, 0.04], [2.6, level * 0.3, 0.03]]);
      puff(k, at, "white", "bandpass", 4500, 1, 0.003, level * 0.5);
    }
  } },
  quenchHiss: { len: 3.4, db: -12, reach: 2, gap: 2, build(k, t) {
    const sizzle = noise(k, { t, d: 3.3, f: [[0, 2500], [0.1, 5200], [3, 3800]], q: 0.5, g: [[0, 0], [0.03, 1], [0.6, 0.45], [3.2, 0]], exp: true });
    wobble(k, sizzle.volume.gain, t, 3.3, 28, 0.2);
    noise(k, { src: "pink", t, d: 1.7, f: 1100, q: 0.8, g: [[0, 0], [0.04, 0.5], [1.6, 0]], exp: true });
    noise(k, { src: "crackle", t, d: 2.5, f: 3000, q: 0.7, g: [[0, 0], [0.05, 0.6], [2.4, 0]], exp: true });
    for (let i = 0; i < 6 + Math.floor(Math.random() * 7); i += 1) blip(k, t + rand(0.1, 1.8), rand(220, 520), 0.14);
  } },
  generatorCough: { len: 2, db: -11, reach: 2, gap: 2, build(k, t) {
    let at = t;
    const chuff = (level: number) => { thud(k, at, 85, 48, 0.11, level); puff(k, at, "brown", "lowpass", 380, 0.7, 0.09, level * 0.9); puff(k, at, "white", "bandpass", 1700, 2, 0.02, level * 0.2); };
    for (let i = 0; i < 3 + Math.floor(Math.random() * 3); i += 1) { chuff(rand(0.7, 1)); at += rand(0.1, 0.26); }
    for (let i = 0; i < 6; i += 1) { chuff(0.5 - i * 0.05); at += 0.1 - i * 0.008; }
  } },
  radioSquelch: { len: 1.8, db: -14, reach: 1.2, gap: 0.6, build(k, t) {
    const d = rand(0.3, 1.1), band = biquad(k, "bandpass", 1500, 0.6);
    band.connect(biquad(k, "highpass", 400, 0.7)).connect(k.out);
    const hash = noise(k, { t, d: d + 0.02, type: "lowpass", f: 6000, g: [[0, 0], [0.004, 1], [d, 0.9], [d + 0.01, 0]], to: band });
    wobble(k, hash.volume.gain, t, d, 40, 0.2);
    noise(k, { src: "crackle", t, d: d + 0.02, type: "lowpass", f: 6000, g: [[0, 0], [0.004, 1.2], [d, 1.2], [d + 0.01, 0]], to: band });
    tone(k, { t, d, f: [[0, rand(700, 1800)], [d, rand(700, 1800)]], g: [[0, 0], [0.01, 0.07], [d, 0]], to: band });
    puff(k, t + d, "white", "bandpass", 2600, 1.2, 0.07, 0.9);
    if (Math.random() < 0.4) tone(k, { t: t + d + 0.09, d: 0.1, f: rand(1050, 1350), g: [[0, 0], [0.005, 0.5], [0.085, 0.5], [0.095, 0]], to: band });
  } },
  potClink: { len: 0.9, db: -11, gap: 0.08, build(k, t) {
    ring(k, t, rand(640, 980), [[1, 1, 0.28], [1.012, 0.5, 0.25], [2.14, 0.55, 0.18], [3.42, 0.35, 0.12], [4.9, 0.2, 0.07]]);
    puff(k, t, "white", "bandpass", 3200, 1.2, 0.005, 0.5);
  } },
  copperTap: { len: 0.7, db: -12, gap: 0.08, build(k, t) {
    ring(k, t, rand(1150, 1600), [[1, 1, 0.42], [1.008, 0.6, 0.4], [2.32, 0.6, 0.3], [4.25, 0.35, 0.18], [6.63, 0.18, 0.1]]);
    puff(k, t, "white", "bandpass", 4200, 1.5, 0.004, 0.6);
    thud(k, t, 160, 110, 0.03, 0.2);
  } },
  cupClatter: { len: 1.3, db: -13, gap: 0.3, build(k, t) {
    const base = rand(2100, 3600);
    let at = t;
    for (let i = 0; i < 2 + Math.floor(Math.random() * 4); i += 1) {
      const level = rand(0.4, 1);
      ring(k, at, base * rand(0.8, 1.2), [[1, level, 0.07], [2.7, level * 0.5, 0.045], [5.2, level * 0.2, 0.03]]);
      puff(k, at, "white", "bandpass", 5000, 1.5, 0.003, level * 0.4);
      at += rand(0.05, 0.28);
    }
    noise(k, { src: "crackle", t, d: 0.25, f: 2500, q: 2, g: [[0, 0], [0.02, 0.5], [0.2, 0]] });
  } },
  bellToll: { len: 7, db: -13, reach: 14, gap: 1.5, takes: 1, build(k, t) {
    const prime = rand(250, 330);
    // Hum, prime, tierce, quint and nominal of a tuned bell, the low ones in close pairs so the tone rolls.
    ring(k, t, prime, [[0.5, 0.55, 6.5], [0.503, 0.3, 6.2], [1, 1, 4.6], [1.004, 0.5, 4.4], [1.19, 0.7, 3.4], [1.5, 0.45, 2.6], [2, 0.6, 2], [2.006, 0.3, 1.9], [2.51, 0.3, 1.4], [2.67, 0.22, 1.2], [3.01, 0.2, 1], [4.17, 0.15, 0.7], [5.43, 0.1, 0.5], [6.8, 0.06, 0.35]], undefined, 0.004);
    puff(k, t, "pink", "bandpass", prime * 4, 0.8, 0.03, 0.7);
  } },
  // ---- The second set of ranges ----
  // Thunder a valley away: no crack, only the roll, coming back once off the hills.
  thunderFar: { len: 9, db: -12, reach: 60, gap: 6, build(k, t) {
    const far = faraway(k, rand(260, 420), rand(0.5, 0.9), 0.45), d = rand(4.5, 7.5);
    const roll = noise(k, { src: "brown", t, d, type: "lowpass", f: [[0, 90], [0.5, 240], [d, 70]], g: [[0, 0], [0.35, 1], [1.2, 0.5], [2.2, 0.8], [d, 0]], to: far });
    wobble(k, roll.volume.gain, t, d, 5, 0.3);
    noise(k, { src: "pink", t: t + 0.1, d: 1.6, f: [[0, 700], [1.4, 220]], q: 0.6, g: [[0, 0], [0.05, 0.35], [1.5, 0]], exp: true, to: far });
    thud(k, t + 0.2, 60, 34, 1.4, 0.7, far);
  } },
  // A desk telephone: two bells a third apart under one clapper, in the double burst an exchange sends.
  phoneRing: { len: 1.5, db: -17, reach: 3, gap: 1.2, takes: 1, build(k, t) {
    const room = through(k, "lowpass", 4600);
    for (const burst of [0, 0.6]) {
      for (const [hz, level] of [[1330, 1], [1690, 0.7], [2660, 0.18], [3380, 0.1]]) {
        const bell = tone(k, { t: t + burst, d: 0.44, f: hz, g: [[0, 0], [0.008, level * 0.5], [0.38, level * 0.5], [0.44, 0]], to: room });
        lfo(k, bell.volume.gain, t + burst, 0.44, 22, level * 0.4, "square");
      }
      puff(k, t + burst, "white", "bandpass", 2400, 2, 0.4, 0.05, room);
    }
  } },
  // An escapement: one dry tick with a little of the case in it.
  clockTick: { len: 0.25, db: -19, reach: 2.5, gap: 0.3, build(k, t) {
    puff(k, t, "white", "bandpass", rand(3000, 3400), 6, 0.012, 1);
    ring(k, t, rand(1850, 1950), [[1, 0.25, 0.06], [2.7, 0.1, 0.035]]);
    thud(k, t, 300, 220, 0.03, 0.25);
  } },
};

// ---- Loops: the textures too rich to build live ---------------------------------------------------
// `tone` must be exactly periodic over `len` (frequencies that are whole multiples of 1 / len) and is
// used as rendered; `noise` runs a second longer and is cross-faded onto its own start.
type LoopSpec = { len: number; noise?: (k: Kit, d: number) => void; tone?: (k: Kit, d: number) => void };
const CROSS = 1;
const LOOP_RMS = 0.1;

/** Resonances that open and shut: water turning over. */
function burble(k: Kit, d: number, count: number, lo: number, hi: number, rate: number, duty: number, level: number) {
  for (let i = 0; i < count; i += 1) {
    const hz = rand(lo, hi);
    const bubble = noise(k, { t: 0, d, f: hz, q: rand(10, 18), g: steady(0) });
    gate(k, bubble.volume.gain, 0, d, rate * rand(0.7, 1.3), duty, level);
    wobble(k, bubble.band.frequency, 0, d, rate, hz * 0.3);
  }
}

const LOOPS = {
  // A furnace: the roar fluttering as the flame breathes, embers spitting.
  roar: { len: 11.3, noise(k, d) {
    const low = noise(k, { src: "brown", t: 0, d, type: "lowpass", f: 250, g: steady(1) });
    wobble(k, low.volume.gain, 0, d, 9, 0.35); wobble(k, low.band.frequency, 0, d, 1.5, 70);
    const mid = noise(k, { src: "pink", t: 0, d, f: 470, q: 0.7, g: steady(0.8) });
    wobble(k, mid.volume.gain, 0, d, 13, 0.3);
    const flame = noise(k, { src: "pink", t: 0, d, f: 1500, q: 0.6, g: steady(0.2) });
    wobble(k, flame.volume.gain, 0, d, 20, 0.1);
    noise(k, { src: "crackle", t: 0, d, f: 2300, q: 0.8, g: steady(0.3) });
  } },
  // Mains hum: 50 Hz and its harmonics, several in pairs a fraction of a hertz apart so they beat.
  hum: { len: 16, tone(k, d) {
    for (const [hz, level] of [[50, 0.5], [100, 0.6], [100.3125, 0.4], [150, 0.5], [149.75, 0.3], [200, 0.25], [250.1875, 0.22], [300, 0.2], [299.5625, 0.14], [350, 0.1], [400.0625, 0.08], [450.25, 0.07], [550, 0.05], [650.125, 0.03]]) tone(k, { t: 0, d, f: hz, g: steady(level) });
  } },
  // A discharge tube: harmonics of 100 Hz bunched around 3 kHz, and the fizz of the gas.
  buzz: { len: 8, tone(k, d) {
    tone(k, { t: 0, d, wave: harmonics(k.c, Array.from({ length: 70 }, (_, i) => 0.25 / (i + 1) + 0.7 * Math.exp(-((((i + 1) * 100 - 3300) / 1700) ** 2)))), f: 100, g: steady(1) });
  }, noise(k, d) {
    const fizz = noise(k, { src: "pink", t: 0, d, type: "highpass", f: 4200, g: steady(0.14) });
    lfo(k, fizz.volume.gain, 0, d, 100, 0.12, "square");
  } },
  // Cicadas: each a narrow band of noise chopped at its own rate, swelling and sinking on its own.
  cicada: { len: 12.7, noise(k, d) {
    for (let i = 0; i < 5; i += 1) {
      const swell = amp(k, 0.6, k.out);
      wobble(k, swell.gain, 0, d, 0.3, 0.35);
      const insect = noise(k, { t: 0, d, f: rand(4300, 7600), q: rand(7, 12), g: steady(0.25), to: swell });
      lfo(k, insect.volume.gain, 0, d, rand(42, 115), 0.75, pulse(k.c, 4));
    }
  } },
  // A fountain: spray, the pour into the basin and the water turning over.
  water: { len: 10.3, noise(k, d) {
    const spray = noise(k, { src: "pink", t: 0, d, f: 2600, q: 0.5, g: steady(0.4) });
    wobble(k, spray.volume.gain, 0, d, 3, 0.1);
    const pour = noise(k, { src: "pink", t: 0, d, f: 520, q: 0.7, g: steady(0.6) });
    wobble(k, pour.volume.gain, 0, d, 1.5, 0.18);
    burble(k, d, 6, 450, 1700, 11, 0.35, 1.5);
  } },
  // Harbour water against a wall: slow washes, a slosh now and then, hollow gurgles.
  lap: { len: 14.9, noise(k, d) {
    const wash = noise(k, { src: "pink", t: 0, d, f: 380, q: 0.6, g: steady(0.15) });
    gate(k, wash.volume.gain, 0, d, 0.4, 0.6, 1);
    const slosh = noise(k, { src: "pink", t: 0, d, f: 1500, q: 0.7, g: steady(0.04) });
    gate(k, slosh.volume.gain, 0, d, 0.55, 0.45, 0.6);
    burble(k, d, 3, 250, 700, 3, 0.25, 1.2);
  } },
  // A diesel set: firing strokes with every other one heavier, exhaust puffs, a rattling cover.
  gen: { len: 8, tone(k, d) {
    tone(k, { t: 0, d, wave: harmonics(k.c, [0.6, 0.7, 0.9, 0.6, 0.7, 0.45, 0.5, 0.35, 0.35, 0.25, 0.22, 0.2, 0.15, 0.15, 0.1, 0.1]), f: 25, g: steady(1) });
    tone(k, { t: 0, d, wave: harmonics(k.c, [0, 0, 1, 0, 0.6, 0, 0.4]), f: 12.5, g: steady(0.35) });
  }, noise(k, d) {
    const strokes = pulse(k.c, 6);
    const exhaust = noise(k, { src: "pink", t: 0, d, type: "lowpass", f: 420, g: steady(0.15) });
    lfo(k, exhaust.volume.gain, 0, d, 12.5, 1.1, strokes);
    wobble(k, exhaust.volume.gain, 0, d, 3, 0.1);
    const rattle = noise(k, { src: "crackle", t: 0, d, f: 1900, q: 1.5, g: steady(0.1) });
    lfo(k, rattle.volume.gain, 0, d, 25, 0.6, strokes);
    const tappets = noise(k, { t: 0, d, f: 3100, q: 2, g: steady(0.01) });
    lfo(k, tappets.volume.gain, 0, d, 25, 0.1, strokes);
    noise(k, { src: "pink", t: 0, d, f: 800, q: 0.5, g: steady(0.14) });
  } },
  // A fan set: blade-pass hum over a motor, and the air it moves.
  fan: { len: 12, tone(k, d) {
    tone(k, { t: 0, d, wave: harmonics(k.c, [0.6, 1, 0.4, 0.25, 0.1]), f: 87.5, g: steady(0.5) });
    tone(k, { t: 0, d, wave: harmonics(k.c, [1, 0.5]), f: 50, g: steady(0.2) });
    tone(k, { t: 0, d, f: 100.25, g: steady(0.12) });
  }, noise(k, d) {
    const air = noise(k, { src: "pink", t: 0, d, f: 620, q: 0.5, g: steady(0.6) });
    lfo(k, air.volume.gain, 0, d, 14.5, 0.07);
    noise(k, { src: "pink", t: 0, d, type: "highpass", f: 2500, g: steady(0.08) });
  } },
  // An escalator: the drive rumbling, the step chain ticking over its sprocket, a comb plate that squeaks.
  escalator: { len: 11, tone(k, d) {
    for (const [hz, level] of [[480 / 11, 0.5], [100, 0.3], [200, 0.12]]) tone(k, { t: 0, d, f: hz, g: steady(level) });
  }, noise(k, d) {
    const rumble = noise(k, { src: "brown", t: 0, d, type: "lowpass", f: 140, g: steady(0.8) });
    wobble(k, rumble.volume.gain, 0, d, 1.1, 0.15);
    const chain = noise(k, { t: 0, d, f: 1500, q: 3, g: steady(0.02) });
    lfo(k, chain.volume.gain, 0, d, 60 / 11, 0.3, pulse(k.c, 8));
    for (let i = 0; i < 5; i += 1) tone(k, { t: 0.9 + i * 2.75, d: 0.04, f: [[0, 2100], [0.03, 2300]], g: [[0, 0], [0.008, 0.05], [0.035, 0]] });
  } },
  // A film projector: the claw pulling down twenty-four frames a second, the motor under it, film over the gate.
  projector: { len: 10, tone(k, d) {
    for (const [hz, level] of [[24, 0.25], [48, 0.35], [96, 0.3], [144.1, 0.12]]) tone(k, { t: 0, d, f: hz, g: steady(level) });
  }, noise(k, d) {
    const claw = pulse(k.c, 10);
    const clatter = noise(k, { t: 0, d, f: 2400, q: 1.2, g: steady(0.02) });
    lfo(k, clatter.volume.gain, 0, d, 24, 0.5, claw);
    const body = noise(k, { src: "pink", t: 0, d, f: 700, q: 1, g: steady(0.05) });
    lfo(k, body.volume.gain, 0, d, 24, 0.35, claw);
    const film = noise(k, { t: 0, d, type: "highpass", f: 5200, g: steady(0.05) });
    wobble(k, film.volume.gain, 0, d, 2, 0.02);
  } },
} satisfies Record<string, LoopSpec>;
type LoopName = keyof typeof LOOPS;

// ---- Footsteps ------------------------------------------------------------------------------------
type Ground = "concrete" | "sand" | "cobble" | "steel" | "felt" | "tile" | "tarmac" | "flags" | "snow";
const STEP_LENGTH = 0.5;
/** A heel, then the ball of the foot: `db` is the peak of a walking step. */
const STEPS: Record<Ground, { db: number; build: (k: Kit, t: number) => void }> = {
  concrete: { db: -20, build(k, t) {
    const toe = t + rand(0.07, 0.1);
    thud(k, t, rand(150, 175), 85, 0.07, 0.035); puff(k, t, "pink", "bandpass", 1100, 1, 0.03, 0.5);
    puff(k, toe, "pink", "bandpass", 1700, 0.8, 0.045, 0.22);
    noise(k, { src: "crackle", t: toe, d: 0.14, f: 3500, q: 0.8, g: [[0, 0], [0.02, 0.2], [0.12, 0]] });
  } },
  tarmac: { db: -21, build(k, t) {
    const toe = t + rand(0.07, 0.1);
    thud(k, t, rand(120, 145), 70, 0.08, 0.04); puff(k, t, "pink", "bandpass", 850, 0.9, 0.035, 0.45);
    puff(k, toe, "pink", "bandpass", 1400, 0.8, 0.05, 0.2);
    noise(k, { src: "crackle", t, d: 0.2, f: 2800, q: 0.7, g: [[0, 0], [0.03, 0.3], [0.19, 0]] });
  } },
  sand: { db: -22, build(k, t) {
    noise(k, { src: "pink", t, d: 0.22, f: rand(850, 1050), q: 0.6, g: [[0, 0], [0.018, 1], [0.06, 0.5], [0.2, 0]] });
    noise(k, { src: "crackle", t, d: 0.24, f: 2400, q: 0.7, g: [[0, 0], [0.03, 0.9], [0.22, 0]] });
    thud(k, t, rand(100, 120), 60, 0.08, 0.03);
  } },
  cobble: { db: -20, build(k, t) {
    const toe = t + rand(0.07, 0.1);
    puff(k, t, "pink", "bandpass", rand(1350, 1650), 1.6, 0.025, 0.9); thud(k, t, rand(170, 200), 100, 0.05, 0.05);
    noise(k, { t, d: 0.1, type: "highpass", f: 4500, g: [[0, 0], [0.01, 0.07], [0.09, 0]] });
    puff(k, toe, "pink", "bandpass", 2100, 1.2, 0.03, 0.3);
    noise(k, { t: toe, d: 0.08, type: "highpass", f: 5200, g: [[0, 0], [0.008, 0.045], [0.07, 0]] });
  } },
  steel: { db: -21, build(k, t) {
    thud(k, t, rand(130, 150), 80, 0.05, 0.04); puff(k, t, "white", "bandpass", 2000, 1.2, 0.02, 0.5);
    ring(k, t, rand(280, 360), [[1, 0.5, 0.22], [1.59, 0.4, 0.18], [2.71, 0.3, 0.14], [3.93, 0.2, 0.1], [5.5, 0.12, 0.07]]);
    ring(k, t + rand(0.07, 0.1), rand(2100, 2600), [[1, 0.1, 0.05]]);
  } },
  felt: { db: -22, build(k, t) {
    const toe = t + rand(0.08, 0.11);
    thud(k, t, rand(110, 130), 65, 0.08, 0.06); puff(k, t, "pink", "bandpass", 700, 0.7, 0.05, 0.4);
    noise(k, { src: "crackle", t, d: 0.18, f: 4200, q: 0.8, g: [[0, 0], [0.015, 0.7], [0.16, 0]] });
    noise(k, { src: "crackle", t: toe, d: 0.12, f: 3600, q: 0.8, g: [[0, 0], [0.01, 0.4], [0.1, 0]] });
  } },
  tile: { db: -20, build(k, t) {
    puff(k, t, "white", "bandpass", rand(2200, 2600), 2, 0.012, 1.2); puff(k, t, "pink", "bandpass", 900, 1.5, 0.03, 0.8); thud(k, t, rand(190, 220), 120, 0.04, 0.022);
    puff(k, t + rand(0.07, 0.1), "white", "bandpass", 3000, 2, 0.012, 0.3);
    if (Math.random() < 0.15) tone(k, { t: t + 0.03, d: 0.07, f: [[0, 1700], [0.06, 2100]], g: [[0, 0], [0.01, 0.1], [0.06, 0]] });
  } },
  flags: { db: -20, build(k, t) {
    puff(k, t, "pink", "bandpass", rand(640, 760), 1.4, 0.035, 1); thud(k, t, rand(160, 185), 95, 0.05, 0.05); puff(k, t, "white", "bandpass", 1900, 1.2, 0.015, 0.5);
    noise(k, { src: "pink", t: t + rand(0.07, 0.1), d: 0.12, f: 2400, q: 0.7, g: [[0, 0], [0.02, 0.2], [0.1, 0]] });
  } },
  snow: { db: -21, build(k, t) {
    noise(k, { src: "crackle", t, d: 0.32, rate: 0.7, f: 1300, q: 1.1, g: [[0, 0], [0.02, 1.4], [0.12, 1], [0.3, 0]] });
    const squeak = noise(k, { src: "pink", t, d: 0.3, f: [[0, 1700], [0.25, 800]], q: 1.5, g: [[0, 0], [0.03, 0.6], [0.28, 0]] });
    wobble(k, squeak.volume.gain, t, 0.3, 35, 0.3);
    thud(k, t, rand(95, 110), 55, 0.12, 0.04);
    noise(k, { src: "crackle", t: t + rand(0.11, 0.14), d: 0.2, rate: 0.8, f: 1700, q: 1, g: [[0, 0], [0.02, 0.6], [0.18, 0]] });
  } },
};

// ---- Rendering ahead of time ------------------------------------------------------------------------
async function render(seconds: number, build: (k: Kit) => void): Promise<Float32Array> {
  const context = new OfflineAudioContext(1, Math.ceil(RATE * seconds), RATE);
  build({ c: context, out: context.destination, n: noises() });
  return (await context.startRendering()).getChannelData(0);
}

function bufferOf(data: Float32Array, length = data.length) {
  const buffer = new AudioBuffer({ length: Math.max(1, length), sampleRate: RATE, numberOfChannels: 1 });
  buffer.getChannelData(0).set(data.subarray(0, length));
  return buffer;
}

/** Blocks DC, trims the silence off the end, fades the edges and brings the peak to full scale. */
function finishVoice(data: Float32Array): AudioBuffer | null {
  let before = 0, after = 0, peak = 0;
  for (let i = 0; i < data.length; i += 1) {
    const value = data[i] - before + 0.9975 * after;
    before = data[i]; after = value; data[i] = value;
    if (!(Math.abs(value) < 1e3)) return null;
    if (Math.abs(value) > peak) peak = Math.abs(value);
  }
  if (peak < 1e-6) return null;
  let end = data.length - 1;
  while (end > 0 && Math.abs(data[end]) < peak * 0.0005) end -= 1;
  const length = Math.min(data.length, end + Math.floor(RATE * 0.03)), fadeIn = 40, fadeOut = Math.min(length, 900);
  for (let i = 0; i < length; i += 1) data[i] *= (0.98 / peak) * Math.min(1, i / fadeIn, (length - 1 - i) / fadeOut);
  return bufferOf(data, length);
}

async function renderLoop(spec: LoopSpec): Promise<AudioBuffer | null> {
  const length = Math.round(RATE * spec.len), cross = Math.round(RATE * CROSS), out = new Float32Array(length);
  if (spec.noise) {
    const build = spec.noise, data = await render(spec.len + CROSS + 0.02, (k) => build(k, spec.len + CROSS + 0.02));
    out.set(data.subarray(0, length));
    for (let i = 0; i < cross; i += 1) {
      const turn = ((i / cross) * Math.PI) / 2;
      out[i] = data[i] * Math.sin(turn) + data[length + i] * Math.cos(turn);
    }
  }
  if (spec.tone) {
    const build = spec.tone, data = await render(spec.len, (k) => build(k, spec.len));
    for (let i = 0; i < length; i += 1) out[i] += data[i];
  }
  let mean = 0;
  for (let i = 0; i < length; i += 1) mean += out[i];
  mean /= length;
  let power = 0, peak = 0;
  for (let i = 0; i < length; i += 1) { out[i] -= mean; power += out[i] * out[i]; peak = Math.max(peak, Math.abs(out[i])); }
  if (!(peak < 1e3) || peak < 1e-6) return null;
  const level = Math.min(LOOP_RMS / Math.sqrt(power / length), 0.9 / peak);
  for (let i = 0; i < length; i += 1) out[i] *= level;
  return bufferOf(out);
}

export type SoundBank = {
  /** The takes of a voice, rendered on first request. Empty when rendering is not possible. */
  voice: (name: CueName) => Promise<AudioBuffer[]>;
  /** The takes if they are already rendered. */
  taken: (name: CueName) => AudioBuffer[] | null;
  loop: (name: LoopName) => Promise<AudioBuffer | null>;
  steps: (ground: Ground) => Promise<AudioBuffer[]>;
  stepsTaken: (ground: Ground) => AudioBuffer[] | null;
  /** Renders everything a map plays unprompted; resolves when all of it is ready. */
  prepare: (map: RangeMapId) => Promise<void>;
  dispose: () => void;
};

/** Renders voices, loops and footsteps one at a time, off the audio thread, and keeps them. */
export function createSoundBank(): SoundBank {
  let disposed = false;
  let queue: Promise<unknown> = Promise.resolve();
  const enqueue = <T>(fallback: T, job: () => Promise<T>): Promise<T> => {
    // A render that never comes back must not hold up everything queued behind it.
    const patient = () => Promise.race([job(), new Promise<T>((resolve) => { setTimeout(() => resolve(fallback), 12000); })]);
    const run = queue.then(() => (disposed || typeof OfflineAudioContext === "undefined" ? fallback : patient())).catch(() => fallback);
    queue = run;
    return run;
  };
  const takes = async (count: number, seconds: number, build: (k: Kit, t: number) => void) => {
    const list: AudioBuffer[] = [];
    for (let i = 0; i < count && !disposed; i += 1) {
      const take = finishVoice(await render(seconds + 0.05, (k) => build(k, 0.005)));
      if (take) list.push(take);
    }
    return list;
  };
  const voices = new Map<CueName, Promise<AudioBuffer[]>>(), voicesDone = new Map<CueName, AudioBuffer[]>();
  const loops = new Map<LoopName, Promise<AudioBuffer | null>>();
  const steps = new Map<Ground, Promise<AudioBuffer[]>>(), stepsDone = new Map<Ground, AudioBuffer[]>();

  const bank: SoundBank = {
    voice(name) {
      let pending = voices.get(name);
      if (!pending) {
        const spec = VOICES[name];
        pending = spec
          ? enqueue<AudioBuffer[]>([], async () => { const list = await takes(spec.takes ?? (spec.len > 1.6 ? 2 : 3), spec.len, spec.build); voicesDone.set(name, list); return list; })
          : Promise.resolve([]);
        voices.set(name, pending);
      }
      return pending;
    },
    taken: (name) => voicesDone.get(name) ?? null,
    loop(name) {
      let pending = loops.get(name);
      if (!pending) { pending = enqueue<AudioBuffer | null>(null, () => renderLoop(LOOPS[name])); loops.set(name, pending); }
      return pending;
    },
    steps(ground) {
      let pending = steps.get(ground);
      if (!pending) {
        pending = enqueue<AudioBuffer[]>([], async () => { const list = await takes(5, STEP_LENGTH, STEPS[ground].build); stepsDone.set(ground, list); return list; });
        steps.set(ground, pending);
      }
      return pending;
    },
    stepsTaken: (ground) => stepsDone.get(ground) ?? null,
    prepare(map) {
      const spec = MAPS[map], jobs: Array<Promise<unknown>> = [];
      for (const ground of spec.ground) jobs.push(bank.steps(ground));
      for (const bed of spec.beds) if (bed.src in LOOPS) jobs.push(bank.loop(bed.src as LoopName));
      for (const event of [...spec.events].sort((a, b) => a.every[0] - b.every[0])) {
        jobs.push(bank.voice(event.cue));
        if (event.then) jobs.push(bank.voice(event.then.cue));
      }
      for (const name of spec.own ?? []) jobs.push(bank.voice(name));
      return Promise.all(jobs).then(() => undefined);
    },
    dispose() {
      disposed = true;
      voices.clear(); voicesDone.clear(); loops.clear(); steps.clear(); stepsDone.clear();
    },
  };
  return bank;
}

// ---- Maps ---------------------------------------------------------------------------------------
type Group = "air" | "machine" | "life" | "dread";
type Band = {
  type?: BiquadFilterType; f: number; q?: number;
  /** The cutoff wanders this many octaves either way. */
  roam?: number;
  /** ... and climbs this many octaves at the top of a gust. */
  gustF?: number;
};
type Branch = {
  bands?: Band[];
  /** Level, dBFS RMS, heard from beside it (or everywhere, if it has no place). */
  db: number;
  /** Slow random walk of the level, ± dB. */
  sway?: number;
  /** Decibels gained at the top of a gust. */
  gust?: number;
  pan?: number;
  /** How far the pan wanders. */
  drift?: number;
  /** Fills the width instead of sitting at a point: the right ear hears it a few hundredths of a second late. */
  wide?: boolean;
  /** Where it is in the world, and how far it carries. */
  at?: [number, number];
  reach?: number;
  /** `life` falls silent at a shot and under dread; `machine` dims under dread; `air` rises. */
  group?: Group;
  /** A chorus that sings for [a, b] seconds and rests for [c, d]. */
  rests?: [number, number, number, number];
};
type Bed = Branch & {
  src: NoiseKind | LoopName;
  rate?: number;
  /** The playback rate hunts by this fraction: an engine that never quite holds its speed. */
  warp?: number;
  /** More filtered branches off the same source. */
  more?: Branch[];
};

/** Where a sound is: a place on the plan, a height above the ears, perhaps a second place it travels to. */
type Where = { x: number; z: number; h: number; x2?: number; z2?: number; muffle?: number };
const CENTRE = { x: 0, z: -8 };
/** One of these places (x, z, height), give or take half a metre. */
const spot = (...points: Array<[number, number, number?]>) => (): Where => {
  const [x, z, h = 0] = pick(points);
  return { x: x + rand(-0.5, 0.5), z: z + rand(-0.5, 0.5), h };
};
/** Somewhere on a ring round the range. Bearings: 0 is down-range, a quarter turn is to the right. */
const ring360 = (near: number, far: number, from = -Math.PI, to = Math.PI, h = 0) => (): Where => {
  const bearing = rand(from, to), distance = rand(near, far);
  return { x: CENTRE.x + Math.sin(bearing) * distance, z: CENTRE.z - Math.cos(bearing) * distance, h };
};
/** Behind one of the range's walls: heard through it. */
const beyond = (side: "left" | "right" | "back" | "far", near = 12, far = 30, muffle = 1100) => (): Where => {
  const out = rand(near, far);
  if (side === "left" || side === "right") return { x: (9 + out) * (side === "left" ? -1 : 1), z: rand(-26, 8), h: 0, muffle };
  return { x: rand(-12, 12), z: side === "back" ? 9 + out : -26 - out, h: 0, muffle };
};
/** Passing by: a straight line that comes no nearer than `near` .. `far` metres. */
const pass = (near: number, far: number, h = 0, muffle?: number) => (): Where => {
  const bearing = rand(-Math.PI, Math.PI), distance = rand(near, far), half = distance * 1.3 + 25, way = Math.random() < 0.5 ? -1 : 1;
  const nx = Math.sin(bearing), nz = -Math.cos(bearing), x = CENTRE.x + nx * distance, z = CENTRE.z + nz * distance;
  return { x: x + nz * half * way, z: z - nx * half * way, x2: x - nz * half * way, z2: z + nx * half * way, h, muffle };
};
/** In the air over the range. */
const above = (h: number, spread: number) => (): Where => ({ x: rand(-spread, spread), z: CENTRE.z + rand(-spread, spread), h });

type EventSpec = {
  cue: CueName;
  /** Seconds between one and the next. */
  every: [number, number];
  where: (() => Where) | null;
  /** Seconds before the first, if it should not be left to chance. */
  first?: [number, number];
  /** Decibels on top of the voice's own level. */
  db?: [number, number];
  pitch?: [number, number];
  /** Comes in runs of this many, this far apart. */
  run?: [number, number];
  gap?: [number, number];
  /** A run is one thing struck again (a bell, an anvil) unless this is set. */
  mixed?: boolean;
  group?: Group;
  /** Comes more often, and harder, in a gust. */
  gusty?: boolean;
  /** Followed by another sound from the same place. */
  then?: { cue: CueName; after: [number, number]; db?: number };
};
/** `own` lists the voices the map itself asks for, in step with what it shows: rendered ahead, and never fired from here at the same things. */
type MapSpec = { ground: Ground[]; own?: CueName[]; wind: number; beds: Bed[]; events: EventSpec[] };

const MAPS: Record<RangeMapId, MapSpec> = {
  // Sealed warehouse: the furnace on the east wall, ventilation overhead, a works beyond the walls.
  foundry: {
    ground: ["concrete"], wind: 0.1,
    own: ["alarmBlip", "chainRattle", "craneMotor", "drip", "hammerClank", "pigeonCoo", "quenchHiss", "sparkZap", "steamHiss", "tubeFlicker", "wingsFlush"],
    beds: [
      { src: "roar", at: [9.2, -11.6], reach: 2, db: -24, sway: 3, warp: 0.03, bands: [{ type: "lowpass", f: 2600, roam: 0.6 }], group: "machine" },
      { src: "brown", bands: [{ type: "lowpass", f: 140 }], db: -39, sway: 2, more: [{ bands: [{ f: 420, q: 1.6, roam: 0.35 }], db: -35, sway: 4, wide: true }] },
      { src: "pink", bands: [{ f: 900, q: 0.5, roam: 0.5 }], db: -37, sway: 4, wide: true },
      { src: "hum", db: -38, sway: 3, pan: -0.5, drift: 0.3, group: "machine" },
    ],
    events: [
      { cue: "hammerClank", every: [9, 22], where: beyond("left", 15, 40, 1600), run: [2, 6], gap: [0.32, 0.8], db: [-3, 1], first: [3, 9] },
      { cue: "chainRattle", every: [20, 45], where: beyond("far", 6, 20, 2400), db: [0, 3] },
      { cue: "metalCreak", every: [6, 16], where: spot([8.6, -10, 1], [8.6, -13.5, 2], [0, -12, 7], [-5, -4, 7], [4, -20, 7]) },
      { cue: "forkliftBeep", every: [35, 80], where: beyond("left", 10, 25, 1800), first: [16, 34] },
      { cue: "doorSlamFar", every: [45, 100], where: beyond("back", 10, 30) },
    ],
  },
  // Desert court at noon: dry gusts, cicadas that swell and stop, cloth and palms, a town beyond the walls.
  courtyard: {
    ground: ["sand"], wind: 0.7,
    own: ["chickenCluck", "chickenSquawk", "chimeTinkle", "clothSnap", "leafRustle", "pigeonCoo", "ropeClank", "shutterCreak", "signCreak", "sparrowChirp", "swiftScream", "windGust", "wingsFlush"],
    beds: [
      { src: "pink", bands: [{ f: 520, q: 0.9, roam: 0.35, gustF: 0.7 }], db: -36.5, gust: 9, sway: 2, pan: -0.35, drift: 0.3, more: [{ bands: [{ type: "highpass", f: 3200 }], db: -47.5, gust: 12, pan: 0.2 }] },
      { src: "pink", bands: [{ f: 310, q: 0.7, roam: 0.3, gustF: 0.5 }], db: -37.5, gust: 7, sway: 2, pan: 0.4, drift: 0.3 },
      { src: "cicada", db: -31.5, sway: 2, pan: -0.5, drift: 0.2, warp: 0.02, group: "life", rests: [9, 26, 3, 9] },
      { src: "cicada", rate: 1.09, db: -33.5, sway: 2, pan: 0.55, drift: 0.2, group: "life", rests: [7, 20, 4, 12] },
      { src: "brown", bands: [{ type: "lowpass", f: 160 }], db: -37.5, sway: 2 },
    ],
    events: [
      { cue: "dogBarkFar", every: [30, 80], where: ring360(50, 110), group: "life", first: [10, 30] },
      { cue: "windGust", every: [12, 26], where: ring360(8, 18) },
      { cue: "doorSlamFar", every: [60, 130], where: ring360(40, 80) },
      { cue: "scooterPass", every: [80, 170], where: pass(45, 80) },
    ],
  },
  // Reactor hall: mains hum that beats, coolant in the pipes, steam, relays, valves, a far alarm.
  reactor: {
    ground: ["steel", "concrete"], wind: 0.05,
    own: ["alarmBlip", "chainRattle", "craneMotor", "drip", "metalCreak", "relayClack", "sparrowChirp", "steamHiss", "valveClunk", "wingsFlush"],
    beds: [
      { src: "hum", db: -33.5, sway: 2, warp: 0.003, group: "machine", more: [{ bands: [{ type: "highpass", f: 190 }], db: -35.5, sway: 3, wide: true, group: "machine" }] },
      { src: "pink", bands: [{ f: 1500, q: 0.8, roam: 0.35 }], db: -36.5, sway: 4, pan: -0.45, drift: 0.3, group: "machine", more: [{ bands: [{ type: "lowpass", f: 260 }], db: -41.5, sway: 2, pan: -0.2, group: "machine" }] },
      { src: "water", rate: 0.8, bands: [{ type: "lowpass", f: 1400 }], db: -35.5, sway: 3, pan: 0.5, drift: 0.2, group: "machine" },
      { src: "brown", bands: [{ type: "lowpass", f: 110 }], db: -41.5, sway: 2, more: [{ bands: [{ f: 520, q: 0.6, roam: 0.4 }], db: -37.5, sway: 4, wide: true }] },
      { src: "fan", rate: 0.7, db: -38.5, sway: 2, pan: 0.15, drift: 0.4, warp: 0.004, group: "machine" },
    ],
    events: [
      { cue: "paTone", every: [50, 110], where: spot([0, -10, 9]), first: [20, 38] },
      { cue: "metalCreak", every: [10, 26], where: spot([-8, -8, 5], [8, -20, 6], [0, -26, 9], [4, 2, 8]) },
      { cue: "doorSlamFar", every: [60, 120], where: beyond("back", 10, 25) },
    ],
  },
  // Old-town square after rain: the wall fountain, gutters still running, the café, the tower bell.
  piazza: {
    ground: ["cobble"], wind: 0.35,
    own: ["bellToll", "chainRattle", "clothSnap", "drip", "leafRustle", "pigeonCoo", "shutterCreak", "splash", "wingsFlush"],
    beds: [
      { src: "water", at: [-9.2, -4.6], reach: 1.4, db: -24, sway: 2, warp: 0.03 },
      { src: "water", rate: 1.7, bands: [{ type: "highpass", f: 1800 }], at: [8.8, -15], reach: 1.1, db: -31, sway: 3 },
      { src: "pink", bands: [{ f: 600, q: 0.7, roam: 0.4, gustF: 0.5 }], db: -39, gust: 7, sway: 3, wide: true },
      { src: "brown", bands: [{ type: "lowpass", f: 190 }], db: -38, sway: 2, more: [{ bands: [{ f: 750, q: 0.5, roam: 0.3 }], db: -41, sway: 4, pan: -0.4, drift: 0.3 }] },
    ],
    events: [
      { cue: "swiftScream", every: [7, 18], where: above(20, 22), group: "life" },
      { cue: "sparrowChirp", every: [5, 12], where: spot([-9, 2, 5], [9, -20, 6], [-8, -24, 4]), group: "life" },
      { cue: "scooterPass", every: [35, 80], where: pass(22, 40, 0, 2200), first: [5, 20] },
      { cue: "cupClatter", every: [6, 15], where: spot([-8.4, 2, 0.6], [-8.3, 5.4, 0.6], [8.5, -3.4, 0.6]), group: "life" },
      { cue: "carPass", every: [18, 40], where: pass(50, 90) },
      { cue: "doorSlamFar", every: [55, 120], where: ring360(30, 60) },
    ],
  },
  // City rooftop at night: the roar of the streets below, wind over the parapet, the plant room, neon.
  rooftop: {
    ground: ["felt"], wind: 0.6,
    own: ["chainRattle", "clothSnap", "heliPass", "neonBuzz", "pigeonCoo", "steamHiss", "windGust", "wingsFlush"],
    beds: [
      { src: "brown", bands: [{ type: "lowpass", f: 240, roam: 0.25 }], db: -34.5, sway: 2, wide: true, more: [{ bands: [{ f: 620, q: 0.5, roam: 0.35 }], db: -34.5, sway: 3.5, wide: true }] },
      { src: "pink", bands: [{ f: 880, q: 1.6, roam: 0.4, gustF: 0.6 }], db: -39.5, gust: 10, sway: 2, pan: 0.2, drift: 0.5, more: [{ bands: [{ type: "highpass", f: 3800 }], db: -49.5, gust: 10 }] },
      { src: "fan", at: [-11, -12.6], reach: 2.5, db: -25.5, sway: 1.5, warp: 0.006, group: "machine" },
      { src: "buzz", at: [8.8, -10], reach: 0.7, db: -28.5, sway: 2, group: "machine" },
    ],
    events: [
      { cue: "sirenFar", every: [40, 90], where: pass(120, 260), first: [8, 22] },
      { cue: "hornFar", every: [8, 22], where: ring360(60, 160) },
      { cue: "carPass", every: [5, 12], where: pass(60, 120), db: [-5, -1] },
      { cue: "trainPass", every: [70, 140], where: pass(150, 250), pitch: [0.8, 0.9], db: [0, 3] },
      { cue: "doorSlamFar", every: [50, 100], where: ring360(30, 80) },
      { cue: "dogBarkFar", every: [60, 140], where: ring360(80, 150), group: "life" },
      { cue: "windGust", every: [12, 26], where: ring360(8, 18) },
      { cue: "signCreak", every: [20, 50], where: spot([8.6, -18, 3], [-8.6, -22, 3]), gusty: true, db: [1, 4] },
    ],
  },
  // Underground platform: ventilation, the hollow of the tunnels, tube lights, an escalator, trains elsewhere.
  metro: {
    ground: ["tile"], wind: 0.2,
    own: ["drip", "paChime", "pigeonCoo", "relayClack", "trainBrake", "trainDoors", "trainPass", "tubeFlicker", "windGust", "wingsFlush"],
    beds: [
      { src: "brown", bands: [{ type: "lowpass", f: 130 }], db: -38.5, sway: 2, more: [{ bands: [{ f: 265, q: 3, roam: 0.2 }], db: -36.5, sway: 3.5, pan: -0.3, drift: 0.3 }] },
      { src: "pink", bands: [{ f: 230, q: 4, roam: 0.35, gustF: 0.3 }], at: [0, -42], reach: 6, db: -27.5, gust: 5, sway: 3.5, more: [{ bands: [{ f: 610, q: 5, roam: 0.35 }], at: [0, -42], reach: 6, db: -32.5, gust: 5, sway: 4 }, { bands: [{ f: 1000, q: 0.5, roam: 0.4 }], db: -37.5, sway: 4, wide: true }] },
      { src: "buzz", db: -37.5, sway: 2, pan: 0.2, drift: 0.5, group: "machine" },
      { src: "escalator", at: [-7.5, 6.5], reach: 1.5, db: -27.5, sway: 1.5, warp: 0.004, group: "machine" },
      { src: "hum", db: -38.5, sway: 3, pan: 0.5, drift: 0.2, group: "machine" },
    ],
    events: [
      { cue: "metalCreak", every: [14, 36], where: spot([5, -28], [-5, -30]), db: [4, 8] },
      { cue: "doorSlamFar", every: [40, 90], where: beyond("back", 10, 30) },
    ],
  },
  // Container quay at dusk: water on the wall, gulls, the ship's generators, cranes, a buoy out in the channel.
  docks: {
    ground: ["tarmac"], wind: 0.65,
    own: ["buoyBell", "clothSnap", "containerClang", "craneMotor", "forkliftBeep", "gullCry", "ropeClank", "shipHorn", "waveSlap", "wingsFlush"],
    beds: [
      { src: "lap", at: [25, -8], reach: 4, db: -25, sway: 2.5, warp: 0.03 },
      { src: "pink", bands: [{ f: 560, q: 0.8, roam: 0.4, gustF: 0.6 }], db: -38, gust: 9, sway: 2, pan: -0.3, drift: 0.4, more: [{ bands: [{ type: "highpass", f: 3000 }], db: -50, gust: 10, pan: 0.3 }] },
      { src: "hum", rate: 0.62, at: [37.5, -6.6], reach: 8, db: -31, sway: 2, warp: 0.004, group: "machine" },
      { src: "brown", bands: [{ type: "lowpass", f: 150 }], db: -39, sway: 2, more: [{ bands: [{ f: 340, q: 0.8, roam: 0.35 }], db: -38, sway: 4, wide: true }] },
    ],
    events: [
      { cue: "windGust", every: [14, 28], where: ring360(8, 18), db: [-4, -1] },
      { cue: "chainRattle", every: [40, 85], where: spot([18.5, -8, 6]) },
      { cue: "containerClang", every: [35, 80], where: ring360(60, 120, -2.6, -0.3) },
    ],
  },
  // Hangar open to the apron at noon: big-room air, wind through the doors, a ground power unit, the airfield.
  hangar: {
    ground: ["concrete"], wind: 0.45,
    own: ["airWrench", "chainRattle", "clothSnap", "metalCreak", "pigeonCoo", "propPass", "swiftScream", "tubeFlicker", "windGust", "wingsFlush"],
    beds: [
      { src: "brown", bands: [{ type: "lowpass", f: 150, roam: 0.2 }], db: -38, sway: 2, more: [{ bands: [{ f: 380, q: 0.8, roam: 0.35 }], db: -35, sway: 3.5, wide: true }] },
      { src: "pink", bands: [{ f: 700, q: 0.9, roam: 0.4, gustF: 0.6 }], at: [0, -30], reach: 8, db: -30, gust: 8, sway: 2.5 },
      { src: "pink", bands: [{ f: 1100, q: 0.5, roam: 0.4 }], db: -38, sway: 4, wide: true },
      { src: "fan", rate: 1.15, at: [7, -14], reach: 1.5, db: -27, sway: 1.5, warp: 0.005, group: "machine" },
    ],
    events: [
      { cue: "radioSquelch", every: [14, 38], where: spot([7.8, 2, 1.2]) },
      { cue: "forkliftBeep", every: [40, 85], where: ring360(40, 70, -0.6, 0.6), db: [1, 4] },
      { cue: "jetWhine", every: [70, 150], where: pass(300, 700, 900), first: [20, 40] },
      { cue: "hammerClank", every: [18, 45], where: spot([-7, -18, 0.5], [6, -22, 0.5]), db: [-8, -3] },
      { cue: "metalCreak", every: [12, 30], where: spot([0, -10, 12], [-6, -20, 12], [6, 0, 12]) },
      { cue: "sparrowChirp", every: [7, 18], where: spot([-5, -6, 11], [6, -16, 11]), group: "life" },
      { cue: "doorSlamFar", every: [50, 110], where: beyond("back", 10, 25) },
    ],
  },
  // Covered market: air in the cloth overhead, a coppersmith, hens, sparrows in the rafters, the town at either end.
  bazaar: {
    ground: ["flags"], wind: 0.25,
    own: ["chainRattle", "chickenCluck", "chickenSquawk", "chimeTinkle", "clothSnap", "copperTap", "cupClatter", "potClink", "shutterCreak", "signCreak", "sparrowChirp", "windGust", "wingsFlush"],
    beds: [
      // No voices anywhere in these soundscapes: the street is told by the air moving through the cloth overhead,
      // the town beyond its two open ends, and the trades at work in it.
      { src: "pink", bands: [{ f: 640, q: 0.6, roam: 0.4, gustF: 0.4 }], db: -35.5, gust: 7, sway: 3.5, wide: true, more: [{ bands: [{ type: "highpass", f: 2600 }], db: -46, gust: 10, sway: 3, pan: -0.3, drift: 0.4 }] },
      { src: "pink", bands: [{ f: 380, q: 0.6, roam: 0.3 }], at: [0, -30], reach: 6, db: -36, sway: 3.5 },
      { src: "brown", bands: [{ type: "lowpass", f: 180 }], db: -39, sway: 2 },
    ],
    events: [
      { cue: "dogBarkFar", every: [60, 140], where: ring360(40, 90), group: "life" },
      { cue: "pigeonCoo", every: [14, 34], where: spot([0, -30, 7], [0, 12, 7]), group: "life", first: [6, 18] },
      { cue: "doorSlamFar", every: [45, 110], where: ring360(30, 60) },
      { cue: "scooterPass", every: [50, 120], where: pass(35, 70) },
    ],
  },
  // Alpine outpost in snow: wind that howls and drops, spindrift, the generator hut, a halyard on the mast.
  outpost: {
    ground: ["snow"], wind: 1,
    own: ["chickenCluck", "chickenSquawk", "clothSnap", "crowCaw", "generatorCough", "heliPass", "icicleDrop", "metalCreak", "radioSquelch", "snowSlide", "windGust", "wingsFlush"],
    beds: [
      { src: "pink", bands: [{ f: 430, q: 3.2, roam: 0.45, gustF: 0.9 }], db: -36, gust: 13, sway: 2, pan: -0.4, drift: 0.4 },
      { src: "pink", bands: [{ f: 760, q: 5, roam: 0.5, gustF: 0.8 }], db: -40, gust: 14, sway: 3, pan: 0.5, drift: 0.4 },
      { src: "brown", bands: [{ type: "lowpass", f: 300, gustF: 0.6 }], db: -38, gust: 8, sway: 2, more: [{ bands: [{ f: 900, q: 0.5, roam: 0.4, gustF: 0.5 }], db: -39, gust: 10, sway: 3, wide: true }] },
      { src: "white", bands: [{ type: "highpass", f: 5200 }, { type: "lowpass", f: 11000 }], db: -46, gust: 14, pan: 0.1, drift: 0.6 },
      { src: "gen", at: [12.75, 2.2], reach: 1.6, db: -23, sway: 1.5, warp: 0.012, group: "machine" },
    ],
    events: [
      { cue: "ropeClank", every: [4, 12], where: spot([-13.4, -36.5, 12]), run: [1, 4], gap: [0.2, 0.6], gusty: true, db: [2, 6] },
      { cue: "windGust", every: [8, 18], where: ring360(8, 18), db: [-4, -1] },
      { cue: "signCreak", every: [22, 55], where: spot([9, -20, 3]), gusty: true, db: [1, 4] },
      { cue: "shutterCreak", every: [40, 90], where: spot([-9.4, 0, 3]), gusty: true },
    ],
  },
  // Freight yard on a wet night: rain on everything, a diesel idling on the far road, wagons shunted somewhere out in the dark.
  yard: {
    ground: ["tarmac"], wind: 0.45,
    own: ["chainRattle", "crowCaw", "drip", "metalCreak", "relayClack", "signCreak", "splash", "steamHiss", "trainBrake", "tubeFlicker", "windGust", "wingsFlush"],
    beds: [
      // Rain: its hiss on open ground, the patter of single drops close by, and its drumming on the tin over the firing line.
      { src: "white", bands: [{ type: "highpass", f: 3600 }, { type: "lowpass", f: 9500 }], db: -38, gust: 4, sway: 1.5, wide: true },
      { src: "crackle", bands: [{ f: 2600, q: 0.5, roam: 0.3 }], db: -39, gust: 3, sway: 2, pan: -0.3, drift: 0.5, more: [{ bands: [{ f: 5200, q: 0.8 }], db: -45, sway: 2, pan: 0.4, drift: 0.4 }] },
      { src: "pink", bands: [{ f: 950, q: 0.8, roam: 0.25 }], at: [0, 6.5], reach: 3, db: -32, sway: 2, gust: 3 },
      { src: "water", rate: 1.5, bands: [{ type: "highpass", f: 900 }], at: [-9.1, 2.9], reach: 1.1, db: -30, sway: 2 },
      { src: "gen", rate: 0.6, at: [-7, -38], reach: 7, db: -27, sway: 1.5, warp: 0.01, group: "machine" },
      { src: "brown", bands: [{ type: "lowpass", f: 170 }], db: -39, sway: 2, gust: 4 },
    ],
    events: [
      { cue: "containerClang", every: [22, 55], where: ring360(70, 150), run: [1, 4], gap: [0.5, 1.4], first: [6, 16] },
      { cue: "trainPass", every: [80, 170], where: pass(140, 260), db: [0, 3], pitch: [0.8, 0.95] },
      { cue: "thunderFar", every: [45, 110], where: ring360(200, 500), first: [12, 30] },
      { cue: "hornFar", every: [70, 160], where: ring360(150, 300), pitch: [0.5, 0.6], db: [2, 5] },
      { cue: "doorSlamFar", every: [50, 110], where: ring360(40, 90) },
    ],
  },
  // Banking hall after closing: a big still room, the lamps' transformers, air in the ducts, the time lock on the vault, the street through the doors.
  vault: {
    ground: ["tile"], wind: 0.03,
    own: ["chainRattle", "pigeonCoo", "relayClack", "tubeFlicker", "wingsFlush"],
    beds: [
      { src: "brown", bands: [{ type: "lowpass", f: 120 }], db: -40, sway: 2, more: [{ bands: [{ f: 360, q: 1.2, roam: 0.3 }], db: -38, sway: 3.5, wide: true }] },
      { src: "pink", bands: [{ f: 820, q: 0.5, roam: 0.4 }], db: -40, sway: 4, wide: true },
      { src: "fan", rate: 0.6, at: [6, -20], reach: 2.5, db: -34, sway: 1.5, warp: 0.004, group: "machine" },
      { src: "hum", db: -42, sway: 3, pan: -0.4, drift: 0.3, group: "machine" },
    ],
    events: [
      { cue: "clockTick", every: [1, 1], where: () => ({ x: -8.73, z: -4.3, h: 2.35 }) },
      { cue: "alarmBlip", every: [70, 160], where: beyond("far", 30, 70, 900), first: [25, 50] },
      { cue: "bellToll", every: [140, 260], where: beyond("back", 60, 120, 1400), run: [1, 3], gap: [2.2, 2.6], db: [-4, -1] },
      { cue: "carPass", every: [20, 50], where: beyond("back", 14, 30, 700) },
      { cue: "doorSlamFar", every: [50, 120], where: beyond("left", 10, 30) },
    ],
  },
  // Canal quay at dawn: water on stone, boats nudging their fenders, bells over the roofs, the quarter not yet awake.
  canal: {
    ground: ["flags", "cobble"], wind: 0.3,
    own: ["chainRattle", "clothSnap", "drip", "gullCry", "pigeonCoo", "ropeClank", "shutterCreak", "signCreak", "sparrowChirp", "splash", "swiftScream", "waveSlap", "wingsFlush"],
    beds: [
      { src: "lap", at: [-11.5, 1], reach: 5, db: -26, sway: 2.5, warp: 0.03 },
      // The wet dock under the warehouse, heard at its culvert.
      { src: "lap", rate: 0.8, at: [-10, -16], reach: 4, db: -32, sway: 2.5, warp: 0.03 },
      { src: "pink", bands: [{ f: 520, q: 0.7, roam: 0.4, gustF: 0.5 }], db: -40, gust: 7, sway: 3, wide: true },
      { src: "brown", bands: [{ type: "lowpass", f: 170 }], db: -39, sway: 2, more: [{ bands: [{ f: 640, q: 0.5, roam: 0.3 }], db: -42, sway: 4, pan: 0.4, drift: 0.3 }] },
    ],
    events: [
      // The bell tower stands beyond the far end.
      { cue: "bellToll", every: [50, 120], where: () => ({ x: 10, z: -70, h: 22 }), run: [1, 4], gap: [2.2, 2.8], first: [10, 26], db: [-7, -4] },
      { cue: "shipHorn", every: [130, 260], where: ring360(300, 600), pitch: [1.25, 1.5], db: [-6, -3] },
      { cue: "dogBarkFar", every: [60, 140], where: ring360(50, 110), group: "life" },
      { cue: "doorSlamFar", every: [45, 100], where: ring360(30, 70) },
      { cue: "windGust", every: [20, 44], where: ring360(8, 18), db: [-7, -4] },
    ],
  },
  // Forest ruin: insects in waves, a spout running into a stone basin, wind high in the leaves, thunder beyond the ridge.
  ruin: {
    ground: ["flags", "sand"], wind: 0.25,
    own: ["crowCaw", "drip", "leafRustle", "pigeonCoo", "sparrowChirp", "wingsFlush"],
    beds: [
      { src: "cicada", rate: 1.22, db: -34, sway: 2, pan: -0.5, drift: 0.25, warp: 0.02, group: "life", rests: [12, 30, 3, 8] },
      { src: "cicada", rate: 0.86, db: -36, sway: 2, pan: 0.55, drift: 0.25, group: "life", rests: [8, 22, 4, 10] },
      { src: "cicada", rate: 1.6, bands: [{ type: "highpass", f: 4200 }], db: -42, sway: 2, wide: true, group: "life", rests: [20, 50, 2, 6] },
      { src: "water", rate: 1.2, at: [-9.2, -3], reach: 1.3, db: -28, sway: 2, warp: 0.03 },
      { src: "pink", bands: [{ f: 1900, q: 0.5, roam: 0.4, gustF: 0.5 }], db: -41, gust: 8, sway: 3, wide: true },
      { src: "brown", bands: [{ type: "lowpass", f: 200 }], db: -40, sway: 2 },
    ],
    events: [
      { cue: "thunderFar", every: [40, 100], where: ring360(250, 600), first: [15, 35] },
      { cue: "windGust", every: [18, 40], where: above(14, 16), db: [-7, -4] },
    ],
  },
  // Palm house: the misters, water running in the rill, the heating pipes ticking, panes moving in their bars when the wind leans on the roof.
  glasshouse: {
    ground: ["tile", "flags"], wind: 0.2,
    own: ["chainRattle", "drip", "leafRustle", "sparrowChirp", "steamHiss", "valveClunk", "wingsFlush"],
    beds: [
      { src: "white", bands: [{ type: "highpass", f: 4200 }, { type: "lowpass", f: 10500 }], at: [-8.8, -4], reach: 1.6, db: -33, sway: 1.5 },
      { src: "white", bands: [{ type: "highpass", f: 4600 }, { type: "lowpass", f: 10500 }], at: [8.8, -21], reach: 1.6, db: -34, sway: 1.5 },
      { src: "water", rate: 1.3, at: [9.1, 5.5], reach: 1.2, db: -28, sway: 2, warp: 0.03 },
      { src: "pink", bands: [{ f: 700, q: 0.6, roam: 0.4, gustF: 0.4 }], db: -41, gust: 6, sway: 3.5, wide: true },
      { src: "brown", bands: [{ type: "lowpass", f: 150 }], db: -40, sway: 2, more: [{ bands: [{ f: 420, q: 1.4, roam: 0.3 }], db: -40, sway: 3.5, wide: true }] },
    ],
    events: [
      { cue: "metalCreak", every: [9, 24], where: spot([0, -10, 11], [-6, -20, 9], [6, 0, 9], [0, 6, 10]), pitch: [1.1, 1.5], gusty: true },
      { cue: "windGust", every: [22, 48], where: above(13, 14), db: [-8, -5] },
      { cue: "doorSlamFar", every: [70, 150], where: beyond("back", 15, 40) },
      { cue: "dogBarkFar", every: [80, 170], where: ring360(70, 140), group: "life" },
    ],
  },
  // Foot of a dam: the gate running white into the tailrace, the turbine hall, wind and spray in the gorge.
  dam: {
    ground: ["concrete"], wind: 0.55,
    own: ["alarmBlip", "chainRattle", "crowCaw", "drip", "metalCreak", "relayClack", "steamHiss", "swiftScream", "wingsFlush"],
    beds: [
      // The fall: its weight, its body and the hiss of the spray, all from where the water lands.
      { src: "brown", bands: [{ type: "lowpass", f: 260, roam: 0.15 }], at: [-20, -50], reach: 26, db: -25, sway: 1.5, more: [{ bands: [{ f: 700, q: 0.5, roam: 0.2 }], at: [-20, -50], reach: 22, db: -27, sway: 2 }] },
      { src: "white", bands: [{ type: "highpass", f: 2600 }, { type: "lowpass", f: 9000 }], at: [-20, -50], reach: 16, db: -33, sway: 2, gust: 3 },
      { src: "water", rate: 0.7, at: [-12, -8], reach: 5, db: -31, sway: 2.5, warp: 0.03 },
      { src: "hum", rate: 1.2, at: [14, -14], reach: 4, db: -31, sway: 1.5, warp: 0.003, group: "machine", more: [{ bands: [{ f: 1180, q: 9 }], at: [14, -14], reach: 4, db: -38, sway: 2, group: "machine" }] },
      { src: "pink", bands: [{ f: 480, q: 1.4, roam: 0.4, gustF: 0.7 }], db: -40, gust: 10, sway: 2, pan: 0.3, drift: 0.5 },
    ],
    events: [
      { cue: "windGust", every: [12, 26], where: ring360(8, 18), db: [-5, -2] },
      { cue: "paTone", every: [90, 200], where: spot([14, -14, 8]), first: [30, 60] },
      { cue: "doorSlamFar", every: [60, 130], where: beyond("right", 10, 30) },
    ],
  },
  // Empty picture house: the projector running in its box behind the back wall, old ventilation, the building settling.
  cinema: {
    ground: ["felt"], wind: 0.02,
    own: ["chainRattle", "pigeonCoo", "relayClack", "tubeFlicker", "wingsFlush"],
    beds: [
      { src: "projector", at: [0, 10.5], reach: 4.5, db: -29, sway: 1, warp: 0.004, group: "machine" },
      { src: "fan", rate: 0.55, at: [-6, -14], reach: 3, db: -35, sway: 2, warp: 0.006, group: "machine" },
      { src: "brown", bands: [{ type: "lowpass", f: 110 }], db: -41, sway: 2, more: [{ bands: [{ f: 300, q: 1.2, roam: 0.3 }], db: -40, sway: 3.5, wide: true }] },
      { src: "pink", bands: [{ f: 900, q: 0.5, roam: 0.4 }], db: -42, sway: 4, wide: true },
    ],
    events: [
      { cue: "shutterCreak", every: [16, 40], where: spot([-12, -8, 1], [12, -16, 1], [-11, 2, 1], [11, -24, 1], [0, 8, 7]), pitch: [0.7, 1], db: [-3, 1] },
      { cue: "metalCreak", every: [20, 50], where: spot([0, -12, 12], [-7, -22, 11], [7, -4, 11]), pitch: [0.6, 0.85] },
      { cue: "carPass", every: [25, 60], where: beyond("back", 18, 40, 600) },
      { cue: "doorSlamFar", every: [55, 120], where: beyond("back", 12, 30) },
      { cue: "drip", every: [14, 40], where: spot([-8.8, -22, 0.2], [7.5, -26, 0.2]), run: [1, 3], gap: [0.5, 1.4] },
    ],
  },
  // Trading floor after the close: air handling, the server room behind glass, lamps, a telephone nobody is there to answer, the city below.
  office: {
    ground: ["felt"], wind: 0.03,
    own: ["shutterCreak", "tubeFlicker"],
    beds: [
      { src: "fan", at: [12, -5], reach: 3.5, db: -31, sway: 1.5, warp: 0.004, group: "machine", more: [{ bands: [{ type: "highpass", f: 2400 }], at: [12, -5], reach: 3, db: -40, sway: 2, group: "machine" }] },
      { src: "pink", bands: [{ f: 1100, q: 0.5, roam: 0.3 }], db: -38, sway: 3, wide: true, group: "machine" },
      { src: "hum", db: -42, sway: 3, pan: 0.4, drift: 0.3, group: "machine" },
      { src: "brown", bands: [{ type: "lowpass", f: 130 }], db: -40, sway: 2, more: [{ bands: [{ f: 420, q: 0.6, roam: 0.3 }], db: -41, sway: 4, wide: true }] },
    ],
    events: [
      { cue: "phoneRing", every: [45, 110], where: spot([-8.2, 4.5, -0.6], [8.3, 6, -0.6], [-8.4, 1.5, -0.6]), run: [3, 6], gap: [3, 3], first: [14, 30] },
      { cue: "sirenFar", every: [60, 140], where: pass(160, 320, -60, 900) },
      { cue: "hornFar", every: [18, 44], where: ring360(90, 200), db: [-6, -3] },
      { cue: "carPass", every: [10, 24], where: pass(80, 150, -60, 800), db: [-6, -2] },
      { cue: "relayClack", every: [20, 50], where: spot([12, -5, 0.5], [12, -2.5, 0.5]), run: [2, 6], gap: [0.08, 0.3] },
      { cue: "doorSlamFar", every: [60, 130], where: beyond("left", 10, 30) },
    ],
  },
};

/** What wave mode fades in over any map: a low drone that will not settle, and a thin wind through the gaps. */
const DREAD_BEDS: Bed[] = [
  { src: "brown", bands: [{ type: "lowpass", f: 85, q: 3 }], db: -35, sway: 2, group: "dread", more: [{ bands: [{ f: 196, q: 9, roam: 0.2 }], db: -37, sway: 4, pan: -0.3, drift: 0.5, group: "dread" }] },
  { src: "pink", bands: [{ f: 460, q: 1.2, roam: 0.6 }], db: -37, sway: 4, pan: 0.3, drift: 0.6, group: "dread", more: [{ bands: [{ f: 3400, q: 6, roam: 0.5 }], db: -47, sway: 5, pan: -0.5, drift: 0.4, group: "dread" }] },
];

// ---- The engine -------------------------------------------------------------------------------------
const MAX_VOICES = 10;
/** No single voice peaks above this (dBFS), however close it is: the soundscape stays under the guns. */
const CEILING = gainOf(-16);
/** Reverb sends the engine plays into: beside you, across the range, far away. */
const SENDS = [0.06, 0.3, 0.65];

/** The share of a noise's power that a chain of filters lets through. */
function passband(kind: NoiseKind, filters: BiquadFilterNode[]) {
  const count = 160, hz = new Float32Array(count), magnitude = new Float32Array(count), phase = new Float32Array(count), through = new Float32Array(count).fill(1);
  for (let i = 0; i < count; i += 1) hz[i] = 16 * 1250 ** (i / (count - 1));
  for (const filter of filters) {
    filter.getFrequencyResponse(hz, magnitude, phase);
    for (let i = 0; i < count; i += 1) through[i] *= magnitude[i] * magnitude[i];
  }
  let all = 0, kept = 0;
  for (let i = 0; i < count; i += 1) {
    // Power per logarithmic step: white grows with frequency, pink is level, brown falls away above its corner.
    const density = (kind === "pink" ? 1 / hz[i] : kind === "brown" ? 1 / (hz[i] * hz[i] + 1600) : 1) * hz[i];
    all += density; kept += density * through[i];
  }
  return clamp(kept / all, 1e-4, 1);
}

export type SoundscapeStats = {
  /** Source nodes alive right now: beds, voices and footsteps. */
  sources: number;
  /** The most there have been at once. */
  most: number;
  beds: number;
  /** Voices started, by name, and the loudest each has been (dBFS peak before panning). */
  fired: Record<string, number>;
  loudest: Record<string, number>;
  /** Voices refused by the rate limits. */
  dropped: number;
  /** Footsteps played. */
  steps: number;
};

export type Soundscape = {
  /** Resolves when everything the map plays unprompted has been rendered. */
  ready: Promise<void>;
  /** Where the ears are; also runs the engine's clock (a few times a second is plenty). */
  listen: (x: number, z: number, yaw: number) => void;
  setActive: (playing: boolean) => void;
  setDread: (amount: number) => void;
  bang: () => void;
  step: (running: boolean) => void;
  cue: Cue;
  stats: () => SoundscapeStats;
  dispose: () => void;
};

/**
 * A map's soundscape on any audio context. `sink(send)` is where sound leaves: it should pass its
 * input on dry and feed `send` of it to the room's reverb, as RangeSound.bus does.
 */
export function createSoundscape(context: BaseAudioContext, sink: (send: number) => AudioNode, map: RangeMapId, bank: SoundBank = createSoundBank()): Soundscape {
  const spec = MAPS[map];
  const stock = noises();
  const top = Math.min(20000, context.sampleRate * 0.45);
  const ears = { x: 0, z: 7.2, yaw: 0 };
  let dead = false, active = false, dread = 0, dreadNow = 0;
  let lastTick = context.currentTime;

  // Everything leaves through one of three chains, so a pause can muffle the lot.
  const chains = SENDS.map((send) => {
    const tone = context.createBiquadFilter(), level = context.createGain();
    tone.type = "lowpass"; tone.frequency.value = top; tone.Q.value = 0.5;
    level.gain.value = 0;
    tone.connect(level).connect(sink(send));
    return { tone, level };
  });
  const duck = context.createGain();
  duck.connect(chains[0].tone);
  const groups = { air: context.createGain(), machine: context.createGain(), life: context.createGain(), dread: context.createGain() };
  for (const node of Object.values(groups)) node.connect(duck);
  groups.dread.gain.value = 0;
  const groupLevel: Record<Group, number> = { air: 1, machine: 1, life: 1, dread: 0 };

  /** How a place sounds from where the ears are. */
  const hear = (x: number, z: number, h: number, reach: number) => {
    const dx = x - ears.x, dz = z - ears.z, flat = Math.hypot(dx, dz), d = Math.hypot(flat, h), bearing = Math.atan2(dx, -dz) + ears.yaw;
    return { d, front: Math.cos(bearing), gain: 1 / (1 + (0.16 * d) / reach), pan: clamp(Math.sin(bearing) * Math.min(1, flat / Math.max(3, h * 1.5)) * 0.85, -1, 1) };
  };
  /** Distance takes the top off a sound; so does having it behind you, or behind a wall. */
  const cutoff = (heard: { d: number; front: number }, muffle?: number) =>
    Math.min(top, muffle ?? top, clamp(24000 / (1 + heard.d / 30), 1500, top) * (0.6 + 0.2 * (heard.front + 1)));

  // ---- Beds ----
  type LiveBranch = {
    spec: Branch; kind: Group; gain: GainNode; pan: StereoPannerNode | null; tail: AudioNode; bands: BiquadFilterNode[]; unit: number;
    walk: number; walkNow: number; side: number; sideNow: number; roam: number[]; roamNow: number[]; rest: number; restNow: number; restNext: number;
    next: number; level: number; panned: number; tuned: number[];
  };
  type LiveBed = { spec: Bed; node: AudioBufferSourceNode; branches: LiveBranch[]; rate: number };
  const beds: LiveBed[] = [];
  let dreadBeds: LiveBed[] = [];

  const startBed = (bed: Bed, buffer: AudioBuffer, list: LiveBed[]) => {
    const node = context.createBufferSource();
    node.buffer = buffer; node.loop = true; node.playbackRate.value = bed.rate ?? 1;
    const live: LiveBed = { spec: bed, node, branches: [], rate: bed.rate ?? 1 };
    for (const branch of [bed, ...(bed.more ?? [])]) {
      let head: AudioNode = node;
      const bands = (branch.bands ?? []).map((band) => {
        const filter = context.createBiquadFilter();
        filter.type = band.type ?? "bandpass"; filter.frequency.value = band.f; filter.Q.value = band.q ?? 0.7;
        head.connect(filter); head = filter;
        return filter;
      });
      const gain = context.createGain(), kind = branch.group ?? "air";
      gain.gain.value = 0;
      head.connect(gain);
      let pan: StereoPannerNode | null = null, tail: AudioNode = gain;
      if (branch.wide) {
        const sides = context.createChannelMerger(2), late = context.createDelay(0.05);
        late.delayTime.value = rand(0.017, 0.031);
        gain.connect(sides, 0, 0); gain.connect(late).connect(sides, 0, 1);
        tail = sides;
      } else if (branch.pan !== undefined || branch.drift || branch.at) { pan = context.createStereoPanner(); pan.pan.value = branch.pan ?? 0; gain.connect(pan); tail = pan; }
      tail.connect(groups[kind]);
      // A branch's level is what it measures after its filters, whatever they are.
      const unit = bed.src in LOOPS ? 1 / LOOP_RMS : 1 / (stock.rms[bed.src as NoiseKind] * Math.sqrt(passband(bed.src as NoiseKind, bands)));
      const roam = bands.map(() => 0);
      live.branches.push({ spec: branch, kind, gain, pan, tail, bands, unit, walk: rand(-1, 1), walkNow: 0, side: rand(-1, 1), sideNow: 0, roam, roamNow: [...roam], rest: 1, restNow: 1, restNext: context.currentTime + (branch.rests ? rand(branch.rests[0], branch.rests[1]) : 0), next: context.currentTime + rand(1, 5), level: 0, panned: branch.pan ?? 0, tuned: bands.map((_, index) => (branch.bands ?? [])[index].f) });
    }
    node.start(context.currentTime + 0.02, Math.random() * buffer.duration);
    list.push(live);
  };
  const stopBed = (bed: LiveBed) => {
    try { bed.node.stop(); } catch { /* never started */ }
    bed.node.disconnect();
    for (const branch of bed.branches) branch.tail.disconnect();
  };
  const addBed = (bed: Bed, list: LiveBed[], wanted: () => boolean) => {
    if (bed.src in LOOPS) void bank.loop(bed.src as LoopName).then((buffer) => { if (buffer && !dead && wanted()) startBed(bed, buffer, list); });
    else startBed(bed, stock[bed.src as NoiseKind], list);
  };
  for (const bed of spec.beds) addBed(bed, beds, () => true);

  // ---- Wind ----
  let gust = 0.2, gustTarget = 0.2, gustNext = 0, gustBump = 0;

  // ---- Voices ----
  type Playing = { name: CueName; source: AudioBufferSourceNode; volume: GainNode; panner: StereoPannerNode; where: Where | null; start: number; end: number; pan: number; group?: Group };
  const playing: Playing[] = [], feet: Array<{ end: number; panner: StereoPannerNode }> = [];
  const lastPlayed = new Map<CueName, number>(), waiting = new Set<CueName>();
  const counts: SoundscapeStats = { sources: 0, most: 0, beds: 0, fired: {}, loudest: {}, dropped: 0, steps: 0 };
  let burstFrom = -1, burst = 0;

  const play = (name: CueName, where: Where | null, gain: number, pitch: number, delay = 0, take = -1, group?: Group, forced = false): boolean => {
    const voice = VOICES[name];
    if (dead || !voice) return false;
    const t = context.currentTime;
    if (!forced) {
      if (t - (lastPlayed.get(name) ?? -100) < (voice.gap ?? clamp(voice.len * 0.25, 0.07, 1.2))) { counts.dropped += 1; return false; }
      if (t - burstFrom > 0.1) { burstFrom = t; burst = 0; }
      if (burst >= 4) { counts.dropped += 1; return false; }
    }
    if (playing.length >= MAX_VOICES) { counts.dropped += 1; return false; }
    const takes = bank.taken(name);
    if (!takes) {
      // First request for this voice: render it and play it if that does not take long (a long pass may start a little late).
      if (!waiting.has(name)) {
        waiting.add(name);
        void bank.voice(name).then(() => { waiting.delete(name); if (!dead && context.currentTime - t < clamp(voice.len * 0.2, 0.5, 3)) play(name, where, gain, pitch, delay, take, group, forced); });
      }
      return false;
    }
    if (!takes.length) return false;
    const buffer = takes[take < 0 ? Math.floor(Math.random() * takes.length) : take % takes.length];
    const start = t + 0.01 + delay;
    const source = context.createBufferSource(), volume = context.createGain(), panner = context.createStereoPanner();
    source.buffer = buffer; source.playbackRate.value = pitch;
    let level = gainOf(voice.db) * gain, chain = 1, pan = 0;
    if (where) {
      // Something travelling is judged at its nearest; its own swell carries the approach.
      const middle = where.x2 === undefined || where.z2 === undefined ? hear(where.x, where.z, where.h, voice.reach ?? 1) : hear((where.x + where.x2) / 2, (where.z + where.z2) / 2, where.h, voice.reach ?? 1);
      const first = hear(where.x, where.z, where.h, 1);
      level *= middle.gain;
      chain = where.muffle ? 1 : middle.d < 9 ? 0 : middle.d < 40 ? 1 : 2;
      pan = first.pan;
      const tone = context.createBiquadFilter();
      tone.type = "lowpass"; tone.Q.value = 0.5; tone.frequency.value = cutoff(middle, where.muffle);
      source.connect(tone).connect(volume);
    } else { level *= 0.4; source.connect(volume); }
    // Company makes each a little quieter, so two or three landing together do not add up to one loud sound.
    let company = 0;
    for (const other of playing) if (start < other.end && start - other.start < 1.5) company += 1;
    level = Math.min(level, CEILING) / Math.sqrt(1 + 0.3 * company);
    volume.gain.value = level;
    panner.pan.value = pan;
    volume.connect(panner).connect(chains[chain].tone);
    source.start(start);
    playing.push({ name, source, volume, panner, where, start, end: start + buffer.duration / pitch + 0.05, pan, group });
    if (!forced) { lastPlayed.set(name, t); burst += 1; }
    counts.fired[name] = (counts.fired[name] ?? 0) + 1;
    counts.loudest[name] = Math.max(counts.loudest[name] ?? -120, Math.round(200 * Math.log10(level)) / 10);
    return true;
  };

  // ---- Events ----
  const events = spec.events.map((event) => ({ spec: event, next: context.currentTime + (event.first ? between(event.first) : rand(0.1, 0.9) * between(event.every)) }));
  /** What is still to come: the rest of a run, or the sound that follows another. Started a moment ahead, on time. */
  const followers: Array<{ at: number; cue: CueName; where: Where | null; gain: number; pitch: number; take: number; group?: Group }> = [];
  let hushed = false, hushUntil = 0;
  /** When the map last asked for each voice itself, and the time before: what it sounds regularly, the engine leaves to it. */
  const asked = new Map<CueName, [number, number]>();
  const mapOwns = (name: CueName, t: number) => { const times = asked.get(name); return !!times && t - times[1] < 45; };

  const fire = (event: EventSpec) => {
    const where = event.where ? event.where() : null;
    const count = event.run ? Math.round(between(event.run)) : 1, take = event.mixed ? -1 : Math.floor(Math.random() * 12);
    const pitch = between(event.pitch ?? [0.94, 1.06]), decibels = between(event.db ?? [-3, 0]) + (event.gusty ? gust * 3 : 0) - (event.group === "life" ? 0 : dreadNow * 4);
    if (!play(event.cue, where, gainOf(decibels), pitch, 0, take, event.group)) return;
    let at = context.currentTime;
    for (let i = 1; i < count; i += 1) {
      at += between(event.gap ?? [0.3, 0.6]);
      followers.push({ at, cue: event.cue, where, gain: gainOf(decibels + rand(-2.5, 1)), pitch: pitch * rand(0.985, 1.015), take, group: event.group });
    }
    if (event.then) followers.push({ at: context.currentTime + between(event.then.after), cue: event.then.cue, where, gain: gainOf(event.then.db ?? 0), pitch: rand(0.95, 1.05), take: -1 });
  };

  const setGroup = (kind: Group, level: number, t: number, seconds: number) => {
    if (Math.abs(level - groupLevel[kind]) < 0.004) return;
    groupLevel[kind] = level;
    groups[kind].gain.setTargetAtTime(level, t, seconds);
  };

  const tick = () => {
    if (dead) return;
    const t = context.currentTime, dt = clamp(t - lastTick, 0.005, 0.5);
    lastTick = t;
    const ease = (seconds: number) => 1 - Math.exp(-dt / seconds);

    // Dread: wildlife goes, machinery dims, the wind and the drone come up (less where the wind already blows hard).
    dreadNow += (dread - dreadNow) * ease(0.6);
    if (dreadNow > 0.01 && !dreadBeds.length) for (const bed of DREAD_BEDS) addBed(bed, dreadBeds, () => dreadNow > 0.01);
    if (dreadNow < 0.004 && dread === 0 && dreadBeds.length) { dreadBeds.forEach(stopBed); dreadBeds = []; }
    if (hushed && t > hushUntil) hushed = false;
    setGroup("life", (hushed ? 0.02 : 1) * (1 - dreadNow) ** 2, t, hushed ? 0.07 : 2.2);
    setGroup("machine", 1 - 0.4 * dreadNow, t, 0.5);
    setGroup("air", 1 + 0.25 * dreadNow * (1 - 0.6 * spec.wind), t, 0.5);
    setGroup("dread", dreadNow, t, 0.3);

    // Wind: lulls most of the time, now and then a gust; a gust the map shows is heard too.
    if (t >= gustNext) { gustNext = t + rand(2.5, 7); gustTarget = Math.min(1, Math.random() ** 1.7 * (0.5 + spec.wind * 0.6) + dreadNow * 0.35 * (1 - 0.6 * spec.wind)); }
    gustBump *= Math.exp(-dt / 1.5);
    gust += (Math.max(gustTarget, gustBump) - gust) * ease(1.3);

    for (const bed of [...beds, ...dreadBeds]) {
      for (const branch of bed.branches) {
        const b = branch.spec;
        if (t >= branch.next) {
          branch.next = t + rand(2.5, 7);
          branch.walk = clamp(branch.walk * 0.6 + rand(-1, 1) * 0.8, -1, 1);
          branch.side = clamp(branch.side * 0.6 + rand(-1, 1) * 0.8, -1, 1);
          (b.bands ?? []).forEach((band, index) => { if (band.roam) branch.roam[index] = rand(-1, 1) * band.roam; });
          if (branch === bed.branches[0] && bed.spec.warp) bed.node.playbackRate.setTargetAtTime(bed.rate * (1 + rand(-1, 1) * bed.spec.warp), t, 1.5);
        }
        if (b.rests && t >= branch.restNext) {
          branch.rest = branch.rest ? 0 : 1;
          branch.restNext = t + (branch.rest ? rand(b.rests[0], b.rests[1]) : rand(b.rests[2], b.rests[3]));
        }
        branch.walkNow += (branch.walk - branch.walkNow) * ease(2);
        branch.sideNow += (branch.side - branch.sideNow) * ease(3);
        branch.restNow += (branch.rest - branch.restNow) * ease(branch.rest ? 2.5 : 0.5);
        let level = gainOf(b.db + (b.sway ?? 0) * branch.walkNow + (b.gust ?? 0) * (gust - 0.3)) * branch.unit * branch.restNow;
        let pan = (b.pan ?? 0) + (b.drift ?? 0) * branch.sideNow;
        if (b.at) { const heard = hear(b.at[0], b.at[1], 0, b.reach ?? 1); level *= heard.gain; pan = heard.pan; }
        if (Math.abs(level - branch.level) > 0.015 * Math.max(level, branch.level)) { branch.level = level; branch.gain.gain.setTargetAtTime(level, t, 0.25); }
        pan = clamp(pan, -1, 1);
        if (branch.pan && Math.abs(pan - branch.panned) > 0.015) { branch.panned = pan; branch.pan.pan.setTargetAtTime(pan, t, 0.15); }
        (b.bands ?? []).forEach((band, index) => {
          if (!band.roam && !band.gustF) return;
          branch.roamNow[index] += (branch.roam[index] - branch.roamNow[index]) * ease(2.5);
          const hz = Math.min(top, band.f * 2 ** (branch.roamNow[index] + (band.gustF ?? 0) * (gust - 0.3)));
          if (Math.abs(hz - branch.tuned[index]) > 0.01 * hz) { branch.tuned[index] = hz; branch.bands[index].frequency.setTargetAtTime(hz, t, 0.25); }
        });
      }
    }

    // Voices that have finished leave; the rest stay where they are as the head turns.
    for (let i = playing.length - 1; i >= 0; i -= 1) {
      const voice = playing[i];
      if (t >= voice.end) { voice.panner.disconnect(); playing.splice(i, 1); continue; }
      const where = voice.where;
      if (!where) continue;
      let x = where.x, z = where.z;
      if (where.x2 !== undefined && where.z2 !== undefined) { const along = clamp((t - voice.start) / (voice.end - voice.start), 0, 1); x += (where.x2 - x) * along; z += (where.z2 - z) * along; }
      const pan = hear(x, z, where.h, 1).pan;
      if (Math.abs(pan - voice.pan) > 0.02) { voice.pan = pan; voice.panner.pan.setTargetAtTime(pan, t, 0.12); }
    }
    for (let i = feet.length - 1; i >= 0; i -= 1) if (t >= feet[i].end) { feet[i].panner.disconnect(); feet.splice(i, 1); }

    for (let i = followers.length - 1; i >= 0; i -= 1) {
      if (followers[i].at > t + 0.2) continue;
      const [next] = followers.splice(i, 1);
      if (next.at > t - 0.3) play(next.cue, next.where, next.gain, next.pitch, Math.max(0, next.at - t), next.take, next.group, true);
    }
    for (const event of events) {
      if (t < event.next) continue;
      const quiet = (event.spec.group === "life" && (hushed || dreadNow > 0.4)) || mapOwns(event.spec.cue, t);
      event.next = t + between(event.spec.every) * (event.spec.gusty ? 1.4 - gust * 0.9 : 1) * (quiet ? 0.3 : 1);
      if (!quiet) fire(event.spec);
    }

    counts.beds = beds.length + dreadBeds.length;
    counts.sources = counts.beds + playing.length + feet.length;
    counts.most = Math.max(counts.most, counts.sources);
  };

  const applyActive = (t: number) => {
    for (const chain of chains) {
      chain.level.gain.setTargetAtTime(active ? 1 : 0.25, t, 0.1);
      chain.tone.frequency.setTargetAtTime(active ? top : 650, t, 0.1);
    }
  };
  applyActive(context.currentTime);

  let left = false, lastStep = -1, lastTake = -1, under = 0;

  return {
    ready: bank.prepare(map),
    listen(x, z, yaw) {
      ears.x = x; ears.z = z; ears.yaw = yaw;
      if (context.currentTime - lastTick >= 0.08) tick();
    },
    setActive(playingNow) {
      if (dead || playingNow === active) return;
      active = playingNow;
      applyActive(context.currentTime);
    },
    setDread(amount) { dread = clamp(amount, 0, 1); },
    bang() {
      if (dead) return;
      const t = context.currentTime;
      // The beds give way under the report and come back within half a second.
      duck.gain.setTargetAtTime(0.72, t, 0.012);
      duck.gain.setTargetAtTime(1, t + 0.14, 0.22);
      // Anything alive stops what it was doing, and takes a while to trust the quiet again.
      hushUntil = t + rand(3, 5);
      if (!hushed) {
        hushed = true;
        setGroup("life", 0.02 * (1 - dreadNow) ** 2, t, 0.07);
        for (const voice of playing) {
          if (voice.group !== "life") continue;
          voice.volume.gain.setTargetAtTime(0, t, 0.04);
          try { voice.source.stop(t + 0.3); } catch { /* already stopped */ }
          voice.end = Math.min(voice.end, t + 0.35);
        }
      }
      for (let i = followers.length - 1; i >= 0; i -= 1) if (followers[i].group === "life") followers.splice(i, 1);
      for (const event of events) if (event.spec.group === "life") event.next = Math.max(event.next, hushUntil + rand(0.5, 6));
    },
    step(running) {
      if (dead) return;
      const t = context.currentTime;
      if (t - lastStep < 0.14) return;
      // Where two floors meet (plate over concrete), runs of one and then the other.
      if (spec.ground.length > 1 && Math.random() < 0.22) under = (under + 1) % spec.ground.length;
      const ground = spec.ground[under], takes = bank.stepsTaken(ground);
      if (!takes || !takes.length) return;
      lastStep = t;
      let index = Math.floor(Math.random() * takes.length);
      if (index === lastTake) index = (index + 1) % takes.length;
      lastTake = index; left = !left;
      const source = context.createBufferSource(), volume = context.createGain(), panner = context.createStereoPanner();
      source.buffer = takes[index];
      source.playbackRate.value = (left ? 0.97 : 1.03) * rand(0.95, 1.05) * (running ? 1.06 : 1);
      volume.gain.value = gainOf(STEPS[ground].db + (running ? 3.5 : 0) + rand(-2.5, 0.5));
      panner.pan.value = left ? -0.14 : 0.14;
      source.connect(volume).connect(panner).connect(chains[0].tone);
      source.start(t + 0.005);
      feet.push({ end: t + takes[index].duration / source.playbackRate.value + 0.05, panner });
      counts.steps += 1;
    },
    cue(name, at, options) {
      const voice = VOICES[name];
      if (dead || !voice) return;
      const gain = clamp(options?.gain ?? 1, 0, 3), pitch = clamp(options?.pitch ?? 1, 0.4, 2.5);
      // A gust the map shows crossing the range lifts the wind beds as it is heard.
      if (name === "windGust") gustBump = Math.max(gustBump, clamp(gain, 0, 1.2));
      asked.set(name, [context.currentTime, asked.get(name)?.[0] ?? -1000]);
      let where: Where | null = null;
      if (at) {
        where = { x: at.x, z: at.z, h: Math.abs(at.y - 1.62) };
        if (voice.glide) {
          const dx = at.x - ears.x, dz = at.z - ears.z, d = Math.hypot(dx, dz) || 1, half = d * 1.2 + 20, way = Math.random() < 0.5 ? -1 : 1;
          where = { x: at.x + (dz / d) * half * way, z: at.z - (dx / d) * half * way, x2: at.x - (dz / d) * half * way, z2: at.z + (dx / d) * half * way, h: where.h };
        }
      }
      play(name, where, gain, pitch);
    },
    stats: () => ({ ...counts, fired: { ...counts.fired }, loudest: { ...counts.loudest } }),
    dispose() {
      if (dead) return;
      dead = true;
      [...beds, ...dreadBeds].forEach(stopBed);
      for (const voice of playing) { try { voice.source.stop(); } catch { /* not started */ } voice.panner.disconnect(); }
      for (const foot of feet) foot.panner.disconnect();
      for (const chain of chains) chain.level.disconnect();
      beds.length = 0; dreadBeds = []; playing.length = 0; feet.length = 0;
    },
  };
}

// ---- What World holds -------------------------------------------------------------------------------
export type Ambience = {
  /** Begins the map's soundscape. Call from a user gesture (entering the range); safe to repeat. */
  start: () => void;
  /** Full level while playing, held low under the briefing and pause screens. */
  setActive: (playing: boolean) => void;
  /** Once per frame: where the player's ears are. `yaw` as in World (forward is -sin, -cos). */
  update: (now: number, position: THREE.Vector3, yaw: number) => void;
  /** Wave mode restages the map: 0 calm .. 1 dread. */
  setDread: (amount: number) => void;
  /** A shot was fired: wildlife falls silent for a moment and the beds duck under the report. */
  bang: () => void;
  /** The player put a foot down (World calls this once per stride): this map's ground, underfoot. */
  step: (running: boolean) => void;
  cue: Cue;
  dispose: () => void;
};

export function createAmbience(sound: RangeSound, map: RangeMapId): Ambience {
  let scape: Soundscape | null = null, bank: SoundBank | null = null;
  let disposed = false, active = false, dread = 0;
  const ears = { x: 0, z: 7.2, yaw: 0 };
  // Rendering needs neither a gesture nor an audio context, so the map's voices are ready by the
  // time the player walks in. Deferred a moment so a mount that is torn down at once costs nothing.
  const warm = setTimeout(() => {
    if (disposed) return;
    try { bank = createSoundBank(); void bank.prepare(map); } catch { /* audio is optional */ }
  }, 0);
  const safely = (work: (scape: Soundscape) => void) => {
    if (!scape) return;
    try { work(scape); } catch { /* audio is optional */ }
  };
  const ambience: Ambience = {
    start() {
      if (disposed) return;
      try {
        // The only place the audio context is touched: World calls this as the player takes the pointer.
        const context = sound.context();
        if (context.state === "suspended") void context.resume();
        if (scape) return;
        bank ??= createSoundBank();
        scape = createSoundscape(context, (send) => sound.bus(send), map, bank);
        scape.listen(ears.x, ears.z, ears.yaw);
        scape.setDread(dread);
        scape.setActive(active);
      } catch { /* audio is optional */ }
    },
    setActive(playing) { active = playing; safely((live) => live.setActive(playing)); },
    update(_now, position, yaw) {
      ears.x = position.x; ears.z = position.z; ears.yaw = yaw;
      safely((live) => live.listen(ears.x, ears.z, ears.yaw));
    },
    setDread(amount) { dread = amount; safely((live) => live.setDread(amount)); },
    bang() { safely((live) => live.bang()); },
    step(running) { safely((live) => live.step(running)); },
    cue(name, at, options) { safely((live) => live.cue(name, at, options)); },
    dispose() {
      disposed = true;
      clearTimeout(warm);
      safely((live) => live.dispose());
      bank?.dispose();
      scape = null; bank = null;
    },
  };
  if (import.meta.env.DEV) (globalThis as { __hsAmbience?: unknown }).__hsAmbience = { map, stats: () => scape?.stats() ?? null };
  return ambience;
}
