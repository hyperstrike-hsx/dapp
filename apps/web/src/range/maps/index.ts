import { buildRange } from "../environment";
import type { RangeEnvironment, RangeOptions } from "../kit";
import type { RangeMapId } from "../mapList";
import { buildCourtyard } from "./courtyard";
import { buildPiazza } from "./piazza";
import { buildReactor } from "./reactor";
import { buildRooftop } from "./rooftop";

const BUILDERS: Record<RangeMapId, (options: RangeOptions) => RangeEnvironment> = {
  foundry: buildRange,
  courtyard: buildCourtyard,
  reactor: buildReactor,
  piazza: buildPiazza,
  rooftop: buildRooftop,
};

export function buildMap(id: RangeMapId, options: RangeOptions): RangeEnvironment {
  return BUILDERS[id](options);
}
