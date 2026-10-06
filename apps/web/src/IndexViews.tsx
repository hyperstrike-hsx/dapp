import { useEffect, useId, useState } from "react";
import { INDEXES } from "./markets";
import {
  expiryTime,
  levelThresholds,
  moveThresholds,
  question,
  SETTLEMENT_POLICY_ID,
  type Expiry,
  type MarketDefinition,
} from "@hyperstrike/market-types";
import { integratedCost, WAD } from "@hyperstrike/sdk";
import { createNativeMarket } from "./nativeClient";
import { MintAction } from "./MintAction";
import { API_ENABLED } from "./dataMode";
import { PreviewDetail } from "./IndicativeIndex";
import type { IndicativeIndex } from "@hyperstrike/market-types";
const human = (v: number) =>
  v.toLocaleString("en-US", { maximumFractionDigits: 2 });
export type Canonical = Record<
  string,
  { valueE8: string; observedAt: number; confidenceBps: number; status: string }
>;
type HistoryPoint = {
  valueE8: string;
  observedAt: number;
  provenance: "CANONICAL" | "BACKFILLED";
  confidenceBps: number;
};
export function Spark({
  large = false,
  points = [],
}: {
  large?: boolean;
  points?: HistoryPoint[];
}) {
  const id = useId();
  if (points.length < 2)
    return (
      <div className={`chart-pending ${large ? "large" : ""}`} role="status">
        <span>＋</span>
        <div>
          <strong>Awaiting signed history</strong>
          <small>No verified series published yet.</small>
        </div>
      </div>
    );
  const values = points.map((p) => Number(p.valueE8) / 1e8),
    min = Math.min(...values),
    max = Math.max(...values);
  const path =
    values.length > 1
      ? values
          .map(
            (v, i) =>
              `${i ? "L" : "M"}${(i * 600) / (values.length - 1)} ${125 - ((v - min) / (max - min || 1)) * 100}`,
          )
          .join(" ")
      : "M0 100 L600 100";
  return (
    <svg
      className={large ? "index-chart large" : "index-chart"}
      viewBox="0 0 600 150"
      preserveAspectRatio="none"
      role="img"
      aria-label={
        points.length > 1
          ? "Canonical signed index history"
          : "Illustrative base index at 1,000; canonical history unavailable"
      }
    >
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#8ef5e3" stopOpacity=".22" />
          <stop offset="100%" stopColor="#8ef5e3" stopOpacity="0" />
        </linearGradient>
      </defs>
      {[25, 75, 125].map((y) => (
        <line key={y} x1="0" y1={y} x2="600" y2={y} stroke="#ffffff0c" />
      ))}
      <path d={`${path} L600 150 L0 150Z`} fill={`url(#${id})`} />
      <path
        d={path}
        fill="none"
        stroke="#8ef5e3"
        strokeWidth="2"
        strokeDasharray={points.length > 1 ? undefined : "5 5"}
      />
    </svg>
  );
}
export function IndexBadge({ ticker }: { ticker: string }) {
  return (
    <span className="index-badge">
      <img
        src={`/indexes/${ticker.replace("HS-", "").toLowerCase()}.png`}
        alt=""
        loading="lazy"
      />
      {ticker.replace("HS-", "")}
    </span>
  );
}
export function IndexArtwork({ ticker }: { ticker: string }) {
  return (
    <div
      className={`index-artwork index-artwork--${ticker.toLowerCase()}`}
      aria-hidden="true"
    >
      <img
        src={`/indexes/${ticker.replace("HS-", "").toLowerCase()}.png`}
        alt=""
        loading="lazy"
        decoding="async"
      />
      <small>CATEGORY ART · NOT BASKET COMPOSITION</small>
    </div>
  );
}
export function IndexDetail({
  ticker,
  onBack,
  canonical,
  indicative,
}: {
  ticker: string;
  onBack: () => void;
  canonical: Canonical;
  indicative?: IndicativeIndex;
}) {
  const index = INDEXES.find((i) => i.ticker === ticker)!;
  const obs = canonical[index.indexId];
  const [history, setHistory] = useState<HistoryPoint[]>([]);
  const [composition, setComposition] = useState<{
    constituents: {
      constituentId: string;
      weightE18: string;
      family: string;
      sleeve: string;
    }[];
    versionId: string;
  } | null>(null);
  useEffect(() => {
    let alive = true;
    setHistory([]);
    setComposition(null);
    if (!API_ENABLED) return;
    fetch(`/v1/indexes/${index.indexId}/history`)
      .then((r) => (r.ok ? r.json() : []))
      .then((rows) => {
        if (alive && Array.isArray(rows))
          setHistory(
            rows.filter((p: HistoryPoint) => p.provenance === "CANONICAL"),
          );
      })
      .catch(() => {});
    fetch(`/v1/indexes/${index.indexId}/composition`)
      .then((r) => (r.ok ? r.json() : null))
      .then((row) => {
        if (alive) setComposition(row);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [index.indexId]);
  return (
    <div className="index-detail">
      <button className="text-link" onClick={onBack}>
        ← ALL INDEXES
      </button>
      <IndexArtwork ticker={ticker} />
      <PreviewDetail index={indicative} />
      <section className="index-observation">
        <div>
          <span>
            {API_ENABLED
              ? "CURRENT CANONICAL OBSERVATION"
              : "CANONICAL ORACLE · NOT ENABLED IN STATIC DEMO"}
          </span>
          <strong>
            {obs ? human(Number(obs.valueE8) / 1e8) : "UNAVAILABLE"}
          </strong>
          <p>{index.description}</p>
        </div>
        <div>
          <span>CONFIDENCE</span>
          <strong>{obs ? `${obs.confidenceBps / 100}%` : "—"}</strong>
          <p>
            {obs
              ? new Date(obs.observedAt * 1000).toISOString()
              : "Waiting for signed publication"}
          </p>
        </div>
      </section>
      <Spark large points={history} />
      <p className="chart-caption">
        {history.length > 1
          ? `CANONICAL SIGNED HISTORY · ${history.length} OBSERVATIONS · BACKFILLED DATA EXCLUDED`
          : "REFERENCE BASE: 1,000 · ILLUSTRATION ONLY · NO CANONICAL HISTORY YET"}
      </p>
      <div className="method-grid">
        <section>
          <h3>Methodology v1</h3>
          <p>
            {ticker === "HS-CS50"
              ? "30% knives · 15% gloves · 25% weapon skins · 20% cases · 10% premium collectibles. Equal weights within each sleeve."
              : `${index.count} equally weighted constituents. ${100 / index.count}% per constituent.`}
          </p>
          <p>
            Reference prices use qualifying two-sided quotes, robust outlier
            rejection and capped liquidity weights. At least two independent
            venues are required.
          </p>
        </section>
        <section>
          <h3>Confidence & continuity</h3>
          <p>
            Healthy ≥90%. Degraded 75–89.99%. Unsafe values cannot create
            markets or settle. Missing weight up to 10% redistributes
            proportionally.
          </p>
          <p>
            Quarterly rebalances use a continuity divisor. New baskets are
            announced seven days before activation.
          </p>
        </section>
        <section>
          <h3>Composition & contributions</h3>
          {composition ? (
            <>
              <p>
                Committee configuration · {composition.versionId.slice(0, 12)}…
              </p>
              <div className="composition-list">
                {composition.constituents.map((c) => (
                  <div key={c.constituentId}>
                    <span>{c.constituentId}</span>
                    <b>{human(Number(c.weightE18) / 1e16)}%</b>
                  </div>
                ))}
              </div>
            </>
          ) : (
            <p>
              The initial approved basket and source coverage have not been
              published. Constituent data will appear here once verified, with
              exact weights and inclusion decisions.
            </p>
          )}
        </section>
      </div>
    </div>
  );
}
export function CreatorForm({
  canonical,
  onNotice,
}: {
  canonical: Canonical;
  onNotice: (s: string) => void;
}) {
  const [ticker, setTicker] = useState(INDEXES[0].ticker),
    [template, setTemplate] = useState<"LEVEL" | "MOVE">("LEVEL"),
    [expiry, setExpiry] = useState<Expiry>("WEEKLY"),
    [direction, setDirection] = useState<"UP" | "DOWN">("UP"),
    [threshold, setThreshold] = useState(2),
    [seed, setSeed] = useState("100"),
    [busy, setBusy] = useState(false);
  const index = INDEXES.find((i) => i.ticker === ticker)!,
    ref = canonical[index.indexId];
  const value = BigInt(ref?.valueE8 ?? "100000000000");
  const thresholds =
    template === "LEVEL"
      ? levelThresholds(value, expiry)
      : moveThresholds(expiry);
  const t = thresholds[Math.min(threshold, thresholds.length - 1)];
  const resolutionTime = expiryTime(expiry, Math.floor(Date.now() / 1000));
  const d: MarketDefinition = {
    template,
    indexId: index.indexId,
    direction,
    thresholdE8: t,
    creationReferenceTime: template === "MOVE" ? (ref?.observedAt ?? 0) : 0,
    creationReferenceValueE8: template === "MOVE" ? value : 0n,
    resolutionTime,
    tradeCloseTime: resolutionTime - 300,
    settlementPolicyId: SETTLEMENT_POLICY_ID,
  };
  const healthy =
    API_ENABLED &&
    ref &&
    ref.confidenceBps >= 9000 &&
    Date.now() / 1000 - ref.observedAt <= 300;
  const launch = async () => {
    if (!API_ENABLED) {
      onNotice("Live market creation is not enabled in this static demo.");
      return;
    }
    setBusy(true);
    try {
      const r = await fetch("/v1/markets/prepare", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          { definition: d, initialLiquidity: seed },
          (_, v) => (typeof v === "bigint" ? v.toString() : v),
        ),
      });
      const response = await r.json();
      if (!r.ok) throw new Error(response.error);
      onNotice(`Market created: ${await createNativeMarket(d, expiry, seed)}`);
    } catch (e) {
      onNotice(e instanceof Error ? e.message : "Creation failed");
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <div className="page-intro">
        <span className="overline">CLAIM YOUR PLACE IN THE ECONOMY</span>
        <h1>
          A clear question.
          <br />
          An open market.
        </h1>
        <p>
          Every opportunity follows a canonical grid. Choose the market; the
          index and settlement rules stay immutable.
        </p>
      </div>
      <div className="creator-form">
        <section>
          <label className="native-input">
            <span>01 / INDEX</span>
            <select value={ticker} onChange={(e) => setTicker(e.target.value)}>
              {INDEXES.map((i) => (
                <option key={i.ticker}>{i.ticker}</option>
              ))}
            </select>
          </label>
          <div className="form-pair">
            <label className="native-input">
              <span>02 / TEMPLATE</span>
              <select
                value={template}
                onChange={(e) =>
                  setTemplate(e.target.value as "LEVEL" | "MOVE")
                }
              >
                <option>LEVEL</option>
                <option>MOVE</option>
              </select>
            </label>
            <label className="native-input">
              <span>03 / EXPIRY</span>
              <select
                value={expiry}
                onChange={(e) => setExpiry(e.target.value as Expiry)}
              >
                <option>DAILY</option>
                <option>WEEKLY</option>
                <option>MONTHLY</option>
              </select>
            </label>
          </div>
          <div className="form-pair">
            <label className="native-input">
              <span>04 / DIRECTION</span>
              <select
                value={direction}
                onChange={(e) => setDirection(e.target.value as "UP" | "DOWN")}
              >
                <option>UP</option>
                <option>DOWN</option>
              </select>
            </label>
            <label className="native-input">
              <span>05 / CANONICAL STRIKE</span>
              <select
                value={Math.min(threshold, thresholds.length - 1)}
                onChange={(e) => setThreshold(Number(e.target.value))}
              >
                {thresholds.map((t, i) => (
                  <option value={i} key={String(t)}>
                    {human(Number(t) / 1e8)}
                    {template === "MOVE" ? "%" : ""}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <label className="native-input">
            <span>06 / INITIAL STABLECOIN LIQUIDITY</span>
            <input
              type="number"
              min="100"
              step="1"
              value={seed}
              onChange={(e) => setSeed(e.target.value)}
            />
            <small>
              Collateral address, decimals and pilot cap are checked by the
              factory.
            </small>
          </label>
        </section>
        <aside>
          <span className="overline">IMMUTABLE MARKET REVIEW</span>
          <h2>{question(d)}</h2>
          <dl className="ticket-metrics">
            <dt>Index reference</dt>
            <dd>{ref ? human(Number(value) / 1e8) : "1,000 · ILLUSTRATIVE"}</dd>
            <dt>Confidence</dt>
            <dd>{ref ? `${ref.confidenceBps / 100}%` : "UNAVAILABLE"}</dd>
            <dt>Expiry</dt>
            <dd>
              {new Date(resolutionTime * 1000)
                .toISOString()
                .replace("T", " ")
                .slice(0, 16)}{" "}
              UTC
            </dd>
            <dt>Trading closes</dt>
            <dd>15:55 UTC</dd>
            <dt>Settlement window</dt>
            <dd>15:55–16:05 UTC</dd>
            <dt>Creator fee share</dt>
            <dd>30% of trading fees</dd>
            <dt>Capacity consumed</dt>
            <dd>1 STRIKE</dd>
            <dt>Seed liquidity</dt>
            <dd>{seed} stablecoin</dd>
          </dl>
          <button
            className="primary full"
            disabled={!healthy || busy || Number(seed) < 100}
            onClick={() => void launch()}
          >
            {busy ? "AWAITING CONFIRMATION…" : "CLAIM & LAUNCH — 1 STRIKE"}
          </button>
          {!healthy && (
            <p className="ticket-disclosure">
              Creation opens when this index has a fresh, healthy signed
              observation and the native factory is deployed.
            </p>
          )}
        </aside>
      </div>
    </>
  );
}
export function StrikePanel() {
  const [amount, setAmount] = useState("1");
  const q =
    Number(amount) > 0 && Number(amount) <= 10000
      ? BigInt(Math.round(Number(amount) * 1e6)) * 10n ** 12n
      : WAD;
  const usd = integratedCost(0n, q, 20n * WAD, 100n * WAD, 10000n * WAD);
  const hype = integratedCost(0n, q, WAD / 2n, 3n * WAD, 10000n * WAD);
  return (
    <>
      <div className="page-intro">
        <span className="overline">HSX → STRIKE → MARKETS</span>
        <h1>
          Capacity for
          <br />
          your conviction.
        </h1>
        <p>
          Minting STRIKE consumes HSX. One STRIKE creates one canonical market.
          HSX is never trader collateral.
        </p>
      </div>
      <div className="strike-layout">
        <section className="strike-visual">
          <img src="/brand/hyperstrike-mark.png" alt="HyperStrike" />
          <h2>STRIKE</h2>
          <span>HYPERSTRIKE MARKET CAPACITY</span>
          <p>
            No premine. No emissions. No staking yield.
            <br />
            Transferable capacity, consumed on creation.
          </p>
        </section>
        <section className="strike-quote">
          <span className="overline">CURVE EXPLORER / ILLUSTRATION</span>
          <label className="native-input">
            <span>STRIKE TO MINT</span>
            <input
              type="number"
              min="0.000001"
              max="10000"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
          </label>
          <dl className="ticket-metrics">
            <dt>Assumed outstanding</dt>
            <dd>0 STRIKE · demo input</dd>
            <dt>Integrated HSX USD cost</dt>
            <dd>${human(Number(usd) / 1e18)}</dd>
            <dt>HYPE contribution</dt>
            <dd>{(Number(hype) / 1e18).toFixed(6)} HYPE</dd>
            <dt>HSX quantity</dt>
            <dd>Awaiting safe price oracle</dd>
            <dt>HSX/USD timestamp</dt>
            <dd>UNAVAILABLE</dd>
            <dt>Resulting supply</dt>
            <dd>{amount} STRIKE · illustration</dd>
          </dl>
          <p>
            Each unit is priced along the curve. The quote integrates the entire
            amount instead of multiplying by the final marginal price.
          </p>
          <MintAction amount={amount} />
        </section>
      </div>
    </>
  );
}
