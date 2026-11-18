// The selectable ranges. Kept free of renderer imports so the app shell can list
// them without loading three.js; the builders live in ./maps.

export const RANGE_MAPS = [
  { id: "foundry", code: "01", name: "FOUNDRY", line: "Sealed warehouse · roof-light sun" },
  { id: "courtyard", code: "02", name: "DUST COURT", line: "Desert courtyard · midday heat" },
  { id: "reactor", code: "03", name: "CORE HALL", line: "Reactor hall · cold light" },
  { id: "piazza", code: "04", name: "PIAZZA", line: "Old-town square · low sun after rain" },
  { id: "rooftop", code: "05", name: "NIGHTLINE", line: "City rooftop · after dark" },
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
