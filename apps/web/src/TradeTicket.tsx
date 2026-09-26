import { useEffect, useRef, useState } from "react";
import { quoteBuy, quoteSell } from "@hyperstrike/sdk";
import type { IndexMarket, VoteCount, VoteSide } from "./types";
import { IndexBadge } from "./IndexViews";
export type Position = {
  id: string;
  marketId: string;
  name: string;
  side: VoteSide;
  tokens: string;
  spent: string;
  createdAt: number;
};
export type Tape = { yes: string; no: string };
export const money = (v: bigint | string) => Number(v) / 1e6;
export const human = (v: number) =>
  v.toLocaleString("en-US", { maximumFractionDigits: 2 });
export function TradeTicket({
  market,
  votes,
  tape,
  positions,
  onClose,
  onTrade,
  initialSide,
  initialAction = "BUY",
}: {
  market: IndexMarket;
  votes: VoteCount;
  tape: Tape;
  positions: Position[];
  onClose: () => void;
  onTrade: (m: IndexMarket, s: VoteSide, a: "BUY" | "SELL", v: bigint) => void;
  initialSide?: VoteSide;
  initialAction?: "BUY" | "SELL";
}) {
  const [side, setSide] = useState<VoteSide>(
      initialSide ?? (votes.NO > votes.YES ? "NO" : "YES"),
    ),
    [action, setAction] = useState<"BUY" | "SELL">(initialAction),
    [amount, setAmount] = useState(() =>
      initialAction === "SELL"
        ? String(
            money(
              positions.find(
                (p) => p.marketId === market.id && p.side === initialSide,
              )?.tokens ?? "0",
            ),
          )
        : "25",
    ),
    [reviewAt, setReviewAt] = useState(0),
    [error, setError] = useState("");
  const dialog = useRef<HTMLElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "Tab") {
        const controls = dialog.current?.querySelectorAll<HTMLElement>(
          "button:not(:disabled), input, select",
        );
        if (!controls?.length) return;
        const first = controls[0],
          last = controls[controls.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("keydown", key);
      previous?.focus();
    };
  }, [onClose]);
  const input = Number(amount);
  let quote: { tokens?: bigint; collateral?: bigint; fee: bigint } | null =
    null;
  try {
    if (Number.isFinite(input) && input > 0 && input <= 1e6)
      quote =
        action === "BUY"
          ? quoteBuy(
              BigInt(tape.yes),
              BigInt(tape.no),
              side,
              BigInt(Math.floor(input * 1e6)),
            )
          : quoteSell(
              BigInt(tape.yes),
              BigInt(tape.no),
              side,
              BigInt(Math.floor(input * 1e6)),
            );
  } catch {
    /* Invalid amounts cannot be submitted. */
  }
  const output = quote
    ? "tokens" in quote
      ? quote.tokens!
      : quote.collateral!
    : 0n;
  const spot =
    Number(side === "YES" ? tape.no : tape.yes) /
    (Number(tape.yes) + Number(tape.no));
  const avg = quote
    ? action === "BUY"
      ? input / money(output)
      : money(output) / input
    : 0;
  const held = positions.find(
    (p) => p.marketId === market.id && p.side === side,
  );
  const submit = () => {
    try {
      if (!quote) return;
      if (!reviewAt) {
        setReviewAt(Date.now());
        return;
      }
      if (Date.now() - reviewAt > 120000) {
        setReviewAt(0);
        throw new Error("Quote expired. Review again.");
      }
      onTrade(market, side, action, BigInt(Math.floor(input * 1e6)));
      setReviewAt(0);
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Trade failed");
      setReviewAt(0);
    }
  };
  const staged = votes[side];
  const useHits = () => {
    let lo = 2n,
      hi = BigInt(staged) * 2_000_000n;
    while (lo < hi) {
      const mid = (lo + hi) / 2n;
      const q = quoteBuy(BigInt(tape.yes), BigInt(tape.no), side, mid);
      if (q.tokens < BigInt(staged) * 1_000_000n) lo = mid + 1n;
      else hi = mid;
    }
    setAmount((Number(lo) / 1e6).toFixed(6));
    setAction("BUY");
    setReviewAt(0);
  };
  return (
    <div className="ticket-backdrop" onClick={onClose}>
      <aside
        ref={dialog}
        tabIndex={-1}
        className="native-ticket"
        role="dialog"
        aria-modal="true"
        aria-label="Review index prediction"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          className="ticket-close"
          onClick={onClose}
          aria-label="Close trade ticket"
        >
          ×
        </button>
        <span className="overline">INDEX MARKET / PAPER SANDBOX</span>
        <IndexBadge ticker={market.name} />
        <h2>{market.question}</h2>
        <p className="ticket-expiry">
          {market.resolves} · Native binary market
        </p>
        <div className="trade-tabs">
          {(["BUY", "SELL"] as const).map((v) => (
            <button
              key={v}
              className={v === action ? "active" : ""}
              onClick={() => {
                setAction(v);
                setReviewAt(0);
              }}
            >
              {v}
            </button>
          ))}
        </div>
        <div className="outcome-buttons">
          {(["YES", "NO"] as VoteSide[]).map((v) => (
            <button
              key={v}
              className={v === side ? `active ${v.toLowerCase()}` : ""}
              onClick={() => {
                setSide(v);
                setReviewAt(0);
              }}
            >
              {v}{" "}
              <b>
                {Math.round(
                  (Number(v === "YES" ? tape.no : tape.yes) /
                    (Number(tape.yes) + Number(tape.no))) *
                    100,
                )}
                ¢
              </b>
            </button>
          ))}
        </div>
        <label className="native-input">
          <span>
            {action === "BUY"
              ? "COLLATERAL / PAPER USD"
              : "OUTCOME TOKENS TO SELL"}
          </span>
          <input
            type="number"
            min="0.000001"
            max="1000000"
            step="0.01"
            value={amount}
            onChange={(e) => {
              setAmount(e.target.value);
              setReviewAt(0);
            }}
          />
          <small>
            {action === "SELL"
              ? `${human(held ? money(held.tokens) : 0)} ${side} available`
              : "20 bps trading fee · No participation burn"}
          </small>
        </label>
        {staged > 0 && (
          <button className="staged-contracts" onClick={useHits}>
            {staged} {side} hits staged · Price these contracts →
          </button>
        )}
        <dl className="ticket-metrics">
          <dt>
            {action === "BUY" ? "Expected tokens" : "Expected collateral"}
          </dt>
          <dd>{human(money(output))}</dd>
          <dt>Average probability</dt>
          <dd>{human(avg * 100)}¢</dd>
          <dt>Price impact</dt>
          <dd>{human(Math.abs(avg - spot) * 100)} pp</dd>
          <dt>Trading fee</dt>
          <dd>${quote ? money(quote.fee).toFixed(4) : "—"}</dd>
          <dt>Minimum received / 1% tolerance</dt>
          <dd>{human(money((output * 99n) / 100n))}</dd>
          <dt>Quote validity</dt>
          <dd>2 minutes</dd>
        </dl>
        <div className="settlement-note">
          <b>THE SETTLEMENT RULE</b>
          <p>
            {market.definition.direction === "UP"
              ? "At or above"
              : "At or below"}{" "}
            {human(Number(market.definition.thresholdE8) / 1e8)} at expiry.
            Canonical index TWAP over ±5 minutes; ±15-minute fallback.
            Unresolvable after 24h: each side pays 0.5.
          </p>
          <small>
            Trading closes 5 minutes before resolution. Sandbox markets have no
            canonical oracle settlement.
          </small>
        </div>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <button className="primary full" disabled={!quote} onClick={submit}>
          {reviewAt
            ? `CONFIRM PAPER ${action} · ${side}`
            : `REVIEW ${action} →`}
        </button>
        <p className="ticket-disclosure">
          Paper USD. Simulated reserves. No wallet transaction or HSX burn. A
          target hit stages a contract; confirmation saves the trade.
        </p>
      </aside>
    </div>
  );
}
