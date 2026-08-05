import { useCallback, useEffect, useMemo, useState } from "react";
import { fetchHip4Status, outcomeCoin, type Hip4Outcome, type Hip4Status } from "./hip4";
import { burnHsx, fetchHsxStatus, formatSupply, HSX_ADDRESS, type HsxStatus } from "./hsx";
import { paperMarkets } from "./markets";
import { SoccerWorld } from "./SoccerWorld";
import type { DemoWorldCupPrediction, PortfolioDisplayEntry, SkinMarket, VoteCount, VoteSide } from "./types";
import { World } from "./World";

const PAPER_PORTFOLIO_KEY = "hyperstrike.paperPredictions.v1";
const DEMO_PORTFOLIO_KEY = "hyperstrike.demoWorldCupPredictions.v1";
const LEGACY_LIVE_PORTFOLIO_KEY = "hyperstrike.liveWorldCupPredictions.v1";

const demoWorldCupMarkets: Hip4Outcome[] = [
  {
    outcome: 90001,
    name: "France",
    description: "Demo replay: France lifts the trophy. This is a retired World Cup showcase market and does not submit a live HIP-4 order.",
    sideSpecs: [{ name: "Yes" }, { name: "No" }],
    quoteToken: "USDC",
  },
  {
    outcome: 90002,
    name: "Argentina",
    description: "Demo replay: Argentina repeats. This is a retired World Cup showcase market and does not submit a live HIP-4 order.",
    sideSpecs: [{ name: "Yes" }, { name: "No" }],
    quoteToken: "USDC",
  },
  {
    outcome: 90003,
    name: "Brazil",
    description: "Demo replay: Brazil wins the final. This is a retired World Cup showcase market and does not submit a live HIP-4 order.",
    sideSpecs: [{ name: "Yes" }, { name: "No" }],
    quoteToken: "USDC",
  },
  {
    outcome: 90004,
    name: "England",
    description: "Demo replay: England finally brings it home. This is a retired World Cup showcase market and does not submit a live HIP-4 order.",
    sideSpecs: [{ name: "Yes" }, { name: "No" }],
    quoteToken: "USDC",
  },
];

const demoWorldCupPrices: Record<number, Record<VoteSide, number>> = {
  90001: { YES: 0.52, NO: 0.48 },
  90002: { YES: 0.38, NO: 0.62 },
  90003: { YES: 0.34, NO: 0.66 },
  90004: { YES: 0.27, NO: 0.73 },
};

function createDraftNonce(): `0x${string}` {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return `0x${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

type PaperPrediction = {
  id: string;
  marketId: string;
  marketName: string;
  condition: string;
  side: VoteSide;
  amount: number;
  contracts: number;
  entryPrice: number;
  resolves: string;
  createdAt: number;
};

function MarketCard({ market, votes, onClick }: { market: SkinMarket; votes: VoteCount; onClick: () => void }) {
  return (
    <button className="market-card" onClick={onClick}>
      <span className="market-card__top"><i style={{ background: `#${market.accent.toString(16)}` }} /> RANGE LIVE · PAPER · {market.condition}</span>
      <img className="market-card__image" src={market.image} alt={market.name} />
      <strong>{market.name}</strong>
      <span>{market.question}</span>
      <div className="probability-row">
        <b>YES {market.yes}¢</b>
        <em style={{ width: `${market.yes}%` }} />
        <small>{market.volume} VOL</small>
      </div>
      <div className="card-votes"><span>YOUR FIRE</span><b>YES {votes.YES}</b><b>NO {votes.NO}</b></div>
    </button>
  );
}

function TradeDrawer({ market, votes, onClose, onSubmit, hsx }: { market: SkinMarket; votes: VoteCount; onClose: () => void; onSubmit: (prediction: PaperPrediction) => void; hsx: HsxStatus | null }) {
  const [side, setSide] = useState<"YES" | "NO">("YES");
  const [paperHsx, setPaperHsx] = useState(100);
  const [unlocked, setUnlocked] = useState(false);
  const [placed, setPlaced] = useState(false);
  const price = side === "YES" ? market.yes : 100 - market.yes;
  const contracts = votes[side];
  const orderValue = Number((contracts * price / 100).toFixed(2));
  const burnAmount = Number((orderValue * 0.01).toFixed(4));
  const totalVotes = votes.YES + votes.NO;
  const ballisticSide: VoteSide | null = votes.YES === votes.NO ? null : votes.YES > votes.NO ? "YES" : "NO";
  const ballisticConfidence = totalVotes > 0 ? Math.round((Math.max(votes.YES, votes.NO) / totalVotes) * 100) : 0;

  useEffect(() => {
    setUnlocked(false);
    setPlaced(false);
    setSide("YES");
  }, [market.id]);

  useEffect(() => {
    if (ballisticSide) setSide(ballisticSide);
  }, [ballisticSide]);

  const burn = () => {
    if (contracts < 1 || paperHsx < burnAmount) return;
    setPaperHsx((balance) => Number((balance - burnAmount).toFixed(4)));
    setUnlocked(true);
  };

  const submitPrediction = () => {
    if (placed) return;
    onSubmit({
      id: `${market.id}-${Date.now()}`,
      marketId: market.id,
      marketName: market.name,
      condition: market.condition,
      side,
      amount: orderValue,
      contracts,
      entryPrice: price,
      resolves: market.resolves,
      createdAt: Date.now(),
    });
    setPlaced(true);
  };

  return (
    <aside className="trade-drawer">
      <button className="close" onClick={onClose} aria-label="Close">×</button>
      <div className="eyebrow">SKIN PRICE OUTCOME · PAPER FIRE</div>
      <h2>{market.name}</h2>
      <p className="condition">{market.condition}</p>
      <a className="trade-skin-image" href={market.marketUrl} target="_blank" rel="noreferrer" title="View the official Steam Community Market listing">
        <img src={market.image} alt={market.name} />
        <span>OFFICIAL STEAM MARKET ITEM ↗</span>
      </a>
      <h3>{market.question}</h3>

      <div className="vote-ledger"><span>YOUR BALLISTIC VOTES</span><b className="yes">YES {votes.YES}</b><b className="no">NO {votes.NO}</b></div>
      <div className={`ballistic-draft ${ballisticSide?.toLowerCase() ?? "empty"}`}>
        <span>BALLISTIC PREDICTION DRAFT</span>
        {ballisticSide ? (
          <><strong>{ballisticSide} · {ballisticConfidence}% OF HITS</strong><p>Each hit on the selected side stages exactly one contract. The order value is contracts × side price; nothing is submitted until you confirm.</p></>
        ) : (
          <><strong>NO CONTRACTS STAGED</strong><p>Shoot a YES or NO target in the range. One target hit stages one contract on that side; misses stage nothing.</p></>
        )}
        <div><i>1 HIT</i><b>→</b><i>1 CONTRACT</i><b>→</b><i>1% $HSX BURN</i><b>→</b><i>ORDER</i></div>
      </div>

      <div className="skin-tape">
        <div><span>REFERENCE</span><b>{market.currentPrice}</b></div>
        <div><span>24H</span><b className={market.change >= 0 ? "up" : "down"}>{market.change >= 0 ? "+" : ""}{market.change}%</b></div>
        <div><span>RESOLVES</span><b>{market.resolves}</b></div>
      </div>

      <div className="side-picker">
        <button className={side === "YES" ? "active yes" : ""} onClick={() => setSide("YES")} disabled={unlocked}>YES <b>{market.yes}¢</b></button>
        <button className={side === "NO" ? "active no" : ""} onClick={() => setSide("NO")} disabled={unlocked}>NO <b>{100 - market.yes}¢</b></button>
      </div>

      <div className="amount-field derived-value">
        <span>ORDER VALUE · SET BY BALLISTIC CONTRACTS</span>
        <div><i>$</i><strong>{orderValue.toFixed(2)}</strong><em>USDC</em></div>
      </div>

      <div className="order-summary">
        <span>IOC limit</span><b>{price}¢ worst price</b>
        <span>Ballistic contracts</span><b>{contracts} ({votes[side]} {side} hits)</b>
        <span>Potential payout</span><b>${contracts.toLocaleString()}</b>
        <span>$HSX burn · 1% of value</span><b>{burnAmount.toFixed(4)} $HSX</b>
      </div>

      {!unlocked ? (
        <div className="burn-gate">
          <div className="burn-icon">◇</div>
          <div><strong>Burn 1% to arm this order</strong><span>Proportional participation burn · demo balance {paperHsx.toFixed(4)} $HSX</span></div>
          <button onClick={burn} disabled={contracts < 1 || paperHsx < burnAmount}>{contracts < 1 ? "SHOOT A TARGET TO STAGE CONTRACTS" : `BURN ${burnAmount.toFixed(4)} $HSX · ARM ORDER`}</button>
          <small>{hsx?.supportsBurnFrom ? "✓ Canonical HSX supports true supply burn via burnFrom." : "Checking canonical HSX burn support…"} Simulation only until the gate is deployed.</small>
        </div>
      ) : (
        <button className="place-order" onClick={submitPrediction} disabled={placed || contracts < 1}>
          {placed ? `PAPER HIP-4 PREDICTION SUBMITTED · ${side}` : `SUBMIT PAPER HIP-4 ${side} PREDICTION`}
        </button>
      )}
      <p className="risk">Paper preview · no funds at risk · final settlement follows registered HIP-4 terms</p>
    </aside>
  );
}

function PortfolioPanel({
  predictions,
  demoPredictions,
  onClose,
  onRemove,
  onRemoveDemo,
}: {
  predictions: PaperPrediction[];
  demoPredictions: DemoWorldCupPrediction[];
  onClose: () => void;
  onRemove: (id: string) => void;
  onRemoveDemo: (id: string) => void;
}) {
  const committed = predictions.reduce((sum, prediction) => sum + prediction.amount, 0);
  const payout = predictions.reduce((sum, prediction) => sum + prediction.contracts, 0);
  const demoCommitted = demoPredictions.reduce((sum, prediction) => sum + prediction.orderValue, 0);
  const demoContracts = demoPredictions.reduce((sum, prediction) => sum + prediction.contracts, 0);
  return (
    <section className="portfolio-panel">
      <button className="close" onClick={onClose} aria-label="Close portfolio">×</button>
      <div className="eyebrow">POSITION LEDGER</div>
      <h2>REGISTERED PREDICTIONS</h2>
      <p className="portfolio-intro">CS2 skin positions are paper previews saved locally. World Cup entries are retired-event demo receipts: no wallet, no $HSX burn, and no live HIP-4 order.</p>
      <div className="portfolio-summary">
        <span><b>{predictions.length + demoPredictions.length}</b> RECEIPTS</span>
        <span><b>${(committed + demoCommitted).toLocaleString()}</b> STAGED VALUE</span>
        <span><b>{(payout + demoContracts).toLocaleString()}</b> CONTRACTS</span>
      </div>
      {demoPredictions.length > 0 && (
        <div className="position-list live-position-list">
          {demoPredictions.map((prediction) => (
            <article key={prediction.id} className={prediction.side.toLowerCase()}>
              <div><span>DEMO · WORLD CUP REPLAY · {prediction.status}</span><time>{new Date(prediction.createdAt).toLocaleString()}</time></div>
              <h3>{prediction.marketName}</h3>
              <p>{prediction.description}</p>
              <dl>
                <div><dt>SIDE</dt><dd>{prediction.side}</dd></div>
                <div><dt>REFERENCE</dt><dd>{Math.round(prediction.limitPrice * 100)}¢</dd></div>
                <div><dt>VALUE</dt><dd>${prediction.orderValue.toFixed(2)}</dd></div>
                <div><dt>CONTRACTS</dt><dd>{prediction.contracts}</dd></div>
                <div><dt>DEMO BURN</dt><dd>{prediction.burnAmount.toFixed(4)} $HSX</dd></div>
                <div><dt>RECEIPT</dt><dd>{prediction.orderId.slice(0, 10)}…</dd></div>
              </dl>
              <button className="remove-position" onClick={() => onRemoveDemo(prediction.id)}>HIDE DEMO RECEIPT</button>
            </article>
          ))}
        </div>
      )}
      {predictions.length === 0 && demoPredictions.length === 0 ? (
        <div className="portfolio-empty"><strong>NO PREDICTIONS REGISTERED</strong><p>Open a skin market for a paper CS2 prediction, or use the World Cup demo to save a retired-event penalty ticket.</p></div>
      ) : predictions.length > 0 && (
        <div className="position-list">
          {predictions.map((prediction) => (
            <article key={prediction.id} className={prediction.side.toLowerCase()}>
              <div><span>OPEN · PAPER</span><time>{new Date(prediction.createdAt).toLocaleString()}</time></div>
              <h3>{prediction.marketName}</h3>
              <p>{prediction.condition}</p>
              <dl>
                <div><dt>SIDE</dt><dd>{prediction.side}</dd></div>
                <div><dt>ENTRY</dt><dd>{prediction.entryPrice}¢</dd></div>
                <div><dt>VALUE</dt><dd>${prediction.amount}</dd></div>
                <div><dt>CONTRACTS</dt><dd>{prediction.contracts}</dd></div>
                <div><dt>RESOLVES</dt><dd>{prediction.resolves}</dd></div>
              </dl>
              <button className="remove-position" onClick={() => onRemove(prediction.id)}>REMOVE PAPER POSITION</button>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

function BurnFurnace({ hsx, onClose }: { hsx: HsxStatus | null; onClose: () => void }) {
  const [amount, setAmount] = useState("1000");
  const [burning, setBurning] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [transactionHash, setTransactionHash] = useState<string | null>(null);
  const submit = async () => {
    setBurning(true);
    setMessage(null);
    setTransactionHash(null);
    try {
      const receipt = await burnHsx(amount);
      setTransactionHash(receipt.transactionHash);
      setMessage(`${receipt.amount} $HSX permanently removed from supply.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "The burn transaction failed.");
    } finally {
      setBurning(false);
    }
  };
  return (
    <section className="furnace-panel">
      <button className="close" onClick={onClose} aria-label="Close HSX furnace">×</button>
      <div className="furnace-panel__glow" aria-hidden="true" />
      <div className="eyebrow">HYPEREVM · CANONICAL SUPPLY CONTROL</div>
      <h2>$HSX FURNACE</h2>
      <p>Burn your own $HSX directly through the canonical token contract. This transaction is irreversible and permanently reduces total supply.</p>
      <div className="furnace-address"><span>TOKEN</span><code>{HSX_ADDRESS}</code></div>
      <label className="furnace-amount"><span>AMOUNT TO DESTROY</span><div><input value={amount} inputMode="decimal" onChange={(event) => setAmount(event.target.value)} /><b>$HSX</b></div></label>
      <div className="furnace-stats"><span>NETWORK <b>HYPEREVM</b></span><span>SUPPLY <b>{hsx ? formatSupply(hsx) : "CHECKING"}</b></span><span>BURN ABI <b>{hsx?.supportsBurn ? "VERIFIED" : "CHECKING"}</b></span></div>
      <button className="furnace-submit" disabled={burning || !hsx?.supportsBurn} onClick={() => void submit()}>{burning ? "WAITING FOR HYPEREVM…" : `BURN ${amount || "0"} $HSX FOREVER`}</button>
      {message && <div className="furnace-message">{message}{transactionHash && <a href={`https://hyperevmscan.io/tx/${transactionHash}`} target="_blank" rel="noreferrer"> VIEW TRANSACTION ↗</a>}</div>}
      <small>Manual burns are separate from the 1% participation burn required to arm a HyperStrike order.</small>
    </section>
  );
}

function HowItWorks({ onClose }: { onClose: () => void }) {
  return (
    <section className="how-panel">
      <button className="close" onClick={onClose} aria-label="Close explanation">×</button>
      <div className="eyebrow">THE MARKET IS THE TARGET</div>
      <h2>FROM PRICE CALL TO POSITION</h2>
      <p className="how-intro">HyperStrike turns conviction into something physical: aim at a skin, choose a side, and put rounds on your prediction. HIP-4 carries the market; HyperEVM makes $HSX access verifiable.</p>
      <div className="flow-grid">
        <article><b>01</b><span>AIM</span><h3>Pick a skin and side</h3><p>Every vault presents the official skin image beside two physical targets: YES and NO. Put the crosshair on the call you believe.</p></article>
        <article><b>02</b><span>FIRE</span><h3>Stage one contract per hit</h3><p>Every target hit is one vote and one contract on that side. Five YES hits stage five YES contracts; misses count for nothing.</p></article>
        <article><b>03</b><span>ARM</span><h3>Burn 1% of order value</h3><p>Order value equals contract count × side price. The HyperEVM gate burns an $HSX amount equal to 1% of that value before submission.</p></article>
        <article><b>04</b><span>SUBMIT</span><h3>Confirm the HIP-4 order</h3><p>Gunfire only builds the draft. You still review the side, contracts, value and burn, then explicitly sign the order.</p></article>
      </div>
      <div className="architecture-strip"><span>3D WEB CLIENT</span><i>→</i><span>$HSX BURN · HYPEREVM</span><i>→</i><span>HIP-4 CLOB · HYPERCORE</span><i>→</i><span>SKIN ORACLE</span></div>
      <div className="truth-note"><strong>Enforcement boundary</strong><p>Issuance burns are enforceable because HyperStrike controls market submission. Participation burns are enforced by HyperStrike, but a public HIP-4 order can still be submitted through another client unless HIP-4 adds a native token gate.</p></div>
    </section>
  );
}

function Hip4Explorer({ status, onClose }: { status: Hip4Status | null; onClose: () => void }) {
  return (
    <section className="hip4-panel">
      <button className="close" onClick={onClose} aria-label="Close HIP-4 network outcomes">×</button>
      <div className="eyebrow">LIVE HYPERLIQUID METADATA</div>
      <h2>NETWORK OUTCOMES</h2>
      <p className="hip4-intro">This is the validated outcome catalogue returned by <code>POST api.hyperliquid.xyz/info</code> with <code>{'{ "type": "outcomeMeta" }'}</code>. It is network-wide metadata—not a claim that HyperStrike has live skin markets.</p>
      <div className="hip4-summary">
        <span><b>{status?.outcomeCount ?? "—"}</b> RECORDS</span>
        <span><b>{status?.binaryCount ?? "—"}</b> YES / NO</span>
        <span><b>{status?.questionCount ?? "—"}</b> QUESTIONS</span>
        <span><b>{status?.quoteTokens.join(" / ") || "—"}</b> QUOTE</span>
        <span><b>{status ? new Date(status.checkedAt).toLocaleTimeString() : "—"}</b> CHECKED</span>
      </div>
      <div className="network-truth"><strong>HyperStrike skin markets</strong><span>The launch set is liquidity-screened but remains paper-only until its validator-approved template instances are deployed, discoverable here, and bound to the production gate.</span></div>
      <div className="outcome-list">
        {status?.outcomes.map((outcome) => (
          <article key={outcome.outcome}>
            <div><span>OUTCOME #{outcome.outcome}</span><b>{outcome.quoteToken}</b></div>
            <h3>{outcome.name || "UNTITLED OUTCOME"}</h3>
            <p>{outcome.description || "No resolution description supplied."}</p>
            <div className="outcome-sides">{outcome.sideSpecs.map((side) => side.name).join(" / ")}</div>
          </article>
        ))}
      </div>
    </section>
  );
}

function WorldCupOrderPanel({ market, prices, kicks, onSubmitted }: {
  market: Hip4Outcome | null;
  prices: Record<VoteSide, number>;
  kicks: VoteCount;
  onSubmitted: (prediction: DemoWorldCupPrediction) => void;
}) {
  const [side, setSide] = useState<VoteSide>("YES");
  const [reviewing, setReviewing] = useState(false);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");
  const [draftNonce, setDraftNonce] = useState(createDraftNonce);
  const [reviewOrderId, setReviewOrderId] = useState<`0x${string}` | null>(null);
  const contracts = kicks[side];
  const midPrice = prices[side];
  const limitPrice = Math.min(0.99, Number((midPrice + 0.02).toFixed(4)));
  const orderValue = Number((contracts * limitPrice).toFixed(2));
  const burnAmount = Number((orderValue * 0.01).toFixed(4));
  const majority = kicks.YES === kicks.NO ? null : kicks.YES > kicks.NO ? "YES" : "NO";
  const marketOutcome = market?.outcome ?? null;
  const marketName = market?.name ?? "";

  useEffect(() => {
    if (majority) setSide(majority);
  }, [majority]);

  useEffect(() => {
    setReviewing(false);
    setMessage("");
    setReviewOrderId(null);
    setDraftNonce(createDraftNonce());
  }, [marketOutcome, side, contracts]);

  const deriveCurrentOrderId = () => {
    if (!marketOutcome || contracts < 1) return null;
    return draftNonce;
  };

  const openReview = () => {
    const nextOrderId = deriveCurrentOrderId();
    if (!nextOrderId) return;
    setReviewOrderId(nextOrderId);
    setReviewing(true);
  };

  const submit = () => {
    if (!market || contracts < 1) return;
    const orderId = reviewOrderId ?? deriveCurrentOrderId();
    if (!orderId) return;
    setPending(true);
    onSubmitted({
      id: `${market.outcome}-${orderId}`,
      orderId,
      outcomeId: market.outcome,
      marketName: market.name,
      description: market.description,
      side,
      contracts,
      limitPrice,
      orderValue,
      burnAmount,
      status: "SAVED",
      createdAt: Date.now(),
    });
    setMessage(`DEMO RECEIPT SAVED · ${orderId.slice(0, 10)}…`);
    setReviewOrderId(null);
    setDraftNonce(createDraftNonce());
    setReviewing(false);
    setPending(false);
  };

  return (
    <aside className="cup-order-panel">
      <div className="eyebrow">RETIRED EVENT · DEMO PENALTY TICKET</div>
      <h2>{market?.name ?? "SELECT A COUNTRY"}</h2>
      <p>{market?.description ?? "Choose a World Cup demo outcome."}</p>
      <div className="cup-live-meta"><span>DEMO REF <b>#{market?.outcome ?? "—"}</b></span><span>QUOTE <b>{market?.quoteToken ?? "—"}</b></span><span>COINS <b>{market ? `${outcomeCoin(market.outcome, 0)} / ${outcomeCoin(market.outcome, 1)}` : "—"}</b></span></div>
      <div className="side-picker cup-side-picker">
        <button className={side === "YES" ? "active yes" : ""} onClick={() => setSide("YES")} disabled={pending}>YES <b>{Math.round(prices.YES * 100)}¢</b><small>{kicks.YES} CONTRACTS</small></button>
        <button className={side === "NO" ? "active no" : ""} onClick={() => setSide("NO")} disabled={pending}>NO <b>{Math.round(prices.NO * 100)}¢</b><small>{kicks.NO} CONTRACTS</small></button>
      </div>
      <div className="cup-order-math">
        <span>Gauge-multiplied contracts</span><b>{contracts}</b>
        <span>Demo reference mid</span><b>{Math.round(midPrice * 100)}¢</b>
        <span>Simulated worst price</span><b>{Math.round(limitPrice * 100)}¢</b>
        <span>Simulated order value</span><b>${orderValue.toFixed(2)} USDC</b>
        <span>Demo $HSX burn math · 1%</span><b>{burnAmount.toFixed(4)} $HSX</b>
        <span>Receipt hash</span><b>{reviewOrderId ? `${reviewOrderId.slice(0, 10)}…` : "GENERATED ON REVIEW"}</b>
      </div>
      {!reviewing ? (
        <button className="cup-primary" disabled={!market || contracts < 1} onClick={openReview}>
          {contracts < 1 ? "KICK YES OR NO TO STAGE DEMO CONTRACTS" : "REVIEW DEMO TICKET"}
        </button>
      ) : (
        <div className="live-confirm">
          <strong>DEMO ONLY · NO FUNDS MOVE</strong>
          <p>This saves a local replay receipt for {contracts} {side} demo contracts. The 1% $HSX burn and HIP-4 order values are shown for product rehearsal only; nothing is signed, burned, or submitted.</p>
          <button disabled={pending} onClick={submit}>{pending ? "SAVING…" : "SAVE DEMO RECEIPT"}</button>
          <button disabled={pending} onClick={() => setReviewing(false)}>CANCEL</button>
        </div>
      )}
      {message && <div className="cup-order-message">{message}</div>}
      <small className="cup-risk">The captured 1–100 gauge value stages that many demo contracts. This retired-event mode never opens a wallet, burns $HSX, or submits a HIP-4 order.</small>
    </aside>
  );
}

export default function App() {
  const [experience, setExperience] = useState<"skins" | "worldcup">("skins");
  const [selected, setSelected] = useState<SkinMarket | null>(null);
  const [nearby, setNearby] = useState<SkinMarket | null>(null);
  const [entered, setEntered] = useState(false);
  const [controlsLocked, setControlsLocked] = useState(false);
  const [ammo, setAmmo] = useState({ magazine: 30, reserve: Number.POSITIVE_INFINITY, reloading: false });
  const [votes, setVotes] = useState<Record<string, VoteCount>>(() => Object.fromEntries(paperMarkets.map((market) => [market.id, { YES: 0, NO: 0 }])));
  const [lastVote, setLastVote] = useState<{ market: SkinMarket; side: VoteSide; at: number } | null>(null);
  const [marketList, setMarketList] = useState(false);
  const [howOpen, setHowOpen] = useState(false);
  const [portfolioOpen, setPortfolioOpen] = useState(false);
  const [manualBurnOpen, setManualBurnOpen] = useState(false);
  const [furnaceNearby, setFurnaceNearby] = useState(false);
  const [hip4Open, setHip4Open] = useState(false);
  const [paperPredictions, setPaperPredictions] = useState<PaperPrediction[]>(() => {
    try {
      const stored = localStorage.getItem(PAPER_PORTFOLIO_KEY);
      return stored ? JSON.parse(stored) as PaperPrediction[] : [];
    } catch {
      return [];
    }
  });
  const [demoPredictions, setDemoPredictions] = useState<DemoWorldCupPrediction[]>(() => {
    try {
      const stored = localStorage.getItem(DEMO_PORTFOLIO_KEY) ?? localStorage.getItem(LEGACY_LIVE_PORTFOLIO_KEY);
      return stored ? JSON.parse(stored) as DemoWorldCupPrediction[] : [];
    } catch {
      return [];
    }
  });
  const [worldReady, setWorldReady] = useState(false);
  const [status, setStatus] = useState<Hip4Status | null>(null);
  const [hsx, setHsx] = useState<HsxStatus | null>(null);
  const [wallet, setWallet] = useState<string | null>(null);
  const [cupOutcomeId, setCupOutcomeId] = useState<number | null>(null);
  const [cupKicks, setCupKicks] = useState<Record<number, VoteCount>>({});

  useEffect(() => {
    const controller = new AbortController();
    const refreshMarkets = () => fetchHip4Status(controller.signal).then(setStatus).catch(() => {
      if (!controller.signal.aborted) setStatus((current) => current ?? { online: false, outcomeCount: 0, questionCount: 0, binaryCount: 0, quoteTokens: [], outcomes: [], questions: [], mids: {}, checkedAt: Date.now() });
    });
    void refreshMarkets();
    const marketRefresh = window.setInterval(() => void refreshMarkets(), 15_000);
    fetchHsxStatus(controller.signal).then(setHsx).catch(() => setHsx(null));
    return () => {
      window.clearInterval(marketRefresh);
      controller.abort();
    };
  }, []);

  useEffect(() => {
    localStorage.setItem(PAPER_PORTFOLIO_KEY, JSON.stringify(paperPredictions));
  }, [paperPredictions]);
  useEffect(() => {
    localStorage.setItem(DEMO_PORTFOLIO_KEY, JSON.stringify(demoPredictions));
  }, [demoPredictions]);

  const systemText = useMemo(() => {
    if (!status) return "CONNECTING TO HYPERCORE";
    return status.online ? `HIP-4 META · ${status.outcomeCount} NETWORK OUTCOMES · VIEW` : "HIP-4 META OFFLINE · PAPER MODE";
  }, [status]);
  const worldCupMarkets = demoWorldCupMarkets;
  const cupMarket = worldCupMarkets.find((market) => market.outcome === cupOutcomeId) ?? worldCupMarkets[0] ?? null;
  const cupPrices = useMemo(() => {
    if (!cupMarket) return { YES: 0, NO: 0 };
    const fallback = demoWorldCupPrices[cupMarket.outcome] ?? { YES: 0.5, NO: 0.5 };
    return { YES: fallback.YES, NO: fallback.NO };
  }, [cupMarket]);
  const activeCupKicks = cupMarket ? cupKicks[cupMarket.outcome] ?? { YES: 0, NO: 0 } : { YES: 0, NO: 0 };
  const portfolioDisplay = useMemo<PortfolioDisplayEntry[]>(() => ([
    ...demoPredictions.map((prediction) => ({
      marketName: `World Cup Demo · ${prediction.marketName}`,
      side: prediction.side,
      amount: prediction.orderValue,
      contracts: prediction.contracts,
      entryPrice: Math.round(prediction.limitPrice * 100),
      resolves: `Demo ref #${prediction.outcomeId}`,
    })),
    ...paperPredictions,
  ]), [demoPredictions, paperPredictions]);

  const handleEntered = useCallback(() => setEntered(true), []);
  const handleWorldReady = useCallback(() => setWorldReady(true), []);
  const handlePaperPrediction = useCallback((prediction: PaperPrediction) => {
    setPaperPredictions((current) => [prediction, ...current]);
  }, []);
  const handleDemoPrediction = useCallback((prediction: DemoWorldCupPrediction) => {
    setDemoPredictions((current) => [prediction, ...current.filter((item) => item.id !== prediction.id)]);
  }, []);
  const removePaperPrediction = useCallback((id: string) => {
    setPaperPredictions((current) => current.filter((prediction) => prediction.id !== id));
  }, []);
  const removeDemoPrediction = useCallback((id: string) => {
    setDemoPredictions((current) => current.filter((prediction) => prediction.id !== id));
  }, []);
  const openPortfolio = useCallback(() => {
    setSelected(null);
    setMarketList(false);
    setHowOpen(false);
    setHip4Open(false);
    setPortfolioOpen(true);
  }, []);
  const handleAmmoChange = useCallback((magazine: number, reserve: number, reloading: boolean) => {
    setAmmo({ magazine, reserve, reloading });
  }, []);
  const handleVote = useCallback((market: SkinMarket, side: VoteSide) => {
    setVotes((current) => ({
      ...current,
      [market.id]: { ...current[market.id], [side]: current[market.id][side] + 1 },
    }));
    setLastVote({ market, side, at: Date.now() });
  }, []);
  const captureControls = useCallback(() => {
    setEntered(true);
    const canvas = document.querySelector<HTMLCanvasElement>(".world-canvas canvas");
    canvas?.requestPointerLock();
  }, []);
  const openExperience = useCallback((next: "skins" | "worldcup") => {
    if (next === experience) {
      // The mounted WebGL world only emits `onReady` once. Re-selecting the
      // active experience must not put the app back into an unrecoverable
      // loading state.
      setWorldReady(true);
    } else {
      setWorldReady(false);
      setExperience(next);
    }
    setSelected(null);
    setMarketList(false);
    setHowOpen(false);
    setPortfolioOpen(false);
    setManualBurnOpen(false);
    setHip4Open(false);
  }, [experience]);
  const handleCupKick = useCallback((side: VoteSide, multiplier: number) => {
    if (!cupMarket) return;
    setCupKicks((current) => ({
      ...current,
      [cupMarket.outcome]: {
        YES: (current[cupMarket.outcome]?.YES ?? 0) + (side === "YES" ? multiplier : 0),
        NO: (current[cupMarket.outcome]?.NO ?? 0) + (side === "NO" ? multiplier : 0),
      },
    }));
  }, [cupMarket]);
  const connectWallet = useCallback(async () => {
    try {
      const { connectHyperliquidWallet } = await import("./liveOrder");
      setWallet(await connectHyperliquidWallet());
    } catch (error) {
      alert(error instanceof Error ? error.message : "Wallet connection failed.");
    }
  }, []);

  return (
    <main className={`app-shell ${experience === "worldcup" ? "cup-mode" : "range-mode"} ${worldReady ? "world-ready" : "world-loading"}`}>
      {experience === "skins" ? (
        <World
          markets={paperMarkets}
          onSelect={setSelected}
          onProximity={setNearby}
          entered={entered}
          onEntered={handleEntered}
          onLockChange={setControlsLocked}
          onAmmoChange={handleAmmoChange}
          onVote={handleVote}
          votes={votes}
          portfolio={portfolioDisplay}
          onFurnace={() => setManualBurnOpen(true)}
          onFurnaceProximity={setFurnaceNearby}
          onReady={handleWorldReady}
        />
      ) : (
        <SoccerWorld market={cupMarket} prices={cupPrices} kicks={activeCupKicks} onKick={handleCupKick} onReady={handleWorldReady} />
      )}
      {!worldReady && (
        <div className="world-loader" role="status" aria-live="polite">
          <img src="/brand/hyperstrike-mark.png" alt="" />
          <span>{experience === "skins" ? "PREPARING PRICE RANGE" : "OPENING WORLD CUP DEMO"}</span>
          <b>{experience === "skins" ? "LIGHTING · MARKETS · VIEW MODEL" : "STADIUM · RETIRED EVENT · PENALTY SYSTEM"}</b>
          <i />
        </div>
      )}
      <div className="vignette" />
      {experience === "skins" && entered && !selected && !howOpen && !portfolioOpen && !hip4Open && !manualBurnOpen && (
        <div className="bodycam-overlay" aria-hidden="true">
          <div className="bodycam-rec"><i /> REC</div>
          <div className="bodycam-id">HSX / BODYCAM 01<br /><span>HYPERCORE RANGE</span></div>
          <div className="bodycam-brackets"><i /><i /><i /><i /></div>
        </div>
      )}
      {experience === "skins" && entered && !selected && !manualBurnOpen && <div className="crosshair" aria-hidden="true"><i /><i /><i /><i /></div>}
      {experience === "skins" && entered && furnaceNearby && !manualBurnOpen && !selected && (
        <div className="interact-prompt furnace-prompt"><kbd>E</kbd><span>HYPEREVM FURNACE</span><strong>MANUALLY BURN $HSX</strong></div>
      )}

      <header>
        <button className="brand" onClick={() => { setSelected(null); setPortfolioOpen(false); setHowOpen(false); setHip4Open(false); setManualBurnOpen(false); }}><img src="/brand/hyperstrike-mark.png" alt="" /><span className="brand-word"><i>HYPER</i>STRIKE</span><sup>RANGE 01</sup></button>
        <nav>
          <button className={experience === "worldcup" ? "event-active" : ""} onClick={() => openExperience("worldcup")}>WORLD CUP <b>DEMO</b></button>
          <button className={experience === "skins" ? "range-active" : ""} onClick={() => openExperience("skins")}>SKIN RANGE</button>
          <button onClick={() => { setPortfolioOpen(false); setHowOpen(false); setHip4Open(false); setMarketList((open) => !open); }}>MARKETS <b>{paperMarkets.length}</b></button>
          <button onClick={() => { setPortfolioOpen(false); setMarketList(false); setHip4Open(false); setHowOpen(true); }}>HOW IT WORKS</button>
          <button onClick={openPortfolio}>PORTFOLIO <b>{paperPredictions.length + demoPredictions.length}</b></button>
        </nav>
        <button className="wallet" disabled={experience === "worldcup"} onClick={() => void connectWallet()}>{experience === "worldcup" ? "DEMO · NO WALLET" : wallet ? `${wallet.slice(0, 6)}…${wallet.slice(-4)}` : "CONNECT WALLET"}</button>
      </header>

      <div className="status-stack">
        <button className="system-status" onClick={() => { setSelected(null); setPortfolioOpen(false); setHowOpen(false); setMarketList(false); setHip4Open(true); }}><i className={status?.online ? "online" : ""} />{systemText}</button>
        <div className="token-status"><i className={hsx?.supportsBurnFrom ? "online" : ""} />$HSX · {hsx ? `${formatSupply(hsx)} SUPPLY · BURN VERIFIED` : "CHECKING HYPEREVM"}</div>
      </div>

      {experience === "skins" && !entered && (
        <section className="hero-panel">
          <img className="hero-mark" src="/brand/hyperstrike-mark.png" alt="" />
          <div className="eyebrow">HYPERCORE RANGE / SKIN PRICE OPERATIONS</div>
          <h1>CALL THE<br /><em>NEXT PRICE.</em></h1>
          <p>The world’s first prediction market built exclusively for CS2 skins. Aim at YES or NO. Every target hit stages one directional vote and one contract.</p>
          <div className="hero-metrics"><span><b>3</b> PAPER SKIN MARKETS</span><span><b>{status?.outcomeCount ?? "—"}</b> NETWORK OUTCOMES</span><span><b>{hsx ? formatSupply(hsx) : "—"}</b> HSX SUPPLY</span></div>
          <div className="hero-actions">
            <button className="enter" onClick={captureControls}>DEPLOY TO RANGE <span>→</span></button>
            <button className="browse" onClick={() => setMarketList(true)}>BROWSE IN 2D</button>
            <button className="browse" onClick={() => setHowOpen(true)}>HOW IT WORKS</button>
          </div>
          <small>HOLD LMB: FULL AUTO · TARGET HIT: +1 VOTE / +1 CONTRACT · R: RELOAD · E: MARKET</small>
        </section>
      )}

      {experience === "worldcup" && worldReady && !howOpen && !portfolioOpen && !hip4Open && (
        <>
          <section className="cup-selector">
            <div className="cup-selector__heading"><span>RETIRED SPECIAL EVENT</span><strong>WORLD CUP DEMO</strong><small>{worldCupMarkets.length} DEMO OUTCOMES · NO LIVE ORDERS</small></div>
            <div className="cup-country-list">
              {worldCupMarkets.map((outcome) => {
                const yes = Math.round((demoWorldCupPrices[outcome.outcome]?.YES ?? 0.5) * 100);
                return <button key={outcome.outcome} className={cupMarket?.outcome === outcome.outcome ? "active" : ""} onClick={() => setCupOutcomeId(outcome.outcome)}><span>{outcome.name}</span><b>{yes}¢ YES</b><small>DEMO REF #{outcome.outcome}</small></button>;
              })}
            </div>
          </section>
          <WorldCupOrderPanel market={cupMarket} prices={cupPrices} kicks={activeCupKicks} onSubmitted={handleDemoPrediction} />
          <div className="cup-live-ribbon"><i /> WORLD CUP RETIRED · DEMO REPLAY · NO WALLET · NO BURN · NO HIP-4 ORDER</div>
        </>
      )}

      {experience === "skins" && entered && !selected && controlsLocked && <div className="controls"><kbd>WASD</kbd> MOVE <kbd>SHIFT</kbd> SPRINT <kbd>HOLD LMB</kbd> AUTO VOTE <kbd>E</kbd> MARKET <kbd>R</kbd> RELOAD <kbd>ESC</kbd> RELEASE</div>}
      {experience === "skins" && entered && !selected && !controlsLocked && (
        <button className="lock-prompt" onClick={captureControls}><span>WEAPON SAFE · CONTROLS PAUSED</span><strong>CLICK TO ARM FIRST-PERSON MODE</strong><small>WASD to move · hold LMB to fire · hit YES or NO to vote</small></button>
      )}
      {experience === "skins" && nearby && entered && !selected && controlsLocked && !furnaceNearby && !manualBurnOpen && <div className="interact-prompt"><kbd>E</kbd><span>MARKET TARGETED · PRESS TO OPEN</span><strong>{nearby.name}</strong></div>}
      {experience === "skins" && entered && !nearby && !selected && controlsLocked && !furnaceNearby && !manualBurnOpen && <div className="aim-hint">HIT YES OR NO · 1 ROUND = 1 VOTE = 1 CONTRACT</div>}
      {experience === "skins" && lastVote && entered && !selected && <div key={lastVote.at} className={`shot-vote ${lastVote.side.toLowerCase()}`}><b>+1 {lastVote.side} VOTE · +1 CONTRACT</b><span>{lastVote.market.name} · ORDER DRAFT UPDATED</span></div>}
      {experience === "skins" && entered && !selected && (
        <div className={`ammo-hud ${ammo.reloading ? "reloading" : ""}`}><span>{ammo.reloading ? "TACTICAL RELOAD" : "AK-47 · FULL AUTO"}</span><b>{String(ammo.magazine).padStart(2, "0")}</b><i>/</i><em>{Number.isFinite(ammo.reserve) ? String(ammo.reserve).padStart(2, "0") : "∞"}</em><small>1 HIT = 1 VOTE = 1 CONTRACT</small></div>
      )}

      <section className={`market-list ${experience === "skins" && marketList ? "open" : ""}`}>
        <div className="market-list__header"><div><span>ACTIVE PRICE CALLS</span><b>HIP-4 · PAPER FIRE</b></div><button onClick={() => setMarketList(false)}>CLOSE ×</button></div>
        {paperMarkets.map((market) => <MarketCard key={market.id} market={market} votes={votes[market.id]} onClick={() => { setSelected(market); setMarketList(false); }} />)}
      </section>

      {experience === "skins" && selected && <TradeDrawer market={selected} votes={votes[selected.id]} onClose={() => setSelected(null)} onSubmit={handlePaperPrediction} hsx={hsx} />}
      {howOpen && <HowItWorks onClose={() => setHowOpen(false)} />}
      {portfolioOpen && <PortfolioPanel predictions={paperPredictions} demoPredictions={demoPredictions} onClose={() => setPortfolioOpen(false)} onRemove={removePaperPrediction} onRemoveDemo={removeDemoPrediction} />}
      {manualBurnOpen && <BurnFurnace hsx={hsx} onClose={() => setManualBurnOpen(false)} />}
      {hip4Open && <Hip4Explorer status={status} onClose={() => setHip4Open(false)} />}

      <footer>
        <span>HYPERLIQUID</span><b>HIP-4 OUTCOMES</b><span>$HSX {HSX_ADDRESS.slice(0, 8)}…{HSX_ADDRESS.slice(-6)}</span>
        <em>{experience === "worldcup" ? "DEMO REPLAY · STRIKE THE ARCHIVE" : "ENTER THE RANGE · CALL THE NEXT PRICE"}</em>
      </footer>
    </main>
  );
}
