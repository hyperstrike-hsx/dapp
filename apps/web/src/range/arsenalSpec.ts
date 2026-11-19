// Weapon roster and trigger logic. Pure data and functions: no rendering here.

export type FireMode = "AUTO" | "BURST" | "SEMI" | "BOLT" | "MELEE";
export type WeaponId = "ak47" | "m4" | "famas" | "uzi" | "rifle" | "knife";

export type WeaponSpec = {
  id: WeaponId;
  name: string;
  calibre: string;
  /** Selectable fire modes, first is the default. */
  modes: FireMode[];
  /** Cyclic rate in rounds per minute (for BOLT: unused, see cycleMs). */
  rpm: number;
  burst: number;
  magazine: number;
  reloadMs: number;
  /** Time to work the action between shots (bolt-action only). */
  cycleMs: number;
  damage: number;
  headshot: number;
  /** Viewmodel kick and how far each shot lifts the view (radians). */
  kick: number;
  climb: number;
  /** Magnification while aiming, and whether that is through an optic (which fills the view) or over the sights. */
  zoom: number;
  scope: boolean;
  /** A blade: no ammunition, and it only reaches this far (metres). */
  reach?: number;
};

export const ARSENAL: WeaponSpec[] = [
  { id: "ak47", name: "AK-47", calibre: "7.62×39", modes: ["AUTO", "SEMI"], rpm: 600, burst: 1, magazine: 30, reloadMs: 2500, cycleMs: 0, damage: 36, headshot: 3, kick: 0.115, climb: 0.0075, zoom: 1.35, scope: false },
  { id: "m4", name: "M4A1", calibre: "5.56×45", modes: ["AUTO", "BURST", "SEMI"], rpm: 800, burst: 3, magazine: 30, reloadMs: 2250, cycleMs: 0, damage: 30, headshot: 3, kick: 0.085, climb: 0.005, zoom: 2.5, scope: true },
  { id: "famas", name: "FAMAS F1", calibre: "5.56×45", modes: ["BURST", "AUTO"], rpm: 1000, burst: 3, magazine: 25, reloadMs: 2600, cycleMs: 0, damage: 28, headshot: 3, kick: 0.075, climb: 0.0045, zoom: 1.35, scope: false },
  { id: "uzi", name: "UZI", calibre: "9×19", modes: ["AUTO", "SEMI"], rpm: 620, burst: 1, magazine: 32, reloadMs: 2050, cycleMs: 0, damage: 22, headshot: 2.5, kick: 0.06, climb: 0.0032, zoom: 1.25, scope: false },
  { id: "rifle", name: "BOLT-ACTION 7.62", calibre: "7.62×54R", modes: ["BOLT"], rpm: 50, burst: 1, magazine: 5, reloadMs: 3100, cycleMs: 1150, damage: 190, headshot: 4, kick: 0.2, climb: 0.022, zoom: 4, scope: true },
  { id: "knife", name: "KNIFE", calibre: "COMBAT BLADE", modes: ["MELEE"], rpm: 100, burst: 1, magazine: 1, reloadMs: 0, cycleMs: 520, damage: 60, headshot: 0, kick: 0.05, climb: 0, zoom: 1, scope: false, reach: 1.75 },
];

export function nextMode(spec: WeaponSpec, mode: FireMode): FireMode {
  return spec.modes[(spec.modes.indexOf(mode) + 1) % spec.modes.length];
}

export type Trigger = { held: boolean; fresh: boolean; burstLeft: number; lastShot: number };

export function createTrigger(): Trigger {
  return { held: false, fresh: false, burstLeft: 0, lastShot: Number.NEGATIVE_INFINITY };
}

export function pressTrigger(trigger: Trigger) { trigger.held = true; trigger.fresh = true; }
export function releaseTrigger(trigger: Trigger) { trigger.held = false; }
/** Clears any press or burst in progress (reload, weapon switch, empty magazine). */
export function resetTrigger(trigger: Trigger) { trigger.fresh = false; trigger.burstLeft = 0; }

/**
 * Whether a round leaves the barrel at `now`. Call once per frame; when it
 * returns true the shot has been accounted for.
 */
export function takeShot(spec: WeaponSpec, mode: FireMode, trigger: Trigger, now: number): boolean {
  const interval = 60000 / spec.rpm;
  const since = now - trigger.lastShot;
  let fire = false;
  if (mode === "AUTO") {
    fire = trigger.held && since >= interval;
  } else if (mode === "SEMI") {
    fire = trigger.fresh && since >= interval;
  } else if (mode === "MELEE") {
    // Hold to keep slashing, one swing at a time.
    fire = (trigger.held || trigger.fresh) && since >= interval;
  } else if (mode === "BOLT") {
    fire = trigger.fresh && since >= spec.cycleMs;
  } else {
    // A burst runs to completion once started, then needs a short reset.
    if (trigger.burstLeft === 0 && trigger.fresh && since >= interval * 2.4) trigger.burstLeft = spec.burst;
    if (trigger.burstLeft > 0 && since >= interval) { trigger.burstLeft -= 1; fire = true; }
  }
  if (fire) { trigger.fresh = false; trigger.lastShot = now; }
  else if (!trigger.held && mode !== "BURST" && since >= Math.max(interval, spec.cycleMs)) trigger.fresh = false;
  return fire;
}
