export const HSX_POOL = "0xa92ab5ed3041025b844233b109216c6c3c0bc63c";
export const DEXTOOLS_HSX = `https://www.dextools.io/app/hyperevm/pair-explorer/${HSX_POOL}`;
export type HsxChartData = {
  pool: string;
  source: string;
  interval: string;
  currency: string;
  candles: [number, number, number, number, number, number][];
  fetchedAt: number;
  checkedAt: number;
  status: "OK" | "STALE" | "UNAVAILABLE";
};
const stamp = (t: number) =>
  new Date(t).toISOString().slice(5, 16).replace("T", " ") + " UTC";
const price = (p: number) => "$" + p.toFixed(p < 0.001 ? 8 : p < 1 ? 5 : 2);

// A shared subscription means the LCD and expanded view never double-poll.
let data: HsxChartData | null = null;
const listeners = new Set<(data: HsxChartData | null) => void>();
let timer: ReturnType<typeof setTimeout> | undefined;
let controller: AbortController | undefined;
async function refresh() {
  const request = new AbortController();
  controller = request;
  const timeout = setTimeout(() => request.abort(), 12_000);
  try {
    const r = await fetch("/v1/hsx/ohlcv", { signal: request.signal });
    if (!r.ok) throw Error("Chart unavailable");
    const next = (await r.json()) as HsxChartData;
    if (next.pool !== HSX_POOL || !Array.isArray(next.candles))
      throw Error("Wrong pool");
    if (controller !== request) return;
    data = next;
  } catch {
    if (controller !== request) return;
    data = {
      pool: HSX_POOL,
      source: "GeckoTerminal",
      interval: "1h",
      currency: "USD",
      candles: [],
      fetchedAt: 0,
      checkedAt: Date.now(),
      ...data,
      status: data?.fetchedAt ? "STALE" : "UNAVAILABLE",
    };
  } finally {
    clearTimeout(timeout);
    if (controller === request && listeners.size) {
      listeners.forEach((listener) => listener(data));
      timer = setTimeout(refresh, 30_000);
    }
  }
}
export function subscribeHsxChart(
  listener: (value: HsxChartData | null) => void,
) {
  listeners.add(listener);
  listener(data);
  if (listeners.size === 1) void refresh();
  return () => {
    listeners.delete(listener);
    if (!listeners.size) {
      clearTimeout(timer);
      controller?.abort();
      controller = undefined;
    }
  };
}

export function drawHsxChart(
  canvas: HTMLCanvasElement,
  data: HsxChartData | null,
) {
  const ctx = canvas.getContext("2d")!;
  const w = 1920,
    h = 960;
  canvas.width = w;
  canvas.height = h;
  ctx.fillStyle = "#071719";
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = "#8ef5e3";
  ctx.fillRect(0, 0, w, 5);
  const text = (
    s: string,
    x: number,
    y: number,
    size = 24,
    color = "#b5cfca",
    bold = false,
  ) => {
    ctx.fillStyle = color;
    ctx.font = `${bold ? 700 : 400} ${size}px Arial`;
    ctx.fillText(s, x, y);
  };
  text("$HSX", 60, 88, 58, "#f0fff8", true);
  text("HSX / WHYPE   ·   HYPEREVM   ·   1H / USD", 280, 84, 28);
  const status = !data
    ? "CONNECTING"
    : data.status === "OK"
      ? "AUTO-REFRESH · 30s"
      : data.status === "STALE"
        ? "STALE DATA · RETRYING"
        : "FEED UNAVAILABLE";
  text(
    status,
    1390,
    82,
    26,
    data?.status === "OK" ? "#8ef5e3" : "#e9ac66",
    true,
  );
  const rows = data?.candles ?? [];
  if (!rows.length) {
    text(
      !data
        ? "Connecting to the HSX pool…"
        : data.status === "OK"
          ? "No trades returned for this interval."
          : "Market feed unavailable. Retrying automatically.",
      120,
      430,
      38,
      "#edf9f4",
    );
    text("No simulated prices. No generated candles.", 120, 485, 26);
  } else {
    const last = rows[rows.length - 1];
    text(price(last[4]), 60, 158, 46, "#f0fff8", true);
    text(
      `Latest candle: ${stamp(last[0] * 1000)} · Gaps = no reported trades`,
      500,
      150,
      27,
    );
    const left = 80,
      right = 1660,
      top = 210,
      bottom = 670,
      volumeBottom = 790;
    const low = Math.min(...rows.map((r) => r[3])),
      high = Math.max(...rows.map((r) => r[2]));
    const pad = Math.max((high - low) * 0.12, high * 0.005),
      min = low - pad,
      max = high + pad;
    const y = (v: number) =>
      bottom - ((v - min) / (max - min)) * (bottom - top);
    const start = rows[0][0] - 3600,
      end = Math.max(
        last[0] + 3600,
        Math.floor((data?.checkedAt ?? Date.now()) / 3600000) * 3600,
      );
    const x = (t: number) =>
      left + ((t - start) / (end - start)) * (right - left);
    const width = Math.max(
      3,
      Math.min(24, (((right - left) * 3600) / (end - start)) * 0.65),
    );
    for (let i = 0; i <= 4; i++) {
      const value = min + ((max - min) * i) / 4,
        yy = y(value);
      ctx.strokeStyle = "#29413e";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(left, yy);
      ctx.lineTo(right, yy);
      ctx.stroke();
      text(price(value), right + 22, yy + 8, 23);
    }
    const maxVolume = Math.max(1, ...rows.map((r) => r[5]));
    rows.forEach(([t, o, hi, lo, c, v]) => {
      const xx = x(t),
        color = c >= o ? "#8ef5e3" : "#f07768";
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(xx, y(hi));
      ctx.lineTo(xx, y(lo));
      ctx.stroke();
      ctx.fillStyle = color;
      ctx.fillRect(
        xx - width / 2,
        Math.min(y(o), y(c)),
        width,
        Math.max(3, Math.abs(y(o) - y(c))),
      );
      ctx.globalAlpha = 0.5;
      ctx.fillRect(
        xx - width / 2,
        volumeBottom - (v / maxVolume) * 75,
        width,
        (v / maxVolume) * 75,
      );
      ctx.globalAlpha = 1;
    });
    ctx.setLineDash([8, 8]);
    ctx.strokeStyle = "#8ef5e3";
    ctx.beginPath();
    ctx.moveTo(left, y(last[4]));
    ctx.lineTo(right, y(last[4]));
    ctx.stroke();
    ctx.setLineDash([]);
    text("VOLUME / USD", left, 708, 20);
    for (let i = 0; i < 4; i++) {
      const t = start + ((end - start) * i) / 3;
      text(stamp(t * 1000), Math.min(right - 220, x(t)), 832, 22);
    }
  }
  text(
    "GECKOTERMINAL OHLCV · SAME POOL AS DEXTOOLS · DISPLAY ONLY",
    60,
    904,
    23,
  );
  text(
    data?.fetchedAt
      ? `Fetched ${stamp(data.fetchedAt)}`
      : "Waiting for verified pool data",
    1300,
    904,
    23,
  );
  text(`POOL ${HSX_POOL}`, 60, 940, 20, "#829d98");
}
