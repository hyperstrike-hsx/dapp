import { useCallback, useState } from "react";
import { SoccerWorld } from "./SoccerWorld";
import {
  createSportsReceipt,
  readSportsReceipts,
  SPORTS_DEMO_KEY,
  sportsDemoMarkets,
  sportsDemoPrices,
} from "./sportsDemoData";
import type { VoteCount, VoteSide } from "./types";
import "./sports.css";

const empty: VoteCount = { YES: 0, NO: 0 };
export default function SportsDemo({
  onBack,
  onPortfolio,
}: {
  onBack: () => void;
  onPortfolio: () => void;
}) {
  const [outcome, setOutcome] = useState(90001);
  const [kicks, setKicks] = useState<Record<number, VoteCount>>({});
  const [side, setSide] = useState<VoteSide>("YES");
  const [ready, setReady] = useState(false);
  const [review, setReview] = useState<{
    outcome: number;
    side: VoteSide;
    contracts: number;
  } | null>(null);
  const [message, setMessage] = useState("");
  const market = sportsDemoMarkets.find((m) => m.outcome === outcome)!;
  const counts = kicks[outcome] ?? empty;
  const prices = sportsDemoPrices[outcome];
  const onReady = useCallback(() => setReady(true), []);
  const onKick = useCallback(
    (kickSide: VoteSide, multiplier: number, marketId: number) => {
      setKicks((previous) => ({
        ...previous,
        [marketId]: {
          ...(previous[marketId] ?? empty),
          [kickSide]: (previous[marketId]?.[kickSide] ?? 0) + multiplier,
        },
      }));
      setSide(kickSide);
    },
    [],
  );
  const save = () => {
    if (!review) return;
    try {
      const receipt = createSportsReceipt(
        review.outcome,
        review.side,
        review.contracts,
      );
      localStorage.setItem(
        SPORTS_DEMO_KEY,
        JSON.stringify([receipt, ...readSportsReceipts()]),
      );
      setKicks((previous) => ({
        ...previous,
        [review.outcome]: {
          ...(previous[review.outcome] ?? empty),
          [review.side]: Math.max(
            0,
            (previous[review.outcome]?.[review.side] ?? 0) - review.contracts,
          ),
        },
      }));
      setReview(null);
      setMessage(
        `Saved ${receipt.contracts} ${receipt.side} contracts for ${receipt.marketName} to your demo portfolio.`,
      );
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "Unable to save. Your draft is unchanged.",
      );
    }
  };
  return (
    <section className="sports-demo">
      <header className="sports-heading">
        <div>
          <span className="overline">HYPERSTRIKE ARENA / WORLD CUP REPLAY</span>
          <h1>
            Big stage. <em>Your call.</em>
          </h1>
          <p>Pick a side. Time your strike. Put your prediction in the net.</p>
        </div>
        <button onClick={onBack}>← BACK TO MARKETS</button>
      </header>
      <div className="sports-demo-banner">
        <strong>EXHIBITION MODE</strong>
        <span>
          Retired event · Demo prices · No real orders, payouts or token burns
        </span>
        <span className="sports-mode-dot">NO WALLET NEEDED</span>
      </div>
      <div className="sports-layout">
        <div className="sports-stage">
          <div className="stadium-broadcast">
            <span>
              <i /> COMMANDER ARENA
            </span>
            <b>{market.name.toUpperCase()} / TROPHY CALL</b>
            <span>DEMO REPLAY</span>
          </div>
          <SoccerWorld
            market={market}
            prices={prices}
            kicks={counts}
            onKick={onKick}
            onReady={onReady}
            paused={Boolean(review)}
          />
          {!ready && (
            <div className="sports-loading">OPENING THE DEMO STADIUM…</div>
          )}
        </div>
        <aside className="sports-ticket">
          <div className="sports-ticket-heading">
            <span className="overline">01 / CHOOSE YOUR TEAM</span>
            <span>4 TEAMS</span>
          </div>
          <div className="sports-countries">
            {sportsDemoMarkets.map((m) => (
              <button
                key={m.outcome}
                aria-pressed={m.outcome === outcome}
                onClick={() => {
                  setOutcome(m.outcome);
                  setReview(null);
                  setMessage("");
                }}
              >
                {m.name}
                <small>
                  {Math.round(sportsDemoPrices[m.outcome].YES * 100)}¢ YES
                </small>
              </button>
            ))}
          </div>
          <span className="sports-question-label">THE PREDICTION</span>
          <h2>{market.name} to lift the trophy?</h2>
          <p>
            Aim left for YES or right for NO. Click the pitch when the gauge
            reaches your desired power. Each goal stages 1–100 demo contracts.
          </p>
          <div className="sports-sides">
            {(["YES", "NO"] as const).map((s) => (
              <button
                key={s}
                aria-pressed={side === s}
                onClick={() => {
                  setSide(s);
                  setReview(null);
                }}
              >
                {s} · {Math.round(prices[s] * 100)}¢
                <small>{counts[s]} staged</small>
              </button>
            ))}
          </div>
          <dl>
            <dt>Selected contracts</dt>
            <dd>{counts[side]}</dd>
            <dt>Demo order value</dt>
            <dd>${(counts[side] * prices[side]).toFixed(2)}</dd>
            <dt>Real funds / token burns</dt>
            <dd>None</dd>
          </dl>
          {review ? (
            <div className="sports-review">
              <strong>
                Confirm {review.contracts} {review.side} demo contracts?
              </strong>
              <p>
                $
                {(
                  review.contracts *
                  sportsDemoPrices[review.outcome][review.side]
                ).toFixed(2)}{" "}
                demo USD · Stored in this browser only.
              </p>
              <button onClick={save}>SAVE DEMO PREDICTION</button>
              <button onClick={() => setReview(null)}>CANCEL</button>
            </div>
          ) : (
            <button
              className="sports-primary"
              disabled={!counts[side]}
              onClick={() =>
                setReview({ outcome, side, contracts: counts[side] })
              }
            >
              REVIEW DEMO PREDICTION →
            </button>
          )}
          {message && (
            <p role="status" className="sports-message">
              {message}
            </p>
          )}
          <button className="sports-portfolio" onClick={onPortfolio}>
            YOUR DEMO POSITIONS ↗
          </button>
        </aside>
      </div>
      <div className="sports-playbook">
        {[
          ["01", "Choose your side", "Aim left for YES. Aim right for NO."],
          [
            "02",
            "Time your strike",
            "Click or press Space to lock 1–100 contracts.",
          ],
          [
            "03",
            "Make it count",
            "Review and save. Kicks alone do not submit.",
          ],
        ].map(([n, title, text]) => (
          <div key={n}>
            <b>{n}</b>
            <span>
              <strong>{title}</strong>
              <small>{text}</small>
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}
