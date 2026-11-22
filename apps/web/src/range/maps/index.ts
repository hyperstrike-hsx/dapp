import { buildRange } from "../environment";
import type { RangeEnvironment, RangeOptions } from "../kit";
import type { RangeMapId } from "../mapList";
import { buildMetro } from "./metro";
import { buildDocks } from "./docks";
import { buildHangar } from "./hangar";
import { buildBazaar } from "./bazaar";
import { buildOutpost } from "./outpost";
import { buildCourtyard } from "./courtyard";
import { buildPiazza } from "./piazza";
import { buildReactor } from "./reactor";
import { buildRooftop } from "./rooftop";
import { buildYard } from "./yard";
import { buildVault } from "./vault";
import { buildCanal } from "./canal";
import { buildRuin } from "./ruin";
import { buildGlasshouse } from "./glasshouse";
import { buildDam } from "./dam";
import { buildCinema } from "./cinema";
import { buildOffice } from "./office";

const BUILDERS: Record<RangeMapId, (options: RangeOptions) => RangeEnvironment> = {
  foundry: buildRange,
  courtyard: buildCourtyard,
  reactor: buildReactor,
  piazza: buildPiazza,
  rooftop: buildRooftop,
  metro: buildMetro,
  docks: buildDocks,
  hangar: buildHangar,
  bazaar: buildBazaar,
  outpost: buildOutpost,
  yard: buildYard,
  vault: buildVault,
  canal: buildCanal,
  ruin: buildRuin,
  glasshouse: buildGlasshouse,
  dam: buildDam,
  cinema: buildCinema,
  office: buildOffice,
};

export function buildMap(id: RangeMapId, options: RangeOptions): RangeEnvironment {
  return BUILDERS[id](options);
}
