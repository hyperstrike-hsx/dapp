import { useEffect, useRef, useState } from "react";
import {
  DEXTOOLS_HSX,
  drawHsxChart,
  subscribeHsxChart,
  type HsxChartData,
} from "./hsxChart";

export function HsxChartPanel() {
  const ref = useRef<HTMLCanvasElement>(null);
  const [data, setData] = useState<HsxChartData | null>(null);
  useEffect(
    () =>
      subscribeHsxChart((data) => {
        setData(data);
        if (ref.current) drawHsxChart(ref.current, data);
      }),
    [],
  );
  const last = data?.candles.at(-1);
  return (
    <section className="hsx-chart-panel">
      <h1>HSX market tape</h1>
      <p>
        Real trades from the HSX / WHYPE pool. Hourly USD candles, checked every
        30 seconds. Provider indexing may lag; gaps are left empty when there
        are no trades.
      </p>
      <div className="hsx-chart-stats">
        <span>
          Latest candle close{" "}
          <strong>{last ? `$${last[4].toFixed(8)}` : "—"}</strong>
        </span>
        <span>
          Candle time{" "}
          <strong>
            {last ? new Date(last[0] * 1000).toUTCString() : "Awaiting data"}
          </strong>
        </span>
        <span>
          Feed{" "}
          <strong>
            {!data
              ? "Connecting"
              : data.status === "OK"
                ? "Connected · 30s refresh"
                : data.status === "STALE"
                  ? "Stale · retrying"
                  : "Unavailable · retrying"}
          </strong>
        </span>
      </div>
      <div className="hsx-chart-scroll">
        <canvas
          ref={ref}
          aria-label="HSX hourly USD candlestick chart, GeckoTerminal market data"
        />
      </div>
      <a href={DEXTOOLS_HSX} target="_blank" rel="noopener noreferrer">
        Open this pool on DEXTools ↗
      </a>
      <p className="muted">
        Display feed only — never used for settlement or STRIKE mint quotes.
      </p>
    </section>
  );
}
