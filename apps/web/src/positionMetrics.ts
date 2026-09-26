import { quoteSell } from "@hyperstrike/sdk";
import type { Position, Tape } from "./TradeTicket";

/** Estimate an entire position's exit, including AMM impact and the sell fee. */
export function positionMetrics(
  position: Position,
  tape?: Tape,
  tradable = true,
) {
  const contracts = Number(position.tokens) / 1e6;
  const cost = Number(position.spent) / 1e6;
  let exitValue: number | null = null;
  if (tape && tradable) {
    try {
      exitValue =
        Number(
          quoteSell(
            BigInt(tape.yes),
            BigInt(tape.no),
            position.side,
            BigInt(position.tokens),
          ).collateral,
        ) / 1e6;
    } catch {
      /* An unquotable position must never appear to have a zero value. */
    }
  }
  return {
    contracts,
    cost,
    entryCents: contracts > 0 ? (cost / contracts) * 100 : null,
    exitValue,
    pnl: exitValue === null ? null : exitValue - cost,
    winningPayout: contracts,
  };
}
