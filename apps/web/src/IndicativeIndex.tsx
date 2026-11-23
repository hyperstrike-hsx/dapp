import { useEffect, useState } from "react";
import { INDEXES } from "./markets";
import { API_ENABLED, INDEX_FEED_URL } from "./dataMode";
import {
  ageIndicativeFeed,
  isPreview,
  priorHistory,
  INDEX_BASE_AT,
} from "@hyperstrike/market-types";
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
        const response = await fetch(INDEX_FEED_URL, {
          cache: "no-store",
          signal: AbortSignal.any([
            controller.signal,
            AbortSignal.timeout(20000),
          ]),
        });
        if (!response.ok) throw Error("Feed unavailable");
        const next = (await response.json()) as IndicativeFeed;
        if (!Array.isArray(next.indexes) || typeof next.source !== "string")
          throw Error("Invalid feed");
        if (alive) setFeed(ageIndicativeFeed(next));
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
                  source: "",
                  sourceUrl: "",
                  currency: "USD",
                  methodology: "HS-MVA-1",
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
  return feed ? ageIndicativeFeed(feed) : null;
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
/** A calendar day in UTC, the clock the base day and the history floor are set on. */
const utcDay = (time: number, month: "long" | "short" = "short") =>
  new Date(time * 1000).toLocaleDateString("en-GB", {
    day: "numeric",
    month,
    year: "numeric",
    timeZone: "UTC",
  });
/** Header of the index board: says so while the series shown are still previews. */
export const boardNote = (indexes: IndicativeIndex[]) =>
  indexes.some(isPreview)
    ? `PREVIEW · BASE ${utcDay(INDEX_BASE_AT)}`.toUpperCase()
    : "INDICATIVE · BASE 1,000";
/** Where a series stands against the official base, in one line. */
export function basisNote(index?: IndicativeIndex) {
  if (!index?.baseAt) return null;
  if (isPreview(index))
    return `PREVIEW SERIES FROM ${utcDay(index.baseAt)} · OFFICIAL BASE OF 1,000 ON ${utcDay(INDEX_BASE_AT)}`.toUpperCase();
  const earlier = priorHistory(index).map(
    (segment) =>
      `${segment.provenance === "PREVIEW" ? "PREVIEW BASKET" : "BACKFILLED"} FROM ${utcDay(segment.points[0].observedAt)}`,
  );
  return `BASE 1,000 ON ${utcDay(index.baseAt)}${
    earlier.length
      ? ` · DASHED, NOT PART OF THE INDEX: ${earlier.join(", ")}, RESCALED TO MEET THE BASE`
      : ""
  }`.toUpperCase();
}

export function PreviewChart({ index }: { index?: IndicativeIndex }) {
  const points = index?.history ?? [];
  // History from before the base: drawn dashed, and never joined to the series.
  const earlier = index ? priorHistory(index).flatMap((s) => s.points) : [];
  if (!points.length || points.length + earlier.length < 2)
    return (
      <div className="preview-chart-empty">
        {index?.value != null
          ? "Baseline captured. History builds with new source updates."
          : index?.status === "UNAVAILABLE"
            ? "Price feed unavailable. No prices have been invented."
            : "Connecting to the public price feed…"}
      </div>
    );
  const values = [...earlier, ...points].map((p) => p.value),
    min = Math.min(...values),
    max = Math.max(...values);
  const start = (earlier[0] ?? points[0]).observedAt,
    duration = points.at(-1)!.observedAt - start;
  const x = (p: { observedAt: number }) =>
    10 + (580 * (p.observedAt - start)) / (duration || 1);
  const line = (run: { value: number; observedAt: number }[]) =>
    run
      .map(
        (p, i) =>
          `${i ? "L" : "M"}${x(p)} ${max - min < 0.005 ? 60 : 105 - ((p.value - min) / (max - min)) * 90}`,
      )
      .join(" ");
  const path = line(points),
    base = x(points[0]);
  return (
    <svg
      className="preview-chart"
      viewBox="0 0 600 120"
      role="img"
      aria-label={`Index history, ${points.length} multi-venue observations${earlier.length ? `, after ${earlier.length} earlier daily closes drawn dashed` : ""}.`}
    >
      {[15, 60, 105].map((y) => (
        <line key={y} x1="0" x2="600" y1={y} y2={y} stroke="#ffffff12" />
      ))}
      {earlier.length > 0 && (
        <>
          <path
            d={line([...earlier, points[0]])}
            className="preview-chart-prior"
          />
          <line
            x1={base}
            x2={base}
            y1="6"
            y2="120"
            className="preview-chart-base"
          />
        </>
      )}
      <path
        d={`${path} L590 120 L${base} 120 Z`}
        className="preview-chart-area"
      />
      <path d={path} fill="none" stroke="#a7edda" strokeWidth="2" />
    </svg>
  );
}
/** The change as displayed: two decimals, so a rounding residue never reads as a fall. */
const shown = (index: IndicativeIndex) =>
  Math.round(index.changeSinceBasePct! * 100) / 100 || 0;
export const changeLabel = (index?: IndicativeIndex) =>
  index?.changeSinceBasePct == null
    ? "—"
    : `${shown(index) >= 0 ? "+" : "−"}${Math.abs(shown(index)).toFixed(2)}%`;
export const trendOf = (index?: IndicativeIndex) =>
  index?.changeSinceBasePct == null
    ? "flat"
    : shown(index) >= 0
      ? "up"
      : "down";
/** Tiny history line for tickers and boards. Decorative: the value sits beside it. */
export function Spark({ index }: { index?: IndicativeIndex }) {
  const points = index?.history ?? [];
  if (points.length < 2) return <svg className="spark" aria-hidden="true" />;
  const values = points.map((p) => p.value),
    min = Math.min(...values),
    max = Math.max(...values);
  const start = points[0].observedAt,
    duration = points.at(-1)!.observedAt - start || 1;
  const path = points
    .map(
      (p, i) =>
        `${i ? "L" : "M"}${(1 + (62 * (p.observedAt - start)) / duration).toFixed(1)} ${(max - min < 0.005 ? 10 : 18 - ((p.value - min) / (max - min)) * 16).toFixed(1)}`,
    )
    .join(" ");
  return (
    <svg
      className="spark"
      data-trend={trendOf(index)}
      viewBox="0 0 64 20"
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <path d={path} fill="none" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}
export function PreviewSummary({ index }: { index?: IndicativeIndex }) {
  const change =
    index?.changeSinceBasePct == null
      ? null
      : Math.round(index.changeSinceBasePct * 100) / 100;
  const preview = index ? isPreview(index) : false,
    basis = basisNote(index);
  return (
    <div className="preview-summary">
      <span className="preview-label">
        INDICATIVE · {preview && "PREVIEW · "}
        {index?.status === "OK"
          ? "5-VENUE USD REFERENCE"
          : (index?.status ?? "CONNECTING")}
      </span>
      <strong>{previewValue(index)}</strong>
      <div className="preview-metrics">
        <span data-trend={trendOf(index)}>
          {change == null
            ? "—"
            : `${change >= 0 ? "+" : ""}${change.toFixed(2)}%`}{" "}
          <small>
            {preview
              ? `SINCE ${utcDay(index!.baseAt!).toUpperCase()}`
              : "SINCE BASE"}
          </small>
        </span>
        <span>
          {index?.coverage ?? 0}/{index?.count ?? "—"} <small>COVERAGE</small>
        </span>
        {index?.confidenceBps != null && (
          <span>
            {(index.confidenceBps / 100).toFixed(1)}% <small>CONFIDENCE</small>
          </span>
        )}
      </div>
      <PreviewChart index={index} />
      {basis && <small>{basis}</small>}
      <small>
        PUBLISHED FEED · MARKETS SETTLE ON SIGNED ON-CHAIN DATA ·{" "}
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
        <span className="overline">
          {API_ENABLED ? "LIVE INDEX" : "PUBLISHED INDEX SNAPSHOT"} / FIVE
          VENUES
        </span>
        <h2>The market, in perspective.</h2>
        <p>
          The lowest executable USD ask for every constituent, read from five
          independent marketplaces: Skinport, Market.CSGO, DMarket, Waxpeer and
          LIS-SKINS. Each price is the liquidity-weighted median across venues,
          with no venue above 40% and outliers beyond 12.5% rejected. At least
          three venues must agree or the constituent is left out.{" "}
          {API_ENABLED
            ? "Refreshed every five minutes."
            : "Published snapshots target ten-minute updates; check the source timestamp below."}
        </p>
        {index && isPreview(index) ? (
          <p>
            Methodology HS-MVA-1. Baskets are selected by 30-day traded volume
            from items quoted on all five venues. This is a preview series,
            started at 1,000 on {timestamp(index.baseAt)}. The baskets are
            frozen and the official base of 1,000 is set on{" "}
            {utcDay(INDEX_BASE_AT, "long")} (UTC); the preview then stays on
            the chart as earlier history. Markets settle only on the
            quorum-signed on-chain series computed from the same inputs.
          </p>
        ) : (
          <p>
            Methodology HS-MVA-1. Baskets were selected by 30-day traded volume
            from items quoted on all five venues and are frozen, with a base of
            1,000 on {timestamp(index?.baseAt ?? null)}.
            {index && priorHistory(index).length > 0 &&
              " The dashed line before it is earlier history, rescaled to meet the base; it is not part of the index."}{" "}
            Markets settle only on the quorum-signed on-chain series computed
            from the same inputs.
          </p>
        )}
        {index?.ticker === "HS-BLUE20" && (
          <p>
            BLUE20 holds twenty premium weapon skins priced at $100 or more at
            selection, one wear per skin.
          </p>
        )}
      </div>
      <PreviewSummary index={index} />
      <details className="preview-composition">
        <summary>
          Basket · {index?.constituents.length ?? 0} constituents · exact
          weights
        </summary>
        <p>
          Ranked by 30-day traded volume with family and finish caps. The
          composition hash is committed on chain; membership changes only
          through an announced rebalance.
        </p>
        <div className="preview-table-scroll">
          <table>
            <thead>
              <tr>
                <th>Item / wear</th>
                <th>Weight</th>
                <th>Base USD</th>
                <th>Reference USD</th>
                <th>Venues</th>
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
                  <td>{c.sources ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </section>
  );
}
