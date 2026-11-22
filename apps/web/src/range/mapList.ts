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
  {
    id: "yard", code: "11", name: "SIDING", line: "Freight yard · night rain",
    brief: "A freight yard at night in steady rain. Boxcars standing on the sidings, signal lamps on their gantry, floodlights hanging in the wet and every puddle holding a light.",
    setting: "Outdoor · rail yard", light: "Night, floodlights and signals", air: "Rain, low mist", sound: "Rain on steel, an idling diesel, couplers",
  },
  {
    id: "vault", code: "12", name: "VAULT", line: "Bank hall · after closing",
    brief: "A banking hall after the doors have shut. Marble underfoot, brass grilles at the counters and the round vault door standing open on walls of deposit boxes.",
    setting: "Indoor · banking hall", light: "Lay light, green desk lamps", air: "Still, faint dust", sound: "Time lock ticking, ventilation, a far alarm bell",
  },
  {
    id: "canal", code: "13", name: "BACKWATER", line: "Canal quarter · dawn mist",
    brief: "A quay in a canal quarter just after sunrise. Stone edges, moored boats and a footbridge, with the far houses lost in mist off the water.",
    setting: "Outdoor · canal quay", light: "Low dawn sun through mist", air: "Mist off the water", sound: "Lapping water, mooring ropes, far bells",
  },
  {
    id: "ruin", code: "14", name: "CANOPY", line: "Jungle ruin · green light",
    brief: "The court of a ruin deep in forest. Stone terraces under roots and creepers, sun coming down through the leaves in shafts and the air heavy with damp.",
    setting: "Outdoor · forest ruin", light: "Sun shafts through leaves", air: "Humid haze", sound: "Insects, dripping leaves, far thunder",
  },
  {
    id: "glasshouse", code: "15", name: "GLASSHOUSE", line: "Palm house · filtered sun",
    brief: "A palm house of white iron and glass. Tall palms and ferns in raised beds, sun striped by the glazing bars and mist drifting from the sprays.",
    setting: "Indoor · glass and iron", light: "Sun through glazing", air: "Warm mist", sound: "Misters, ticking pipes, sparrows in the roof",
  },
  {
    id: "dam", code: "16", name: "SPILLWAY", line: "Dam foot · spray and sun",
    brief: "The apron at the foot of a dam in a rock gorge. The concrete face rising overhead, a gate running white and spray drifting across the sun.",
    setting: "Outdoor · gorge", light: "High sun, spray haze", air: "Drifting spray", sound: "Roaring water, turbine whine, wind in the gorge",
  },
  {
    id: "cinema", code: "17", name: "MATINEE", line: "Old cinema · projector beam",
    brief: "The auditorium of an old picture house with nobody in it. Velvet rows, gilt plaster and a single projector beam cutting through the haze to the screen.",
    setting: "Indoor · auditorium", light: "Projector beam, aisle lamps", air: "Dusty haze", sound: "Projector clatter, old ventilation, a seat creaking",
  },
  {
    id: "office", code: "18", name: "AFTER HOURS", line: "Trading floor · dusk",
    brief: "A trading floor after the close. Rows of dark desks and sleeping screens, ticker boards still running and the city going dusk through the blinds.",
    setting: "Indoor · office floor", light: "Dusk through blinds, screens", air: "Clear, conditioned", sound: "Server fans, air handling, a phone ringing out",
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
