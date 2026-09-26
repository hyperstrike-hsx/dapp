import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import { INDEXES, demoMarkets } from "./markets";
import { quoteBuy, quoteSell } from "@hyperstrike/sdk";
import type {
  IndexMarket,
  PortfolioDisplayEntry,
  VoteCount,
  VoteSide,
} from "./types";
import { signer } from "./nativeClient";
import { RangeOverlay } from "./RangeOverlay";
import { HsxChartPanel } from "./HsxChartPanel";
import {
  NativeTicket,
  decodeNativeRecord,
  type NativeRecord,
} from "./NativeTicket";
import { NativePortfolio } from "./NativePortfolio";
import { PaperPortfolio } from "./PaperPortfolio";
import { LegacyArchive } from "./LegacyArchive";
import { SportsDemoRecords } from "./SportsDemoRecords";
import { RangePerformance } from "./RangePerformance";
import {
  CreatorForm,
  IndexDetail,
  StrikePanel,
  IndexBadge,
  IndexArtwork,
  type Canonical,
} from "./IndexViews";
import {
  TradeTicket,
  type Position,
  type Tape,
  money,
  human,
} from "./TradeTicket";
import "./native.css";
import "./terminal.css";
import {
  useIndicativeIndexes,
  PreviewSummary,
  previewValue,
} from "./IndicativeIndex";
const World = lazy(() => import("./World").then((m) => ({ default: m.World })));
const SportsDemo = lazy(() => import("./SportsExperience"));
type View =
  | "Markets"
  | "Indexes"
  | "Create"
  | "Portfolio"
  | "Creators"
  | "Sports demo"
  | "HSX / STRIKE";
type Ledger = {
  positions: Position[];
  reserves: Record<string, Tape>;
  balance: string;
  events: { at: number; label: string }[];
};
const KEY = "hyperstrike.indexSandbox.v3";
const empty = (): Ledger => ({
  positions: [],
  reserves: {},
  balance: "10000000000",
  events: [],
});
function loadLedger(): Ledger {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "null");
    if (
      v &&
      Array.isArray(v.positions) &&
      v.reserves &&
      typeof v.balance === "string" &&
      Array.isArray(v.events)
    )
      return v;
  } catch {
    /* Historical records remain untouched. */
  }
  return empty();
}
const zero: VoteCount = { YES: 0, NO: 0 };
const routes: Record<View, string> = {
  Markets: "/",
  Indexes: "/indexes",
  Create: "/create",
  Portfolio: "/portfolio",
  Creators: "/creators",
  "Sports demo": "/sports",
  "HSX / STRIKE": "/tokens",
};
const routeView = () =>
  (Object.entries(routes).find(
    ([, path]) => path !== "/" && window.location.pathname.startsWith(path),
  )?.[0] ?? "Markets") as View;
const probability = (t?: Tape) =>
  Math.round(
    (Number(t?.no ?? 5e9) / (Number(t?.yes ?? 5e9) + Number(t?.no ?? 5e9))) *
      100,
  );
export default function App() {
  const [portfolioTab, setPortfolioTab] = useState<
    "Paper" | "Onchain" | "Sports demo" | "Archive"
  >("Paper");
  const [marketFilter, setMarketFilter] = useState("ALL");
  const [managedSide, setManagedSide] = useState<VoteSide | undefined>();
  const [rangePanel, setRangePanel] = useState<"foundry" | "chart" | null>(
    null,
  );
  const [nearFurnace, setNearFurnace] = useState(false);
  const [nearChart, setNearChart] = useState(false);
  const [quality, setQuality] = useState<"HIGH" | "PERFORMANCE">("HIGH");
  const [view, setView] = useState<View>(routeView),
    [range, setRange] = useState(false),
    [entered, setEntered] = useState(false),
    [locked, setLocked] = useState(false),
    [ready, setReady] = useState(false);
  const [selected, setSelected] = useState<IndexMarket | null>(null),
    [nearby, setNearby] = useState<IndexMarket | null>(null),
    [votes, setVotes] = useState<Record<string, VoteCount>>({});
  const [ammo, setAmmo] = useState({ magazine: 30, reloading: false }),
    [ledger, setLedger] = useState<Ledger>(loadLedger),
    [notice, setNotice] = useState(""),
    [wallet, setWallet] = useState("");
  const [indexDetail, setIndexDetail] = useState<string | null>(null),
    [oracle, setOracle] = useState<{ status: string } | null>(null),
    [canonical, setCanonical] = useState<Canonical>({});
  const indicativeFeed = useIndicativeIndexes();
  const indicative = Object.fromEntries(
    (indicativeFeed?.indexes ?? []).map((i) => [i.indexId, i]),
  );
  const [nativeMarkets, setNativeMarkets] = useState<NativeRecord[]>([]);
  const [nativeSelected, setNativeSelected] = useState<NativeRecord | null>(
    null,
  );
  useEffect(() => {
    const sync = () => {
      setView(routeView());
      setRange(false);
      const ticker = decodeURIComponent(
        window.location.pathname.split("/")[2] ?? "",
      );
      setIndexDetail(INDEXES.some((i) => i.ticker === ticker) ? ticker : null);
    };
    sync();
    window.addEventListener("popstate", sync);
    return () => window.removeEventListener("popstate", sync);
  }, []);
  useEffect(() => {
    let alive = true;
    fetch("/v1/markets")
      .then((r) => (r.ok ? r.json() : []))
      .then((rows) => {
        if (alive && Array.isArray(rows))
          setNativeMarkets(rows.map(decodeNativeRecord));
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [view]);
  useEffect(() => {
    localStorage.setItem(KEY, JSON.stringify(ledger));
  }, [ledger]);
  useEffect(() => {
    let live = true;
    const refresh = async () => {
      try {
        const [o, i] = await Promise.all([
          fetch("/v1/oracle/status").then((r) => {
            if (!r.ok) throw Error();
            return r.json();
          }),
          fetch("/v1/indexes").then((r) => r.json()),
        ]);
        if (live) {
          setOracle(o);
          setCanonical(
            Object.fromEntries(
              i
                .filter((v: { latest: unknown }) => v.latest)
                .map(
                  (v: {
                    indexId: string;
                    latest: Canonical[string];
                    status: string;
                  }) => [v.indexId, { ...v.latest, status: v.status }],
                ),
            ),
          );
        }
      } catch {
        if (live) setOracle({ status: "UNAVAILABLE" });
      }
    };
    void refresh();
    const timer = setInterval(refresh, 60000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, []);
  const portfolio = useMemo<PortfolioDisplayEntry[]>(
    () =>
      ledger.positions.map((p) => ({
        marketName: p.name,
        side: p.side,
        contracts: money(p.tokens),
        amount: money(p.spent),
        entryPrice: (100 * money(p.spent)) / money(p.tokens),
        resolves: demoMarkets.find((m) => m.id === p.marketId)?.resolves ?? "",
      })),
    [ledger.positions],
  );
  const select = useCallback((market: IndexMarket) => {
    document.exitPointerLock?.();
    setManagedSide(undefined);
    setSelected(market);
  }, []);
  const onVote = useCallback((market: IndexMarket, side: VoteSide) => {
    setVotes((v) => ({
      ...v,
      [market.id]: {
        ...(v[market.id] ?? zero),
        [side]: (v[market.id]?.[side] ?? 0) + 1,
      },
    }));
  }, []);
  const onAmmo = useCallback(
    (magazine: number, _reserve: number, reloading: boolean) =>
      setAmmo({ magazine, reloading }),
    [],
  );
  const onReady = useCallback(() => setReady(true), []),
    onEntered = useCallback(() => setEntered(true), []);
  const openTokens = useCallback(() => {
    document.exitPointerLock?.();
    setRangePanel("foundry");
  }, []);
  const openChart = useCallback(() => {
    document.exitPointerLock?.();
    setRangePanel("chart");
  }, []);
  const nav = (v: View) => {
    setRangePanel(null);
    window.history.pushState({}, "", routes[v]);
    document.exitPointerLock?.();
    setRange(false);
    setSelected(null);
    setView(v);
    setIndexDetail(null);
    window.scrollTo(0, 0);
  };
  const openIndex = (ticker: string | null) => {
    window.scrollTo(0, 0);
    setView("Indexes");
    setRange(false);
    setIndexDetail(ticker);
    window.history.pushState(
      {},
      "",
      ticker ? `/indexes/${ticker}` : "/indexes",
    );
  };
  const capture = () => {
    setEntered(true);
    const canvas = document.querySelector<HTMLCanvasElement>(
      ".world-canvas canvas",
    );
    void canvas
      ?.requestPointerLock()
      ?.catch(() =>
        setNotice(
          "This browser could not capture the mouse. Open the range in a regular browser window to use first-person controls.",
        ),
      );
  };
  const connect = async () => {
    try {
      setWallet(await (await signer()).getAddress());
    } catch (e) {
      setNotice(e instanceof Error ? e.message : "Connection failed");
    }
  };
  const transact = (
    market: IndexMarket,
    side: VoteSide,
    action: "BUY" | "SELL",
    amount: bigint,
  ) => {
    const tape = ledger.reserves[market.id] ?? {
      yes: "5000000000",
      no: "5000000000",
    };
    const id = `${market.id}:${side}`,
      position = ledger.positions.find((p) => p.id === id);
    let next: Ledger;
    if (Date.now() / 1000 >= market.definition.tradeCloseTime)
      throw new Error(
        "This market has closed. Reload to see the next canonical expiry.",
      );
    if (action === "BUY") {
      if (amount > BigInt(ledger.balance))
        throw new Error("Insufficient paper balance");
      const q = quoteBuy(BigInt(tape.yes), BigInt(tape.no), side, amount);
      const updated: Position = {
        id,
        marketId: market.id,
        name: market.name,
        side,
        tokens: (
          (position ? BigInt(position.tokens) : 0n) + q.tokens
        ).toString(),
        spent: ((position ? BigInt(position.spent) : 0n) + amount).toString(),
        createdAt: Date.now(),
      };
      next = {
        ...ledger,
        balance: (BigInt(ledger.balance) - amount).toString(),
        reserves: {
          ...ledger.reserves,
          [market.id]: { yes: q.yes.toString(), no: q.no.toString() },
        },
        positions: [updated, ...ledger.positions.filter((p) => p.id !== id)],
      };
    } else {
      if (!position || amount > BigInt(position.tokens))
        throw new Error("Insufficient outcome tokens");
      const q = quoteSell(BigInt(tape.yes), BigInt(tape.no), side, amount);
      const remaining = BigInt(position.tokens) - amount;
      next = {
        ...ledger,
        balance: (BigInt(ledger.balance) + q.collateral).toString(),
        reserves: {
          ...ledger.reserves,
          [market.id]: { yes: q.yes.toString(), no: q.no.toString() },
        },
        positions: ledger.positions.flatMap((p) =>
          p.id !== id
            ? [p]
            : remaining
              ? [
                  {
                    ...p,
                    tokens: remaining.toString(),
                    spent: (
                      (BigInt(p.spent) * remaining) /
                      BigInt(p.tokens)
                    ).toString(),
                  },
                ]
              : [],
        ),
      };
    }
    setLedger({
      ...next,
      events: [
        {
          at: Date.now(),
          label: `${action} ${side} · ${market.name} · ${human(money(amount))} ${action === "BUY" ? "paper USD" : "tokens"}`,
        },
        ...ledger.events,
      ].slice(0, 100),
    });
    setVotes((v) => ({
      ...v,
      [market.id]: { ...(v[market.id] ?? zero), [side]: 0 },
    }));
    setNotice("Paper trade saved to your portfolio.");
  };
  return (
    <main className={`native-app ${range ? "in-range" : ""}`}>
      <header className="native-header">
        <button
          className="native-brand"
          onClick={() => nav("Markets")}
          aria-label="HyperStrike home"
        >
          <img src="/brand/hyperstrike-mark.png" alt="" />
          <span>
            HYPER<span>STRIKE</span>
          </span>
        </button>
        <nav aria-label="Primary">
          {(
            [
              "Markets",
              "Indexes",
              "Create",
              "Portfolio",
              "Creators",
              "HSX / STRIKE",
              "Sports demo",
            ] as View[]
          ).map((v) => (
            <button
              key={v}
              className={!range && view === v ? "active" : ""}
              onClick={() =>
                range && v === "HSX / STRIKE" ? openTokens() : nav(v)
              }
            >
              {v}
            </button>
          ))}
        </nav>
        <button
          className={`range-toggle ${range ? "active" : ""}`}
          onClick={() => {
            setRangePanel(null);
            document.exitPointerLock?.();
            setRange((v) => !v);
            if (!range) setReady(false);
          }}
        >
          ⌖ {range ? "EXIT RANGE" : "ENTER RANGE"}
        </button>
        <button className="native-wallet" onClick={() => void connect()}>
          {wallet ? wallet.slice(0, 6) + "…" + wallet.slice(-4) : "CONNECT"}
        </button>
      </header>
      {!range && view !== "Sports demo" && (
        <>
          <div className="protocol-ribbon">
            <span>
              <i /> HYPEREVM · INDEX NATIVE
            </span>
            <span>
              INDEX ALPHA <b>/</b> PAPER MARKET SANDBOX
            </span>
            <button onClick={() => nav("Indexes")}>
              ORACLE {oracle?.status ?? "CONNECTING"} ↗
            </button>
          </div>
          {(view === "Markets" || view === "Indexes") && (
            <div className="ticker-strip">
              {INDEXES.map((i) => (
                <button
                  key={i.ticker}
                  onClick={() => {
                    openIndex(i.ticker);
                  }}
                >
                  <strong>{i.ticker}</strong>
                  <span>{previewValue(indicative[i.indexId])}</span>
                  <small>
                    INDICATIVE · {indicative[i.indexId]?.status ?? "CONNECTING"}
                  </small>
                </button>
              ))}
            </div>
          )}
        </>
      )}
      {range ? (
        <>
          <Suspense
            fallback={<div className="range-loading">Preparing the range…</div>}
          >
            <World
              quality={quality}
              markets={demoMarkets}
              onSelect={select}
              onProximity={setNearby}
              entered={entered}
              onEntered={onEntered}
              onLockChange={setLocked}
              onAmmoChange={onAmmo}
              onVote={onVote}
              votes={votes}
              portfolio={portfolio}
              onFurnace={openTokens}
              onFurnaceProximity={setNearFurnace}
              onChart={openChart}
              onChartProximity={setNearChart}
              onReady={onReady}
            />
          </Suspense>
          {!ready && (
            <div className="range-loading">
              LOADING MATERIALS / LIGHTING / VIEWMODEL
            </div>
          )}
          <div className="range-tag">
            RANGE 01 <span>INDEX MARKET SANDBOX</span>
          </div>
          <RangePerformance
            quality={quality}
            onQuality={(q) => {
              setReady(false);
              setQuality(q);
            }}
          />
          {ready && !locked && !selected && !rangePanel && (
            <button className="range-enter" onClick={capture}>
              <span>THE ECONOMY IS YOUR TARGET.</span>
              <strong>
                {entered ? "RESUME OPERATION" : "DEPLOY TO THE RANGE"} ↗
              </strong>
              <small>
                WASD move · Mouse aim · Hold to fire · E review · R reload
              </small>
            </button>
          )}
          {ready && !locked && !rangePanel && !selected && (
            <div className="range-utilities">
              <button onClick={openTokens}>STRIKE FOUNDRY ↗</button>
              <button onClick={openChart}>$HSX CANDLE CHART ↗</button>
            </div>
          )}
          {rangePanel && (
            <RangeOverlay
              title={
                rangePanel === "foundry" ? "STRIKE FOUNDRY" : "HSX MARKET TAPE"
              }
              onClose={() => setRangePanel(null)}
              onResume={() => {
                setRangePanel(null);
                capture();
              }}
            >
              {rangePanel === "foundry" ? <StrikePanel /> : <HsxChartPanel />}
            </RangeOverlay>
          )}
          {locked && !selected && (
            <>
              <div className="native-crosshair">
                <i />
                <i />
              </div>
              <div className="range-interact">
                {nearFurnace ? (
                  <>
                    <kbd>E</kbd> OPEN STRIKE FOUNDRY
                  </>
                ) : nearChart ? (
                  <>
                    <kbd>E</kbd> EXPAND HSX CHART
                  </>
                ) : nearby ? (
                  <>
                    <kbd>E</kbd> REVIEW {nearby.name}
                  </>
                ) : (
                  "Aim at YES or NO. One hit stages one contract."
                )}
              </div>
            </>
          )}
          <div className="range-bottom">
            <span>NO ORDER IS SENT UNTIL YOU REVIEW AND CONFIRM</span>
            <strong>
              {ammo.reloading ? "RELOADING" : `${ammo.magazine} / ∞`}
            </strong>
          </div>
        </>
      ) : view === "Sports demo" ? (
        <Suspense
          fallback={<div className="native-content">Opening sports demo…</div>}
        >
          <SportsDemo
            onBack={() => nav("Markets")}
            onPortfolio={() => {
              setPortfolioTab("Sports demo");
              nav("Portfolio");
            }}
          />
        </Suspense>
      ) : (
        <div className="native-content">
          {view === "Markets" && (
            <>
              {nativeMarkets.length > 0 && (
                <section className="native-live-markets">
                  <div className="section-heading">
                    <h2>Native markets</h2>
                    <span className="sandbox-label">
                      HYPEREVM · REAL COLLATERAL
                    </span>
                  </div>
                  <div className="native-market-grid">
                    {nativeMarkets.map((m) => (
                      <button
                        key={m.address}
                        className="native-market"
                        onClick={() => setNativeSelected(m)}
                      >
                        <span className="overline">
                          CANONICAL INDEX / NATIVE
                        </span>
                        <h3>{m.question}</h3>
                        <p>
                          {new Date(
                            m.definition.resolutionTime * 1000,
                          ).toLocaleString()}{" "}
                          · Review market ↗
                        </p>
                      </button>
                    ))}
                  </div>
                </section>
              )}
              <section className="native-hero">
                <div className="hero-copy">
                  <div className="overline">
                    THE BALLISTIC PREDICTION MARKET
                  </div>
                  <h1>
                    YOUR AIM.
                    <br />
                    YOUR <em>EDGE.</em>
                  </h1>
                  <p>
                    Call the next move in the CS2 economy. Take a position on
                    skins, knives and cases—or put your conviction downrange.
                  </p>
                  <div className="hero-ctas">
                    <button
                      className="primary"
                      onClick={() => {
                        setRange(true);
                        setReady(false);
                      }}
                    >
                      ENTER THE RANGE <span>↗</span>
                    </button>
                    <button
                      className="secondary"
                      onClick={() => nav("Indexes")}
                    >
                      EXPLORE THE INDEXES →
                    </button>
                  </div>
                  <div className="hero-facts">
                    <span>
                      <b>05</b> CANONICAL INDEXES
                    </span>
                    <span>
                      <b>02</b> FIXED OUTCOMES
                    </span>
                    <span>
                      <b>0</b> LEVERAGE
                    </span>
                  </div>
                </div>
                <div className="hero-art">
                  <img
                    src="/brand/hyperstrike-world.jpg"
                    alt="HyperStrike skin-economy concept art"
                  />
                  <div className="art-grid" />
                  <div className="art-label">
                    <span>THE BENCHMARK COMES FIRST.</span>
                    <b>
                      01 / INDEX
                      <br />
                      02 / POSITION
                      <br />
                      03 / RESOLUTION
                    </b>
                  </div>
                  <div className="art-corner">HS / 003</div>
                </div>
              </section>
              <div className="section-heading">
                <div>
                  <span>YOUR NEXT POSITION</span>
                  <h2>
                    Pick your next move.<span> / 05</span>
                  </h2>
                </div>
                <span className="sandbox-label">
                  ILLUSTRATIVE MARKETS · PAPER USD
                </span>
              </div>
              <div className="market-toolbar">
                <div className="segment-control" aria-label="Filter markets">
                  {["ALL", ...INDEXES.map((i) => i.ticker)].map((t) => (
                    <button
                      key={t}
                      aria-pressed={marketFilter === t}
                      onClick={() => setMarketFilter(t)}
                    >
                      {t === "ALL" ? "All markets" : t.replace("HS-", "")}
                    </button>
                  ))}
                </div>
                <span>WEEKLY EXPIRY · SIMULATED PRICES</span>
              </div>
              <div className="native-market-grid">
                {demoMarkets
                  .filter(
                    (m) => marketFilter === "ALL" || m.name === marketFilter,
                  )
                  .map((m) => (
                    <button
                      key={m.id}
                      className="native-market"
                      onClick={() => {
                        setManagedSide(undefined);
                        setSelected(m);
                      }}
                    >
                      <div className="market-heading">
                        <IndexBadge ticker={m.name} />
                        <span>LEVEL / WEEKLY</span>
                        <b>↗</b>
                      </div>
                      <IndexArtwork ticker={m.name} />
                      <h3>{m.question}</h3>
                      <p>{m.condition.toLowerCase()}</p>
                      <div
                        className="market-conviction"
                        aria-label={`Paper YES price ${probability(ledger.reserves[m.id])} cents`}
                      >
                        <i
                          style={{
                            width: `${probability(ledger.reserves[m.id])}%`,
                          }}
                        />
                      </div>
                      <div className="market-price">
                        <span>
                          YES <b>{probability(ledger.reserves[m.id])}¢</b>
                        </span>
                        <span>
                          NO <b>{100 - probability(ledger.reserves[m.id])}¢</b>
                        </span>
                      </div>
                      <div className="market-meta">
                        <span>{m.resolves}</span>
                        <span>TAKE A POSITION ↗</span>
                      </div>
                    </button>
                  ))}
              </div>
              <section className="methodology-banner">
                <span>01 → 02 → 03 → 04</span>
                <h3>
                  Real observations.
                  <br />A benchmark you can verify.
                </h3>
                <p>
                  Venue quotes feed constituent reference prices. Reference
                  prices build canonical indexes. Markets settle only against
                  those indexes.
                </p>
                <button onClick={() => nav("Indexes")}>
                  READ THE METHODOLOGY ↗
                </button>
              </section>
              <div className="dashboard-bottom">
                <section>
                  <h3>Recent settlements</h3>
                  <p>
                    No canonical settlements yet. Signed observations and
                    resolutions appear here after the native pilot launches.
                  </p>
                </section>
                <section>
                  <h3>Creator opportunities</h3>
                  <p>
                    Claim a canonical slot with STRIKE. Seed a market. Earn 30%
                    of its trading fees through resolution.
                  </p>
                  <button className="text-link" onClick={() => nav("Create")}>
                    EXPLORE CANONICAL SLOTS →
                  </button>
                </section>
                <section>
                  <h3>Oracle health</h3>
                  <span className="status-unavailable">
                    {oracle?.status ?? "CONNECTING"}
                  </span>
                  <p>
                    Canonical prices remain unavailable until independently
                    verified sources and the signer quorum publish.
                  </p>
                </section>
              </div>
            </>
          )}
          {view === "Indexes" && (
            <>
              <div className="page-intro">
                <span className="overline">THE BENCHMARK BEFORE THE BET</span>
                <h1>{indexDetail ?? "Know what moves."}</h1>
                <p>
                  Five views of the skin economy. Real Skinport listing prices,
                  frozen preview baskets and a base of 1,000. Indicative only —
                  never used for settlement. Market collateral remains USDC.
                </p>
              </div>
              {indexDetail ? (
                <IndexDetail
                  ticker={indexDetail}
                  onBack={() => openIndex(null)}
                  canonical={canonical}
                  indicative={
                    indicative[
                      INDEXES.find((i) => i.ticker === indexDetail)!.indexId
                    ]
                  }
                />
              ) : (
                <div className="index-grid">
                  {INDEXES.map((i) => (
                    <button
                      className="index-detail-card"
                      data-index={i.ticker}
                      key={i.ticker}
                      onClick={() => openIndex(i.ticker)}
                    >
                      <div>
                        <IndexBadge ticker={i.ticker} />
                        <span>{i.count} CONSTITUENTS</span>
                      </div>
                      <h2>{i.name}</h2>
                      <IndexArtwork ticker={i.ticker} />
                      <p>
                        {i.ticker === "HS-BLUE20"
                          ? "Preview: twenty premium weapon skins. A proxy basket, not yet the approved collectible index."
                          : i.ticker === "HS-CASE20"
                            ? "Preview: twenty cases listed on Skinport for at least 90 days. Equal-weight USD asks."
                            : i.ticker === "HS-KNIFE20"
                              ? "Preview: twenty knife configurations selected by listed inventory. Equal-weight USD asks."
                              : i.ticker === "HS-GLOVE10"
                                ? "Preview: ten glove configurations selected by listed inventory. Equal-weight USD asks."
                                : "Preview: fifty configurations across knives, gloves, weapon skins, cases and premium weapons."}
                      </p>
                      <PreviewSummary index={indicative[i.indexId]} />
                      <small>
                        EXPLORE BASKET & METHODOLOGY <b>↗</b>
                      </small>
                    </button>
                  ))}
                </div>
              )}
            </>
          )}
          {view === "Create" && (
            <CreatorForm canonical={canonical} onNotice={setNotice} />
          )}
          {view === "Portfolio" && (
            <>
              <div className="page-intro portfolio-intro">
                <span className="overline">YOUR CONTROL CENTER</span>
                <h1>
                  Conviction, <em>on record.</em>
                </h1>
                <p>
                  Know what you hold. See what it means. Plan your next move.
                </p>
              </div>
              <div className="portfolio-tabs" aria-label="Portfolio ledgers">
                {(["Paper", "Onchain", "Sports demo", "Archive"] as const).map(
                  (t) => (
                    <button
                      key={t}
                      aria-pressed={portfolioTab === t}
                      onClick={() => setPortfolioTab(t)}
                    >
                      {t}
                      {t === "Paper" && <span>{ledger.positions.length}</span>}
                    </button>
                  ),
                )}
                <span className="ledger-status">
                  {portfolioTab === "Onchain"
                    ? "WALLET-VERIFIED HOLDINGS"
                    : "LOCAL RECORDS · NO REAL FUNDS"}
                </span>
              </div>
              {portfolioTab === "Onchain" && (
                <NativePortfolio
                  records={nativeMarkets}
                  onSelect={setNativeSelected}
                  onNotice={setNotice}
                />
              )}
              {portfolioTab === "Paper" && (
                <PaperPortfolio
                  {...ledger}
                  onSelect={(m, side) => {
                    setManagedSide(side);
                    setSelected(m);
                  }}
                  onExplore={() => nav("Markets")}
                />
              )}
              {portfolioTab === "Sports demo" && (
                <SportsDemoRecords onPlay={() => nav("Sports demo")} />
              )}
              {portfolioTab === "Archive" && <LegacyArchive />}
            </>
          )}
          {view === "Creators" && (
            <>
              <div className="page-intro">
                <span className="overline">
                  BUILD THE MARKET. EARN YOUR SHARE.
                </span>
                <h1>
                  Conviction
                  <br />
                  creates liquidity.
                </h1>
                <p>
                  Creators choose a canonical index slot, burn one STRIKE and
                  seed liquidity. The oracle controls settlement. You earn 30%
                  of trading fees.
                </p>
              </div>
              <div className="creator-steps">
                {[
                  [
                    "01",
                    "Find the opening",
                    "Choose an index, direction, canonical threshold and expiry.",
                  ],
                  [
                    "02",
                    "Commit capacity",
                    "Mint STRIKE with HSX and HYPE. Claim a slot for one STRIKE.",
                  ],
                  [
                    "03",
                    "Let the market work",
                    "Earn your share of the 20 bps trading fee. Claim accrued fees independently of trading pauses.",
                  ],
                ].map(([n, t, p]) => (
                  <section key={n}>
                    <b>{n}</b>
                    <h2>{t}</h2>
                    <p>{p}</p>
                  </section>
                ))}
              </div>
              <button className="primary" onClick={() => nav("Create")}>
                EXPLORE YOUR FIRST MARKET ↗
              </button>
              <div className="empty-state">
                <NativePortfolio
                  creatorOnly
                  records={nativeMarkets}
                  onSelect={setNativeSelected}
                  onNotice={setNotice}
                />
              </div>
            </>
          )}
          {view === "HSX / STRIKE" && <StrikePanel />}
          <div className="native-footer">
            <span>
              HYPERSTRIKE <b>© {new Date().getFullYear()}</b>
            </span>
            <span>HYPEREVM / NATIVE MARKETS / INDEX ALPHA</span>
            <span>BUILT FOR THE CS2 ECONOMY.</span>
          </div>
        </div>
      )}
      {selected && (
        <TradeTicket
          key={selected.id}
          market={selected}
          initialSide={managedSide}
          initialAction={managedSide ? "SELL" : "BUY"}
          votes={votes[selected.id] ?? zero}
          tape={
            ledger.reserves[selected.id] ?? {
              yes: "5000000000",
              no: "5000000000",
            }
          }
          positions={ledger.positions}
          onClose={() => {
            setSelected(null);
            setManagedSide(undefined);
          }}
          onTrade={transact}
        />
      )}
      {nativeSelected && (
        <NativeTicket
          record={nativeSelected}
          onClose={() => setNativeSelected(null)}
          onNotice={setNotice}
        />
      )}
      {notice && (
        <div className="native-toast" role="status">
          {notice}
          <button
            aria-label="Dismiss notification"
            onClick={() => setNotice("")}
          >
            ×
          </button>
        </div>
      )}
    </main>
  );
}
