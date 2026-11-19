// The selectable ranges. Kept free of renderer imports so the app shell can list
// them without loading three.js; the builders live in ./maps.
//
// `brief` and the four facts are what the briefing screen shows, so a visitor knows what a range
// looks and sounds like before loading it. Every range shares the same lanes, stations and targets.
export const RANGE_MAPS = [
  {
    id: "foundry", code: "01", name: "FOUNDRY", line: "Sealed warehouse · roof-light sun",
    brief: "The original range. A sealed steel warehouse with sun falling through the roof lights and the Strike furnace burning in the east wall.",
    setting: "Indoor · industrial", light: "Sun shafts, furnace glow", air: "Clear, light dust", sound: "Furnace roar, hammering, hard echo",
  },
  {
    id: "courtyard", code: "02", name: "DUST COURT", line: "Desert courtyard · midday heat",
    brief: "A walled courtyard in a desert town at noon. Hard sun on bleached plaster, deep shade under striped awnings.",
    setting: "Outdoor · walled court", light: "Overhead sun, hard shadows", air: "Clear, heat haze", sound: "Cicadas, sparrows, wind in the awnings",
  },
  {
    id: "reactor", code: "03", name: "CORE HALL", line: "Reactor hall · cold light",
    brief: "A tall reactor hall of concrete, pipework and gantries. Cold light from the roof, status lamps and steam at floor level.",
    setting: "Indoor · heavy plant", light: "Cold skylight, status lamps", air: "Thin steam haze", sound: "Coolant hum, relays, venting steam",
  },
  {
    id: "piazza", code: "04", name: "PIAZZA", line: "Old-town square · after rain",
    brief: "A small square in an old town just after a shower. Wet cobbles, painted fronts, shutters and a clock tower in low sun.",
    setting: "Outdoor · town square", light: "Low sun after rain", air: "Clear, wet reflections", sound: "Fountain, swifts, the bell",
  },
  {
    id: "rooftop", code: "05", name: "NIGHTLINE", line: "City rooftop · after dark",
    brief: "A rooftop high above a city at night. Neon along the parapet, lit towers on every side and the glow of the streets below.",
    setting: "Outdoor · rooftop", light: "Night, neon and city glow", air: "Clear night air", sound: "City roar, wind, far sirens",
  },
  {
    id: "metro", code: "06", name: "UNDERLINE", line: "Metro platform · sodium light",
    brief: "A metro platform deep underground with a train standing at the edge. Tiled walls, tube lights and tunnels running into the dark.",
    setting: "Indoor · underground", light: "Tube and sodium lamps", air: "Clear, dark tunnel ends", sound: "Tunnel air, trains, long echo",
  },
  {
    id: "docks", code: "07", name: "QUAYSIDE", line: "Container quay · dusk",
    brief: "A container quay at dusk. Stacked boxes, gantry cranes and a ship alongside under floodlights and a violet sky.",
    setting: "Outdoor · harbour", light: "Dusk, floodlights", air: "Clear, light sea haze", sound: "Lapping water, gulls, cranes and horns",
  },
  {
    id: "hangar", code: "08", name: "AIRFRAME", line: "Hangar · open doors at noon",
    brief: "An aircraft hangar with the doors rolled open at noon. An airframe on stands inside, the bright apron outside.",
    setting: "Indoor · open to the apron", light: "Noon daylight through the doors", air: "Clear", sound: "Big-room echo, door wind, jets",
  },
  {
    id: "bazaar", code: "09", name: "BAZAAR", line: "Covered market · cloth light",
    brief: "A covered market street. Sun filtered through coloured cloth onto stalls of fruit, jars, sacks and lanterns.",
    setting: "Indoor · covered street", light: "Filtered sun, lanterns", air: "Dusty light shafts", sound: "Coppersmith, hens, wind in the cloth",
  },
  {
    id: "outpost", code: "10", name: "WHITEOUT", line: "Alpine outpost · overcast snow",
    brief: "A supply outpost in deep snow under a flat white sky. Drifts against the cabins, marker lamps, everything fading into the weather.",
    setting: "Outdoor · alpine", light: "Overcast, flat", air: "Low visibility, snow haze", sound: "Howling wind, generator, muffled by snow",
  },
] as const;

export type RangeMapId = (typeof RANGE_MAPS)[number]["id"];

const KEY = "hyperstrike.range.map";
const known = (value: string | null): value is RangeMapId => RANGE_MAPS.some((map) => map.id === value);

/** The last range the visitor chose (a `?map=` query wins, for links and testing). */
export function storedRangeMap(): RangeMapId {
  try {
    const query = new URLSearchParams(window.location.search).get("map");
    if (known(query)) return query;
    const saved = window.localStorage.getItem(KEY);
    if (known(saved)) return saved;
  } catch { /* storage can be blocked; fall through to the default */ }
  return "foundry";
}

export function storeRangeMap(id: RangeMapId) {
  try { window.localStorage.setItem(KEY, id); } catch { /* not fatal */ }
}
