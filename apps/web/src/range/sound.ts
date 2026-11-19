import type { WeaponId } from "./arsenalSpec";
import type { RangeMapId } from "./mapList";

// Range audio, synthesised: nothing is downloaded.
//
// A gunshot is built from the parts a real report has — the supersonic crack, the
// muzzle blast's body, a low thump, the action cycling a few hundredths of a second
// later and the rumble that follows — pushed through a saturator so it bites.
// Each weapon's layers are tuned separately and rendered ahead of time, in a few
// variations, so rapid fire costs one buffer playback per round and never repeats
// exactly. Everything then plays into a reverb shaped by the map: a long hard tail
// in the halls, a short slap in the open.

type Layer = { hz: number; gain: number; decay: number };
type ShotProfile = {
  crack: Layer;
  body: Layer & { q: number };
  thump: { from: number; to: number; gain: number; decay: number };
  /** The action cycling: a bright clack some milliseconds after the report. */
  clack: Layer & { delay: number };
  rumble: Layer;
  drive: number;
  length: number;
  level: number;
  /** How much of the shot goes to the room reverb. */
  tail: number;
};

type Firearm = Exclude<WeaponId, "knife">;

const SHOTS: Record<Firearm, ShotProfile> = {
  // 7.62×39: heavy, low and loud, with the carrier slamming home.
  ak47: { crack: { hz: 3200, gain: 1, decay: 0.022 }, body: { hz: 620, q: 0.7, gain: 1.15, decay: 0.16 }, thump: { from: 125, to: 42, gain: 1.1, decay: 0.13 }, clack: { hz: 2400, gain: 0.36, decay: 0.03, delay: 0.055 }, rumble: { hz: 380, gain: 0.5, decay: 0.55 }, drive: 2.4, length: 1, level: 0.56, tail: 0.42 },
  // 5.56 from a carbine: sharper and tighter.
  m4: { crack: { hz: 4200, gain: 1.1, decay: 0.016 }, body: { hz: 1050, q: 0.8, gain: 0.9, decay: 0.11 }, thump: { from: 150, to: 55, gain: 0.8, decay: 0.09 }, clack: { hz: 3100, gain: 0.28, decay: 0.022, delay: 0.04 }, rumble: { hz: 520, gain: 0.36, decay: 0.4 }, drive: 2, length: 0.8, level: 0.5, tail: 0.36 },
  // Short-barrelled bullpup at 1000 rpm: snappy and bright.
  famas: { crack: { hz: 4600, gain: 1, decay: 0.014 }, body: { hz: 1300, q: 0.9, gain: 0.85, decay: 0.09 }, thump: { from: 165, to: 60, gain: 0.7, decay: 0.08 }, clack: { hz: 3500, gain: 0.3, decay: 0.02, delay: 0.035 }, rumble: { hz: 600, gain: 0.3, decay: 0.32 }, drive: 2.1, length: 0.7, level: 0.48, tail: 0.32 },
  // 9 mm from an open bolt: a flat pop and a lot of clatter.
  uzi: { crack: { hz: 2600, gain: 0.7, decay: 0.018 }, body: { hz: 820, q: 0.9, gain: 0.9, decay: 0.085 }, thump: { from: 185, to: 70, gain: 0.65, decay: 0.07 }, clack: { hz: 1900, gain: 0.5, decay: 0.03, delay: 0.045 }, rumble: { hz: 450, gain: 0.22, decay: 0.25 }, drive: 1.6, length: 0.6, level: 0.42, tail: 0.24 },
  // Full-power rifle round: a boom that rolls on. The bolt is worked by hand, so no clack.
  rifle: { crack: { hz: 2800, gain: 1.2, decay: 0.03 }, body: { hz: 480, q: 0.6, gain: 1.3, decay: 0.26 }, thump: { from: 95, to: 32, gain: 1.4, decay: 0.22 }, clack: { hz: 2000, gain: 0, decay: 0.02, delay: 0.05 }, rumble: { hz: 260, gain: 0.8, decay: 1.1 }, drive: 3, length: 1.8, level: 0.75, tail: 0.6 },
};

/** Reverb time in seconds, and how bright the tail is, for each map. */
const ROOMS: Record<RangeMapId, { seconds: number; damping: number; wet: number }> = {
  foundry: { seconds: 1.6, damping: 0.5, wet: 1 },
  reactor: { seconds: 2.8, damping: 0.35, wet: 1.15 },
  courtyard: { seconds: 0.75, damping: 0.75, wet: 0.6 },
  piazza: { seconds: 1.0, damping: 0.65, wet: 0.7 },
  rooftop: { seconds: 1.3, damping: 0.8, wet: 0.55 },
  metro: { seconds: 2.2, damping: 0.45, wet: 1.05 },
  docks: { seconds: 0.9, damping: 0.7, wet: 0.6 },
  hangar: { seconds: 2.4, damping: 0.4, wet: 1.0 },
  bazaar: { seconds: 0.7, damping: 0.8, wet: 0.6 },
  outpost: { seconds: 0.6, damping: 0.9, wet: 0.45 },
};

const VARIATIONS = 3;
const RATE = 44100;

export type KnifeSound = "swing" | "flesh" | "hard" | "draw";

export type RangeSound = {
  /** The shared context, created on first use (which must follow a user gesture). */
  context: () => AudioContext;
  /** Where every source connects: feeds the master and, by `send`, the room reverb. */
  bus: (send?: number) => AudioNode;
  shot: (id: WeaponId) => void;
  knife: (kind: KnifeSound) => void;
  /** Master level for everything on this context, 0 (muted) to 1. */
  setVolume: (level: number) => void;
  dispose: () => void;
};

function noiseBuffer(context: BaseAudioContext, seconds: number) {
  const buffer = context.createBuffer(1, Math.max(1, Math.floor(context.sampleRate * seconds)), context.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i += 1) data[i] = Math.random() * 2 - 1;
  return buffer;
}

function saturator(context: BaseAudioContext, drive: number) {
  const shaper = context.createWaveShaper();
  const curve = new Float32Array(1024);
  for (let i = 0; i < curve.length; i += 1) {
    const x = (i / (curve.length - 1)) * 2 - 1;
    curve[i] = Math.tanh(x * drive) / Math.tanh(drive);
  }
  shaper.curve = curve;
  shaper.oversample = "2x";
  return shaper;
}

/** A burst of filtered noise with an exponential tail. */
function burst(context: BaseAudioContext, out: AudioNode, source: AudioBuffer, at: number, type: BiquadFilterType, layer: Layer, q = 0.7) {
  if (layer.gain <= 0) return;
  const node = context.createBufferSource();
  node.buffer = source;
  node.loop = true;
  node.loopStart = Math.random() * 0.3;
  const filter = context.createBiquadFilter();
  filter.type = type; filter.frequency.value = layer.hz; filter.Q.value = q;
  const volume = context.createGain();
  volume.gain.setValueAtTime(0.0001, at);
  volume.gain.exponentialRampToValueAtTime(layer.gain, at + 0.0015);
  volume.gain.exponentialRampToValueAtTime(0.0001, at + 0.0015 + layer.decay * 3);
  node.connect(filter).connect(volume).connect(out);
  node.start(at, Math.random() * 0.3);
  node.stop(at + layer.decay * 3 + 0.05);
}

async function renderShot(profile: ShotProfile): Promise<AudioBuffer> {
  const context = new OfflineAudioContext(1, Math.floor(RATE * profile.length), RATE);
  const noise = noiseBuffer(context, 0.5);
  const vary = () => 0.94 + Math.random() * 0.12;
  const out = context.createGain();
  out.gain.value = profile.level;
  out.connect(context.destination);
  // The blast itself is saturated; the rumble and action sit outside it so they stay clean.
  const blast = saturator(context, profile.drive);
  blast.connect(out);
  const at = 0.002;
  burst(context, blast, noise, at, "highpass", { ...profile.crack, hz: profile.crack.hz * vary() });
  burst(context, blast, noise, at, "bandpass", { ...profile.body, hz: profile.body.hz * vary(), decay: profile.body.decay * vary() }, profile.body.q);
  const thump = context.createOscillator(), thumpGain = context.createGain();
  thump.type = "sine";
  thump.frequency.setValueAtTime(profile.thump.from * vary(), at);
  thump.frequency.exponentialRampToValueAtTime(profile.thump.to, at + profile.thump.decay);
  thumpGain.gain.setValueAtTime(profile.thump.gain, at);
  thumpGain.gain.exponentialRampToValueAtTime(0.0001, at + profile.thump.decay * 2.2);
  thump.connect(thumpGain).connect(blast);
  thump.start(at); thump.stop(at + profile.thump.decay * 2.4);
  burst(context, out, noise, at + profile.clack.delay * vary(), "bandpass", profile.clack, 2.2);
  burst(context, out, noise, at + profile.clack.delay * 1.35, "bandpass", { hz: profile.clack.hz * 0.55, gain: profile.clack.gain * 0.6, decay: profile.clack.decay * 1.4 }, 1.6);
  burst(context, out, noise, at + 0.01, "lowpass", { ...profile.rumble, decay: profile.rumble.decay / 3 });
  return context.startRendering();
}

/** A room's impulse response: early slaps, then a decaying wash that darkens as it fades. */
function impulse(context: AudioContext, room: (typeof ROOMS)[RangeMapId]) {
  const length = Math.floor(context.sampleRate * room.seconds);
  const buffer = context.createBuffer(2, length, context.sampleRate);
  for (let channel = 0; channel < 2; channel += 1) {
    const data = buffer.getChannelData(channel);
    let low = 0;
    for (let i = 0; i < length; i += 1) {
      const t = i / length;
      // One-pole low-pass whose cutoff falls with time: high frequencies die first.
      const keep = Math.min(0.98, room.damping * 0.4 + t * room.damping);
      low = low * keep + (Math.random() * 2 - 1) * (1 - keep);
      data[i] = low * Math.exp(-6.9 * t) * (i < 40 ? i / 40 : 1);
    }
    // A few discrete reflections off the nearest walls.
    for (let reflection = 0; reflection < 6; reflection += 1) {
      const at = Math.floor(context.sampleRate * (0.011 + Math.random() * 0.07));
      if (at < length) data[at] += (Math.random() > 0.5 ? 1 : -1) * (0.5 - reflection * 0.06);
    }
  }
  return buffer;
}

export function createRangeSound(map: RangeMapId): RangeSound {
  const room = ROOMS[map];
  let context: AudioContext | null = null;
  let master: AudioNode | null = null, reverb: AudioNode | null = null;
  let output: GainNode | null = null, volume = 1;
  const buses = new Map<number, AudioNode>();
  let disposed = false;

  // Rendering needs no user gesture, so the shots are ready before the first trigger pull.
  const shots = new Map<Firearm, AudioBuffer[]>();
  if (typeof OfflineAudioContext !== "undefined") {
    for (const id of Object.keys(SHOTS) as Firearm[]) {
      void Promise.all(Array.from({ length: VARIATIONS }, () => renderShot(SHOTS[id])))
        .then((buffers) => { if (!disposed) shots.set(id, buffers); })
        .catch(() => { /* audio is optional */ });
    }
  }

  const ensure = () => {
    if (context) return context;
    context = new AudioContext();
    const compressor = context.createDynamicsCompressor();
    compressor.threshold.value = -16; compressor.knee.value = 8; compressor.ratio.value = 6;
    compressor.attack.value = 0.002; compressor.release.value = 0.14;
    output = context.createGain();
    output.gain.value = 0.9 * volume;
    compressor.connect(output).connect(context.destination);
    master = compressor;
    const convolver = context.createConvolver();
    convolver.buffer = impulse(context, room);
    const wet = context.createGain();
    wet.gain.value = room.wet;
    convolver.connect(wet).connect(compressor);
    reverb = convolver;
    return context;
  };

  const bus = (send = 0.25) => {
    const audio = ensure();
    const key = Math.round(send * 100);
    let node = buses.get(key);
    if (!node) {
      node = audio.createGain();
      node.connect(master!);
      const toRoom = audio.createGain();
      toRoom.gain.value = send;
      node.connect(toRoom).connect(reverb!);
      buses.set(key, node);
    }
    return node;
  };

  /** A sine partial that rings and dies: the building block of blade sounds. */
  const ring = (audio: AudioContext, out: AudioNode, at: number, from: number, to: number, length: number, gain: number) => {
    const oscillator = audio.createOscillator(), volume = audio.createGain();
    oscillator.frequency.setValueAtTime(from, at);
    oscillator.frequency.exponentialRampToValueAtTime(to, at + length);
    volume.gain.setValueAtTime(gain, at);
    volume.gain.exponentialRampToValueAtTime(0.0001, at + length);
    oscillator.connect(volume).connect(out);
    oscillator.start(at); oscillator.stop(at + length + 0.02);
  };
  /** Noise swept through a band-pass: air moving past a blade. */
  const sweep = (audio: AudioContext, out: AudioNode, at: number, hz: [number, number, number], length: number, gain: number, q = 1.4) => {
    const source = audio.createBufferSource();
    source.buffer = noiseBuffer(audio, length + 0.05);
    const filter = audio.createBiquadFilter();
    filter.type = "bandpass"; filter.Q.value = q;
    filter.frequency.setValueAtTime(hz[0], at);
    filter.frequency.exponentialRampToValueAtTime(hz[1], at + length * 0.45);
    filter.frequency.exponentialRampToValueAtTime(hz[2], at + length);
    const volume = audio.createGain();
    volume.gain.setValueAtTime(0.0001, at);
    volume.gain.exponentialRampToValueAtTime(gain, at + length * 0.4);
    volume.gain.exponentialRampToValueAtTime(0.0001, at + length);
    source.connect(filter).connect(volume).connect(out);
    source.start(at);
  };

  return {
    context: ensure,
    bus,
    shot(id) {
      if (id === "knife") return;
      try {
        const audio = ensure();
        const buffers = shots.get(id);
        if (!buffers) return;
        const source = audio.createBufferSource();
        source.buffer = buffers[Math.floor(Math.random() * buffers.length)];
        source.playbackRate.value = 0.97 + Math.random() * 0.06;
        const volume = audio.createGain();
        volume.gain.value = 0.9 + Math.random() * 0.1;
        source.connect(volume).connect(bus(SHOTS[id].tail));
        source.start();
      } catch { /* audio is optional */ }
    },
    knife(kind) {
      try {
        const audio = ensure(), at = audio.currentTime, out = bus(kind === "hard" ? 0.3 : 0.12);
        const tune = 0.93 + Math.random() * 0.14;
        if (kind === "swing") {
          sweep(audio, out, at, [500 * tune, 2600 * tune, 700], 0.2, 0.5);
          sweep(audio, out, at + 0.02, [1800, 5200 * tune, 2200], 0.13, 0.16, 3);
        } else if (kind === "flesh") {
          // A dull wet thump with a short tearing edge.
          ring(audio, out, at, 150 * tune, 55, 0.12, 0.7);
          sweep(audio, out, at, [900, 420 * tune, 180], 0.13, 0.6, 0.8);
          sweep(audio, out, at + 0.03, [2600, 1500 * tune, 900], 0.09, 0.2, 2.5);
        } else if (kind === "hard") {
          // Steel on something that does not give: inharmonic partials and a tick.
          for (const [hz, length, gain] of [[2140, 0.22, 0.2], [3390, 0.16, 0.16], [5270, 0.11, 0.1], [7450, 0.07, 0.07]]) ring(audio, out, at, hz * tune, hz * tune * 0.995, length, gain);
          sweep(audio, out, at, [6000, 3800, 2500], 0.03, 0.4, 1);
        } else {
          // Blade clearing a sheath: a rising scrape that ends in a faint ring.
          sweep(audio, out, at, [1400, 4200 * tune, 6400], 0.18, 0.2, 4);
          ring(audio, out, at + 0.14, 4100 * tune, 4080 * tune, 0.3, 0.05);
          ring(audio, out, at + 0.14, 6230 * tune, 6200 * tune, 0.2, 0.03);
        }
      } catch { /* audio is optional */ }
    },
    setVolume(level) {
      volume = Math.min(1, Math.max(0, level));
      // Before the first sound there is no context yet: the level is picked up when it is made.
      if (output && context) output.gain.setTargetAtTime(0.9 * volume, context.currentTime, 0.04);
    },
    dispose() {
      disposed = true;
      shots.clear();
      void context?.close();
    },
  };
}
