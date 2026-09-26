import { useState } from "react";
import { demoMarkets } from "./markets";
import { IndexBadge } from "./IndexViews";
import { human, money, type Position, type Tape } from "./TradeTicket";
import { positionMetrics } from "./positionMetrics";
import type { IndexMarket } from "./types";

export function PaperPortfolio({
  positions,
  reserves,
  balance,
  events,
  onSelect,
  onExplore,
}: {
  positions: Position[];
  reserves: Record<string, Tape>;
  balance: string;
  events: { at: number; label: string }[];
  onSelect: (market: IndexMarket, side: "YES" | "NO") => void;
  onExplore: () => void;
}) {
  const [filter, setFilter] = useState<"ALL" | "YES" | "NO">("ALL");
  const [sort, setSort] = useState("recent");
  const rows = positions.map((position) => {
    const market = demoMarkets.find((m) => m.id === position.marketId);
    const tradable = Boolean(
      market && Date.now() / 1000 < market.definition.tradeCloseTime,
    );
    return {
      position,
      market,
      tradable,
      ...positionMetrics(position, reserves[position.marketId], tradable),
    };
  });
  const cost = rows.reduce((sum, row) => sum + row.cost, 0);
  const visible = rows
    .filter((r) => filter === "ALL" || r.position.side === filter)
    .sort((a, b) =>
      sort === "cost"
        ? b.cost - a.cost
        : b.position.createdAt - a.position.createdAt,
    );
  return (
    <section className="paper-portfolio">
      <div className="portfolio-summary">
        <div className="balance-stat">
          <span>AVAILABLE PAPER CASH</span>
          <b>${human(money(balance))}</b>
          <small>Simulated USD · No real funds</small>
        </div>
        <div>
          <span>OPEN POSITIONS</span>
          <b>{positions.length.toString().padStart(2, "0")}</b>
          <small>Across your index predictions</small>
        </div>
        <div>
          <span>REMAINING COST BASIS</span>
          <b>${human(cost)}</b>
          <small>Excludes positions already sold</small>
        </div>
      </div>
      <div className="position-toolbar">
        <div>
          <h2>
            Your positions <span>{positions.length}</span>
          </h2>
          <p>The thesis. The exposure. The next move.</p>
        </div>
        <div className="position-controls">
          <div className="segment-control" aria-label="Filter positions">
            {(["ALL", "YES", "NO"] as const).map((f) => (
              <button
                key={f}
                aria-pressed={filter === f}
                onClick={() => setFilter(f)}
              >
                {f === "ALL" ? "All outcomes" : f}
              </button>
            ))}
          </div>
          <select
            aria-label="Sort positions"
            value={sort}
            onChange={(e) => setSort(e.target.value)}
          >
            <option value="recent">Recent first</option>
            <option value="cost">Largest cost first</option>
          </select>
        </div>
      </div>
      {!positions.length ? (
        <div className="portfolio-empty">
          <div className="empty-reticle" aria-hidden="true">
            ＋
          </div>
          <span className="overline">
            NO POSITIONS. PLENTY OF POSSIBILITIES.
          </span>
          <h2>What’s your read on the market?</h2>
          <p>
            Take a paper position on the CS2 economy. Track your entry, review
            your exposure, and practice an exit before going live.
          </p>
          <button className="primary" onClick={onExplore}>
            EXPLORE MARKETS ↗
          </button>
        </div>
      ) : !visible.length ? (
        <div className="portfolio-empty">
          <h2>No positions on {filter} yet.</h2>
          <button className="text-link" onClick={() => setFilter("ALL")}>
            SHOW ALL POSITIONS →
          </button>
        </div>
      ) : (
        <div className="position-cards">
          {visible.map((row) => (
            <article
              className={`position-card position-card--${row.position.side.toLowerCase()}`}
              key={row.position.id}
            >
              <header>
                <IndexBadge ticker={row.position.name} />
                <span
                  className={`outcome-pill ${row.position.side.toLowerCase()}`}
                >
                  {row.position.side} POSITION
                </span>
                <span className="position-mode">PAPER</span>
              </header>
              <h3>
                {row.market?.question ??
                  `${row.position.name} · Previous expiry`}
              </h3>
              <p className="position-expiry">
                {row.market
                  ? `Closes ${new Date(row.market.definition.tradeCloseTime * 1000).toLocaleString()}`
                  : "Historical position · Current market quote unavailable"}
              </p>
              <div className="position-value">
                <div>
                  <span>ESTIMATED EXIT VALUE</span>
                  <strong>
                    {row.exitValue === null ? "—" : `$${human(row.exitValue)}`}
                  </strong>
                </div>
                <div className={row.pnl !== null && row.pnl < 0 ? "no" : "yes"}>
                  <span>UNREALIZED P&L</span>
                  <b>
                    {row.pnl === null
                      ? "Unavailable"
                      : `${row.pnl >= 0 ? "+" : "−"}$${human(Math.abs(row.pnl))}`}
                  </b>
                </div>
              </div>
              <dl className="position-details">
                <div>
                  <dt>Contracts</dt>
                  <dd>{human(row.contracts)}</dd>
                </div>
                <div>
                  <dt>Average entry</dt>
                  <dd>
                    {row.entryCents === null
                      ? "—"
                      : `${human(row.entryCents)}¢`}
                  </dd>
                </div>
                <div>
                  <dt>Cost basis</dt>
                  <dd>${human(row.cost)}</dd>
                </div>
              </dl>
              <div className="position-scenario">
                <span>
                  If {row.position.side} wins <b>${human(row.winningPayout)}</b>
                </span>
                <small>Illustrative gross payout · $0 if it loses</small>
              </div>
              <footer>
                <small>
                  {row.tradable
                    ? "Exit estimate includes sell fee & price impact."
                    : "Trading unavailable for this expiry."}
                </small>
                <button
                  disabled={!row.tradable || !row.market}
                  onClick={() =>
                    row.market && onSelect(row.market, row.position.side)
                  }
                >
                  MANAGE ↗
                </button>
              </footer>
            </article>
          ))}
        </div>
      )}
      <details className="portfolio-activity" open={events.length > 0}>
        <summary>
          Trade activity <span>{events.length} records</span>
        </summary>
        {events.length ? (
          events.slice(0, 20).map((event, i) => (
            <div key={`${event.at}-${i}`}>
              <span className="activity-dot" />
              <span>{event.label}</span>
              <time>{new Date(event.at).toLocaleString()}</time>
            </div>
          ))
        ) : (
          <p>Your confirmed paper trades will appear here.</p>
        )}
      </details>
      <p className="portfolio-disclaimer">
        Browser-local simulation. Estimates are not guaranteed fills;
        conditional payouts are not earnings. Paper positions do not settle or
        redeem onchain.
      </p>
    </section>
  );
}
