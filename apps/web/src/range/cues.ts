import type * as THREE from "three";

// Sounds a map, or the wildlife and weather in it, can ask for by name.
//
// A map never touches the audio engine: it says what happened and where ("a flock took off here",
// "the crane started moving there") and range/ambience.ts synthesises it, places it around the
// listener and sends it through the map's reverb. Nothing is downloaded. Add a name here and
// give it a voice in ambience.ts; an unknown name is a compile error, a known one never throws.
export const CUE_NAMES = [
  // Animals
  "wingsFlush", "pigeonCoo", "sparrowChirp", "gullCry", "crowCaw", "chickenCluck", "chickenSquawk", "dogBarkFar",
  // Wind and things it moves
  "windGust", "clothSnap", "leafRustle", "chimeTinkle", "ropeClank", "shutterCreak", "signCreak",
  // Water and weather
  "drip", "splash", "waveSlap", "icicleDrop", "snowSlide",
  // Trains and stations
  "trainPass", "trainBrake", "trainDoors", "paChime",
  // Harbour, airfield and street
  "craneMotor", "containerClang", "shipHorn", "buoyBell", "forkliftBeep", "airWrench", "jetWhine", "propPass", "heliPass",
  "sirenFar", "carPass", "hornFar", "scooterPass", "doorSlamFar",
  // Plant and workshop
  "steamHiss", "valveClunk", "relayClack", "alarmBlip", "sparkZap", "neonBuzz", "tubeFlicker", "hammerClank",
  "chainRattle", "quenchHiss", "generatorCough", "radioSquelch", "potClink", "bellToll",
  // Appended with the soundscapes: swifts over a square, steel ticking as it cools, a coppersmith's hammer,
  // crockery at a café table, a long public-address tone
  "swiftScream", "metalCreak", "copperTap", "cupClatter", "paTone",
  // Appended with the second set of ranges: thunder beyond the hills, a desk telephone ringing out, an escapement
  "thunderFar", "phoneRing", "clockTick",
] as const;

export type CueName = (typeof CUE_NAMES)[number];

export type CueOptions = {
  /** Loudness multiplier (default 1). */
  gain?: number;
  /** Playback pitch multiplier (default 1): vary it so repeats do not sound stamped. */
  pitch?: number;
};

/** Plays a named sound at a place in the world; omit `at` for one that comes from everywhere. */
export type Cue = (name: CueName, at?: THREE.Vector3 | null, options?: CueOptions) => void;
