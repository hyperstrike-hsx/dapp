import { useEffect, useState } from "react";
import { INDEXES } from "./markets";
import type {
  IndicativeFeed,
  IndicativeIndex,
} from "@hyperstrike/market-types";

export function useIndicativeIndexes() {
  const [feed, setFeed] = useState<IndicativeFeed | null>(null);
  useEffect(() => {
    let alive = true;
    const controller = new AbortController();
    const refresh = async () => {
      try {
        const response = await fetch("/v1/indicative/indexes", {
          signal: AbortSignal.any([
            controller.signal,
            AbortSignal.timeout(20000),
          ]),
        });
        if (!response.ok) throw Error("Feed unavailable");
        const next = (await response.json()) as IndicativeFeed;
        if (!Array.isArray(next.indexes) || next.source !== "Skinport")
          throw Error("Invalid feed");
        if (alive) setFeed(next);
      } catch {
        if (alive)
          setFeed((previous) =>
            previous
              ? {
                  ...previous,
                  error: "Connection lost. Last values are not current quotes.",
                  indexes: previous.indexes.map((i) => ({
                    ...i,
                    status: i.value === null ? "UNAVAILABLE" : "STALE",
                  })),
                }
              : {
                  source: "Skinport",
                  sourceUrl: "https://skinport.com/",
                  currency: "USD",
                  methodology: "skinport-ask-preview-v1",
                  checkedAt: Math.floor(Date.now() / 1000),
                  error: "Price API unavailable.",
                  indexes: INDEXES.map((i) => ({
                    ticker: i.ticker,
                    indexId: i.indexId,
                    provenance: "INDICATIVE",
                    settlementEligible: false,
                    status: "UNAVAILABLE",
                    value: null,
                    changeSinceBasePct: null,
                    baseAt: null,
                    observedAt: null,
                    coverage: 0,
                    count: i.count,
                    constituents: [],
                    history: [],
                  })),
                },
          );
      }
    };
    void refresh();
    const timer = setInterval(refresh, 60000);
    return () => {
      alive = false;
      controller.abort();
      clearInterval(timer);
    };
  }, []);
  return feed;
}
export const previewValue = (index?: IndicativeIndex) =>
  index?.value == null
    ? "—"
    : index.value.toLocaleString("en-US", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      });
const timestamp = (time: number | null) =>
  time ? new Date(time * 1000).toLocaleString() : "Not available";

export function PreviewChart({ index }: { index?: IndicativeIndex }) {
  const points = index?.history ?? [];
  if (points.length < 2)
    return (
      <div className="preview-chart-empty">
        {index?.value != null
          ? "Baseline captured. History builds with new source updates."
          : index?.status === "UNAVAILABLE"
            ? "Price feed unavailable. No prices have been invented."
            : "Connecting to the public price feed…"}
      </div>
    );
  const values = points.map((p) => p.value),
    min = Math.min(...values),
    max = Math.max(...values);
  const start = points[0].observedAt,
    duration = points.at(-1)!.observedAt - start;
  const path = points
    .map(
      (p, i) =>
        `${i ? "L" : "M"}${10 + (580 * (p.observedAt - start)) / (duration || 1)} ${max === min ? 60 : 105 - ((p.value - min) / (max - min)) * 90}`,
    )
    .join(" ");
  return (
    <svg
      className="preview-chart"
      viewBox="0 0 600 120"
      role="img"
      aria-label={`Indicative Skinport ask-price history, ${points.length} observations. Not settlement data.`}
    >
      {[15, 60, 105].map((y) => (
        <line key={y} x1="0" x2="600" y1={y} y2={y} stroke="#ffffff12" />
      ))}
      <path d={path} fill="none" stroke="#a7edda" strokeWidth="2" />
    </svg>
  );
}
export function PreviewSummary({ index }: { index?: IndicativeIndex }) {
  const change =
    index?.changeSinceBasePct == null
      ? null
      : Math.round(index.changeSinceBasePct * 100) / 100;
  return (
    <div className="preview-summary">
      <span className="preview-label">
        INDICATIVE ·{" "}
        {index?.status === "OK"
          ? "SKINPORT USD ASKS"
          : (index?.status ?? "CONNECTING")}
      </span>
      <strong>{previewValue(index)}</strong>
      <div className="preview-metrics">
        <span>
          {change == null
            ? "—"
            : `${change >= 0 ? "+" : ""}${change.toFixed(2)}%`}{" "}
          <small>SINCE BASE</small>
        </span>
        <span>
          {index?.coverage ?? 0}/{index?.count ?? "—"} <small>COVERAGE</small>
        </span>
      </div>
      <PreviewChart index={index} />
      <small>
        NOT FOR SETTLEMENT ·{" "}
        {index?.observedAt
          ? `SOURCE ${timestamp(index.observedAt)}`
          : "NO SOURCE OBSERVATION YET"}
      </small>
    </div>
  );
}
export function PreviewDetail({ index }: { index?: IndicativeIndex }) {
  return (
    <section className="preview-detail">
      <div>
        <span className="overline">LIVE MARKET PREVIEW / DISPLAY ONLY</span>
        <h2>The market, in perspective.</h2>
        <p>
          Public{" "}
          <a href="https://skinport.com/" target="_blank" rel="noreferrer">
            Skinport
          </a>{" "}
          minimum listing prices in USD, refreshed every five minutes. This is
          an ask-price proxy, not executed sales, a USDC quote, or an approved
          settlement benchmark.
        </p>
        <p>
          Frozen preview basket, rebased to 1,000 on{" "}
          {timestamp(index?.baseAt ?? null)}. No historical returns are
          invented. Missing constituents make the last complete value stale.
        </p>
        {index?.ticker === "HS-BLUE20" && (
          <p>
            BLUE20 preview uses weapon skins priced at $250 or more when
            selected. It does not yet represent the approved premium-collectible
            universe.
          </p>
        )}
      </div>
      <PreviewSummary index={index} />
      <details className="preview-composition">
        <summary>
          Preview basket · {index?.constituents.length ?? 0} constituents ·
          exact weights
        </summary>
        <p>
          Selected by listed inventory (not trading volume) at first
          initialization. Membership and base prices persist on the server. This
          composition is separate from the canonical index below.
        </p>
        <div className="preview-table-scroll">
          <table>
            <thead>
              <tr>
                <th>Item / wear</th>
                <th>Weight</th>
                <th>Base USD</th>
                <th>Latest USD ask</th>
              </tr>
            </thead>
            <tbody>
              {index?.constituents.map((c) => (
                <tr key={c.name}>
                  <td>{c.name}</td>
                  <td>{(c.weight * 100).toFixed(2)}%</td>
                  <td>${c.baseUsd.toFixed(2)}</td>
                  <td>
                    {c.priceUsd == null
                      ? "Unavailable"
                      : `$${c.priceUsd.toFixed(2)}`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </section>
  );
}
