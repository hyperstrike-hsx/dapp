import {
  Component,
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
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
import { RangeLobby } from "./RangeLobby";
import { touchControls, type RangeControl } from "./range/touch";
import { RangePerformance } from "./RangePerformance";
import { RANGE_MAPS, storedRangeMap, storeRangeMap, type RangeMapId } from "./range/mapList";
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
import "./ui.css";
import { API_ENABLED } from "./dataMode";
import {
  useIndicativeIndexes,
  PreviewSummary,
  previewValue,
  Spark,
  changeLabel,
  trendOf,
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
const PRIMARY: View[] = ["Markets", "Indexes", "Portfolio"];
const SECONDARY: View[] = ["Create", "Creators", "HSX / STRIKE", "Sports demo"];
/** "3d 14h" until trading closes; minutes once inside the last day. */
const closesIn = (closeTime: number) => {
  const left = closeTime - Date.now() / 1000;
  if (left <= 0) return "CLOSED";
  const d = Math.floor(left / 86400),
    h = Math.floor((left % 86400) / 3600),
    m = Math.floor((left % 3600) / 60);
  return d ? `${d}D ${h}H` : h ? `${h}H ${m}M` : `${m}M`;
};
const probability = (t?: Tape) =>
  Math.round(
    (Number(t?.no ?? 5e9) / (Number(t?.yes ?? 5e9) + Number(t?.no ?? 5e9))) *
      100,
  );
/**
 * Keeps a range that throws while it is being built from taking the whole page down with it, and
 * hands the reason over so the loading screen can say it. Picking another range tries again.
 */
class RangeBoundary extends Component<
  { retry: string; onFault: (message: string) => void; children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: unknown) {
    this.props.onFault(error instanceof Error ? error.message : String(error));
  }
  componentDidUpdate(before: { retry: string }) {
    if (this.state.failed && before.retry !== this.props.retry)
      this.setState({ failed: false });
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

export default function App() {
  const [portfolioTab, setPortfolioTab] = useState<
    "Paper" | "Onchain" | "Sports demo" | "Archive"
  >("Paper");
  const [marketFilter, setMarketFilter] = useState("ALL");
  const [managedSide, setManagedSide] = useState<VoteSide | undefined>();
  const [ticketSide, setTicketSide] = useState<VoteSide | undefined>();
  const [menuOpen, setMenuOpen] = useState(false);
  const [rangePanel, setRangePanel] = useState<"foundry" | "chart" | null>(
    null,
  );
  const [nearFurnace, setNearFurnace] = useState(false);
  const [nearChart, setNearChart] = useState(false);
  // A touch screen is a phone or a tablet: it plays with on-screen controls and starts on the lighter renderer.
  const [touch] = useState(touchControls);
  const worldControl = useRef<RangeControl | null>(null);
  const [quality, setQuality] = useState<"HIGH" | "PERFORMANCE">(touch ? "PERFORMANCE" : "HIGH");
  const [rangeMap, setRangeMap] = useState<RangeMapId>(storedRangeMap);
  const rangeMapInfo = RANGE_MAPS.find((entry) => entry.id === rangeMap) ?? RANGE_MAPS[0];
  const [view, setView] = useState<View>(routeView),
    [range, setRange] = useState(false),
    [entered, setEntered] = useState(false),
    [locked, setLocked] = useState(false),
    // A closing ticket or panel has asked for the pointer and the browser has yet to answer.
    [resuming, setResuming] = useState(false),
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
    if (!API_ENABLED) return;
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
    if (!notice) return;
    const timer = setTimeout(() => setNotice(""), 7000);
    return () => clearTimeout(timer);
  }, [notice]);
  useEffect(() => {
    let live = true;
    if (!API_ENABLED) {
      setOracle({ status: "NOT ENABLED · STATIC DEMO" });
      return;
    }
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
  /** Stops play: gives the mouse back, or takes the touch controls down. */
  const freePointer = useCallback(() => {
    document.exitPointerLock?.();
    worldControl.current?.pause();
  }, []);
  // Leaving the range ends play, whichever way it was left.
  useEffect(() => {
    if (!range) setLocked(false);
  }, [range]);
  const select = useCallback((market: IndexMarket) => {
    freePointer();
    setManagedSide(undefined);
    setTicketSide(undefined);
    setSelected(market);
  }, [freePointer]);
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
  const onContextLost = useCallback(
    () =>
      setNotice(
        "This device ran out of graphics memory for the range. Close other tabs or apps, then leave the range and enter it again.",
      ),
    [],
  );
  // What the loading screen says: how far along, and what went wrong if anything did. A phone has
  // no console to look in, so a range that cannot start says why on the screen.
  const [loading, setLoading] = useState<{ done: number; total: number } | null>(null),
    [slow, setSlow] = useState(false),
    [fault, setFault] = useState("");
  const [crash, setCrash] = useState("");
  const onProgress = useCallback(
    (done: number, total: number) => setLoading({ done, total }),
    [],
  );
  useEffect(() => {
    setLoading(null);
    setSlow(false);
    setFault("");
    if (!ready) setCrash("");
    if (!range || ready) return;
    const overdue = window.setTimeout(() => setSlow(true), 30_000);
    const heard = (event: ErrorEvent | PromiseRejectionEvent) => {
      const reason: unknown =
        "reason" in event ? event.reason : (event.error ?? event.message);
      setFault(
        String(reason instanceof Error ? reason.message : reason).slice(0, 200),
      );
    };
    window.addEventListener("error", heard);
    window.addEventListener("unhandledrejection", heard);
    return () => {
      window.clearTimeout(overdue);
      window.removeEventListener("error", heard);
      window.removeEventListener("unhandledrejection", heard);
    };
  }, [range, ready, rangeMap]);
  const onReady = useCallback(() => setReady(true), []),
    onEntered = useCallback(() => setEntered(true), []);
  const openTokens = useCallback(() => {
    freePointer();
    setRangePanel("foundry");
  }, [freePointer]);
  const openChart = useCallback(() => {
    freePointer();
    setRangePanel("chart");
  }, [freePointer]);
  const toggleRange = () => {
    setMenuOpen(false);
    setRangePanel(null);
    freePointer();
    setRange((v) => !v);
    if (!range) setReady(false);
  };
  const openTicket = (market: IndexMarket, side?: VoteSide) => {
    setManagedSide(undefined);
    setTicketSide(side);
    setSelected(market);
  };
  const nav = (v: View) => {
    setMenuOpen(false);
    setRangePanel(null);
    window.history.pushState({}, "", routes[v]);
    freePointer();
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
  /**
   * Starts or resumes play: the range captures the mouse or, on a touch screen, puts up its
   * controls. It has to be called from a click or a tap, which is what a browser asks for.
   * `quiet` is for a range picked from the briefing: if the mouse cannot be taken just then
   * (a browser refuses for a moment after Escape), the briefing simply comes back with RESUME.
   */
  const capture = (quiet = false) => {
    setEntered(true);
    void worldControl.current?.engage().catch(() => {
      if (!quiet)
        setNotice(
          "This browser could not capture the mouse. Open the range in a regular browser window to use first-person controls.",
        );
    });
  };
  /**
   * Closing a ticket or a panel goes straight back to play once the player has deployed, instead
   * of stopping at the pause screen, whichever way it was closed. `quiet` is for Escape: a browser
   * hands the pointer back on a click, and on Escape only where the range itself let go of it (a
   * panel opened from the pause screen was reached by the player's own Escape). Where it is
   * refused, the pause screen comes back with RESUME and nothing is reported.
   */
  const backToPlay = (quiet = false) => {
    setResuming(true);
    capture(quiet);
  };
  const resumeRange = (quiet = false) => {
    if (range && entered) backToPlay(quiet);
  };
  // The browser hands the pointer over a moment after it is asked. The pause screen stays down
  // for that moment rather than flashing up between the panel and play; an answer that has not
  // come by then is a refusal, and the pause screen is where that leaves the player.
  useEffect(() => {
    if (!resuming) return;
    if (locked || !range) {
      setResuming(false);
      return;
    }
    const timer = window.setTimeout(() => setResuming(false), 400);
    return () => window.clearTimeout(timer);
  }, [resuming, locked, range]);
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
  const rangePerformance = (
    <RangePerformance
      quality={quality}
      onQuality={(q) => {
        setReady(false);
        setQuality(q);
      }}
    />
  );
  return (
    <main
      className={`native-app ${range ? "in-range" : ""} ${range && touch ? "touch-range" : ""} ${range && ready && locked ? "is-playing" : ""}`}
    >
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
          {[...PRIMARY, ...SECONDARY].map((v, i) => (
            <button
              key={v}
              className={`${!range && view === v ? "active" : ""} ${i >= PRIMARY.length ? "minor" : ""} ${i === PRIMARY.length ? "minor-first" : ""}`}
              aria-current={!range && view === v ? "page" : undefined}
              onClick={() =>
                range && v === "HSX / STRIKE" ? openTokens() : nav(v)
              }
            >
              {v}
              {v === "Portfolio" && ledger.positions.length > 0 && (
                <span className="nav-count">{ledger.positions.length}</span>
              )}
            </button>
          ))}
        </nav>
        <button
          className={`range-toggle ${range ? "active" : ""}`}
          onClick={toggleRange}
        >
          <span className="reticle" aria-hidden="true" />
          {range ? "EXIT RANGE" : "ENTER RANGE"}
        </button>
        <button
          className={`native-wallet ${wallet ? "connected" : ""}`}
          onClick={() => void connect()}
        >
          {wallet ? wallet.slice(0, 6) + "…" + wallet.slice(-4) : "CONNECT"}
        </button>
      </header>
      {!range && view !== "Sports demo" && (
        <div className="market-bar">
          <span className="market-bar-mode">
            <i /> INDEX ALPHA <b>/</b> PAPER SANDBOX
          </span>
          <div className="ticker-strip">
            {INDEXES.map((i) => (
              <button
                key={i.ticker}
                className={indexDetail === i.ticker ? "active" : ""}
                onClick={() => openIndex(i.ticker)}
                title={`Indicative · ${indicative[i.indexId]?.status ?? "connecting"} · not for settlement`}
              >
                <strong>{i.ticker.replace("HS-", "")}</strong>
                <span>{previewValue(indicative[i.indexId])}</span>
                <em data-trend={trendOf(indicative[i.indexId])}>
                  {changeLabel(indicative[i.indexId])}
                </em>
                <Spark index={indicative[i.indexId]} />
              </button>
            ))}
          </div>
          <button className="market-bar-oracle" onClick={() => nav("Indexes")}>
            ORACLE {oracle?.status ?? "CONNECTING"} ↗
          </button>
        </div>
      )}
      {range ? (
        <>
          <Suspense
            fallback={<div className="range-loading">Preparing the range…</div>}
          >
            <RangeBoundary retry={`${rangeMap}/${quality}`} onFault={setCrash}>
            <World
              quality={quality}
              map={rangeMap}
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
              onProgress={onProgress}
              control={worldControl}
              onContextLost={onContextLost}
            />
            </RangeBoundary>
          </Suspense>
          {!ready && (
            <div className="range-loading" role="status">
              {crash ? (
                <>
                  <strong>THE RANGE COULD NOT START</strong>
                  <span>{crash}</span>
                  <small>Reload the page to try again.</small>
                </>
              ) : (
                <>
                  <strong>LOADING {rangeMapInfo.name}</strong>
                  <span>
                    {loading
                      ? `${loading.done} / ${loading.total} FILES`
                      : "MATERIALS / LIGHTING / VIEWMODEL"}
                  </span>
                  {slow && (
                    <small>
                      {fault
                        ? `Still loading. Last error: ${fault}`
                        : "Still loading. A slow connection can take a minute."}
                    </small>
                  )}
                </>
              )}
            </div>
          )}
          <div className="range-tag">
            RANGE {rangeMapInfo.code} <span>{rangeMapInfo.name} · INDEX MARKET SANDBOX</span>
          </div>
          {ready && !locked && !selected && !rangePanel && !resuming ? (
            <RangeLobby
              current={rangeMap}
              entered={entered}
              touch={touch}
              onDeploy={() => capture()}
              onLoad={(id) => {
                // The click that picks a range is the one that takes the pointer, so the new range
                // opens straight into play instead of coming back to this screen.
                capture(true);
                storeRangeMap(id);
                setReady(false);
                setRangeMap(id);
              }}
              onFoundry={openTokens}
              onChart={openChart}
              tools={rangePerformance}
            />
          ) : (
            rangePerformance
          )}
          {rangePanel && (
            <RangeOverlay
              title={
                rangePanel === "foundry" ? "STRIKE FOUNDRY" : "HSX MARKET TAPE"
              }
              onClose={() => {
                setRangePanel(null);
                resumeRange();
              }}
              onEscape={() => {
                setRangePanel(null);
                resumeRange(true);
              }}
              onResume={() => {
                setRangePanel(null);
                backToPlay();
              }}
            >
              {rangePanel === "foundry" ? <StrikePanel /> : <HsxChartPanel />}
            </RangeOverlay>
          )}
          {ready && locked && !selected && (
            <>
              <div className="native-crosshair">
                <i />
                <i />
              </div>
              {touch && (nearFurnace || nearChart || nearby) ? (
                // On a touch screen the prompt is the button.
                <button
                  className="range-interact is-touch"
                  onPointerDown={() => worldControl.current?.use()}
                >
                  <kbd>TAP</kbd>{" "}
                  {nearFurnace
                    ? "OPEN STRIKE FOUNDRY"
                    : nearChart
                      ? "EXPAND HSX CHART"
                      : `REVIEW ${nearby?.name}`}
                </button>
              ) : (
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
              )}
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
                <img
                  className="hero-backdrop"
                  src="/brand/hyperstrike-world.jpg"
                  alt=""
                />
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
                    <button className="primary" onClick={toggleRange}>
                      <span className="reticle" aria-hidden="true" />
                      ENTER THE RANGE
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
                <aside className="hero-board" aria-label="Index board">
                  <header>
                    <span>
                      <i /> INDEX BOARD
                    </span>
                    <small>INDICATIVE · BASE 1,000</small>
                  </header>
                  {INDEXES.map((i) => (
                    <button key={i.ticker} onClick={() => openIndex(i.ticker)}>
                      <IndexBadge ticker={i.ticker} />
                      <span className="board-name">{i.name}</span>
                      <Spark index={indicative[i.indexId]} />
                      <strong>{previewValue(indicative[i.indexId])}</strong>
                      <em data-trend={trendOf(indicative[i.indexId])}>
                        {changeLabel(indicative[i.indexId])}
                      </em>
                    </button>
                  ))}
                  <footer>
                    <span>FIVE-VENUE USD ASKS · PUBLISHED FEED</span>
                    <button onClick={() => nav("Indexes")}>
                      ALL INDEXES →
                    </button>
                  </footer>
                </aside>
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
              <div
                className="market-cards"
                data-count={marketFilter === "ALL" ? demoMarkets.length : 1}
              >
                {demoMarkets
                  .filter(
                    (m) => marketFilter === "ALL" || m.name === marketFilter,
                  )
                  .map((m) => {
                    const yes = probability(ledger.reserves[m.id]);
                    const strike = Number(m.definition.thresholdE8) / 1e8;
                    const level = indicative[m.definition.indexId]?.value;
                    const gap =
                      level == null ? null : (strike / level - 1) * 100;
                    // Where the level and the strike sit on a track spanning both, with margin.
                    const lo = Math.min(level ?? strike, strike) * 0.985,
                      hi = Math.max(level ?? strike, strike) * 1.015;
                    const at = (v: number) => ((v - lo) / (hi - lo)) * 100;
                    return (
                      <article key={m.id} className="market-card">
                        <button
                          className="market-open"
                          onClick={() => openTicket(m)}
                        >
                          <IndexArtwork ticker={m.name} />
                          <div className="market-heading">
                            <IndexBadge ticker={m.name} />
                            <span>LEVEL · WEEKLY</span>
                            <span className="market-closes">
                              CLOSES IN {closesIn(m.definition.tradeCloseTime)}
                            </span>
                          </div>
                          <h3>{m.question}</h3>
                          <div className="market-gap">
                            <div className="gap-track" aria-hidden="true">
                              {level != null && (
                                <i
                                  className="gap-now"
                                  style={{ left: `${at(level)}%` }}
                                />
                              )}
                              <i
                                className="gap-strike"
                                style={{ left: `${at(strike)}%` }}
                              />
                            </div>
                            <p>
                              {level == null ? (
                                "Indicative level unavailable"
                              ) : (
                                <>
                                  Indicative <b>{previewValue(indicative[m.definition.indexId])}</b>{" "}
                                  ·{" "}
                                  {gap! > 0
                                    ? `needs +${gap!.toFixed(2)}% to reach`
                                    : `${Math.abs(gap!).toFixed(2)}% above`}{" "}
                                  <b>{human(strike)}</b>
                                </>
                              )}
                            </p>
                          </div>
                        </button>
                        <div
                          className="market-conviction"
                          aria-label={`Paper YES price ${yes} cents`}
                        >
                          <i style={{ width: `${yes}%` }} />
                        </div>
                        <div className="market-sides">
                          <button
                            className="yes"
                            onClick={() => openTicket(m, "YES")}
                            aria-label={`Buy YES at ${yes} cents`}
                          >
                            <span>BUY YES</span>
                            <b>{yes}¢</b>
                          </button>
                          <button
                            className="no"
                            onClick={() => openTicket(m, "NO")}
                            aria-label={`Buy NO at ${100 - yes} cents`}
                          >
                            <span>BUY NO</span>
                            <b>{100 - yes}¢</b>
                          </button>
                        </div>
                        <div className="market-meta">
                          <span>RESOLVES {m.resolves}</span>
                          <span>PAPER · SIMULATED</span>
                        </div>
                      </article>
                    );
                  })}
              </div>
              <section className="methodology-banner">
                <div>
                  <span>HOW A MARKET SETTLES</span>
                  <h3>
                    Real observations.
                    <br />A benchmark you can verify.
                  </h3>
                  <button onClick={() => nav("Indexes")}>
                    READ THE METHODOLOGY ↗
                  </button>
                </div>
                <ol>
                  {[
                    ["Venue quotes", "Listings observed across venues."],
                    [
                      "Reference prices",
                      "One robust price per constituent.",
                    ],
                    ["Canonical index", "Weighted, signed and published."],
                    ["Settlement", "Markets resolve only against the index."],
                  ].map(([title, text], i) => (
                    <li key={title}>
                      <b>0{i + 1}</b>
                      <strong>{title}</strong>
                      <p>{text}</p>
                    </li>
                  ))}
                </ol>
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
                  Five views of the skin economy. Real executable prices from
                  five marketplaces, frozen baskets and a base of 1,000. Markets
                  settle on the signed on-chain series. Collateral is USDC.
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
                          ? "Twenty premium weapon skins, one wear per skin. Equal weight, five-venue pricing."
                          : i.ticker === "HS-CASE20"
                            ? "Twenty seasoned cases priced above $1. Equal weight, five-venue pricing."
                            : i.ticker === "HS-KNIFE20"
                              ? "Twenty knives ranked by traded volume, at most two per family. Equal weight."
                              : i.ticker === "HS-GLOVE10"
                                ? "Ten gloves ranked by traded volume, at most two per family. Equal weight."
                                : "Fifty constituents across knives, gloves, weapon skins, cases and premium weapons."}
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
          <footer className="native-footer">
            <span>
              HYPERSTRIKE <b>© {new Date().getFullYear()}</b>
            </span>
            <nav aria-label="Footer">
              {[...PRIMARY, ...SECONDARY].map((v) => (
                <button key={v} onClick={() => nav(v)}>
                  {v}
                </button>
              ))}
            </nav>
            <span>HYPEREVM / NATIVE MARKETS / INDEX ALPHA</span>
            <span>BUILT FOR THE CS2 ECONOMY.</span>
          </footer>
        </div>
      )}
      {!range && (
        <>
          {menuOpen && (
            <div className="more-sheet" onClick={() => setMenuOpen(false)}>
              <div
                role="dialog"
                aria-label="More"
                onClick={(e) => e.stopPropagation()}
              >
                {SECONDARY.map((v) => (
                  <button
                    key={v}
                    className={view === v ? "active" : ""}
                    onClick={() => nav(v)}
                  >
                    {v} <span>→</span>
                  </button>
                ))}
              </div>
            </div>
          )}
          <nav className="tab-bar" aria-label="Sections">
            {PRIMARY.slice(0, 2).map((v) => (
              <button
                key={v}
                className={!menuOpen && view === v ? "active" : ""}
                onClick={() => nav(v)}
              >
                <i className={`tab-icon tab-${v.toLowerCase()}`} />
                {v}
              </button>
            ))}
            <button className="tab-range" onClick={toggleRange}>
              <span className="reticle" aria-hidden="true" />
              Range
            </button>
            <button
              className={!menuOpen && view === "Portfolio" ? "active" : ""}
              onClick={() => nav("Portfolio")}
            >
              <i className="tab-icon tab-portfolio" />
              Portfolio
            </button>
            <button
              className={
                menuOpen || SECONDARY.includes(view) ? "active" : ""
              }
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen((v) => !v)}
            >
              <i className="tab-icon tab-more" />
              More
            </button>
          </nav>
        </>
      )}
      {selected && (
        <TradeTicket
          key={selected.id}
          market={selected}
          initialSide={managedSide ?? ticketSide}
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
            resumeRange(true);
          }}
          onDismiss={() => {
            setSelected(null);
            setManagedSide(undefined);
            resumeRange();
          }}
          onTrade={transact}
        />
      )}
      {nativeSelected && (
        <NativeTicket
          record={nativeSelected}
          onClose={() => {
            setNativeSelected(null);
            resumeRange();
          }}
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
