import { useState } from "react";
import { parseUnits, formatUnits } from "ethers";
import { question, type MarketDefinition } from "@hyperstrike/market-types";
import {
  readNativeMarket,
  tradeNative,
  redeemNative,
  signer,
} from "./nativeClient";
export type NativeRecord = {
  address: string;
  creator: string;
  question: string;
  definition: MarketDefinition;
};
export function decodeNativeRecord(raw: NativeRecord): NativeRecord {
  return {
    ...raw,
    definition: {
      ...raw.definition,
      thresholdE8: BigInt(raw.definition.thresholdE8),
      creationReferenceValueE8: BigInt(raw.definition.creationReferenceValueE8),
    },
  };
}
export function NativeTicket({
  record,
  onClose,
  onNotice,
}: {
  record: NativeRecord;
  onClose: () => void;
  onNotice: (s: string) => void;
}) {
  const [side, setSide] = useState<0 | 1>(0),
    [action, setAction] = useState<"BUY" | "SELL">("BUY"),
    [amount, setAmount] = useState("25"),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [quote, setQuote] = useState<{
    tokens: bigint;
    fee: bigint;
    minOut: bigint;
    deadline: number;
    decimals: number;
    symbol: string;
    state: number;
    owned: bigint;
  } | null>(null);
  const refresh = async () => {
    setBusy(true);
    setError("");
    try {
      const state = await readNativeMarket(record.address, record.definition);
      const s = await signer();
      const owned = await state.market.balanceOf(await s.getAddress(), side);
      if (state.state >= 4) {
        setQuote({
          tokens: 0n,
          fee: 0n,
          minOut: 0n,
          deadline: 0,
          ...state,
          owned,
        });
        return;
      }
      if (state.state !== 0)
        throw Error("Trading is closed; this market is awaiting settlement");
      const input = parseUnits(amount, state.decimals);
      const result = await state.market[
        action === "BUY" ? "quoteBuy" : "quoteSell"
      ](side, input);
      const out = result[0] as bigint;
      setQuote({
        tokens: out,
        fee: result[2],
        minOut: (out * 99n) / 100n,
        deadline: Math.floor(Date.now() / 1000) + 120,
        ...state,
        owned,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Quote unavailable");
    } finally {
      setBusy(false);
    }
  };
  const execute = async () => {
    if (!quote) return;
    setBusy(true);
    setError("");
    try {
      if (Date.now() / 1000 > quote.deadline && quote.state < 4)
        throw Error("Quote expired; refresh before confirming");
      await readNativeMarket(record.address, record.definition);
      const tx =
        quote.state >= 4
          ? await redeemNative(record.address)
          : await tradeNative(
              record.address,
              side === 0 ? "YES" : "NO",
              action,
              amount,
              quote.minOut,
              quote.deadline,
            );
      onNotice(`HyperEVM transaction confirmed: ${tx}`);
      setQuote(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Transaction failed");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="ticket-backdrop" onClick={onClose}>
      <aside
        className="native-ticket"
        role="dialog"
        aria-modal="true"
        aria-label="Native market order"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          className="ticket-close"
          onClick={onClose}
          aria-label="Close native order"
        >
          ×
        </button>
        <span className="overline">HYPEREVM / NATIVE MARKET</span>
        <h2>{question(record.definition)}</h2>
        <p className="ticket-disclosure">
          Creator {record.creator}
          <br />
          Closes{" "}
          {new Date(record.definition.tradeCloseTime * 1000).toISOString()}
        </p>
        <div className="trade-tabs">
          {(["BUY", "SELL"] as const).map((a) => (
            <button
              key={a}
              className={a === action ? "active" : ""}
              onClick={() => {
                setAction(a);
                setQuote(null);
              }}
            >
              {a}
            </button>
          ))}
        </div>
        <div className="outcome-buttons">
          {([0, 1] as const).map((s) => (
            <button
              key={s}
              className={side === s ? `active ${s === 0 ? "yes" : "no"}` : ""}
              onClick={() => {
                setSide(s);
                setQuote(null);
              }}
            >
              {s === 0 ? "YES" : "NO"}
            </button>
          ))}
        </div>
        <label className="native-input">
          <span>
            {action === "BUY" ? "COLLATERAL AMOUNT" : "OUTCOME TOKENS"}
          </span>
          <input
            type="number"
            value={amount}
            min="0"
            onChange={(e) => {
              setAmount(e.target.value);
              setQuote(null);
            }}
          />
        </label>
        <button
          className="secondary full"
          disabled={busy}
          onClick={() => void refresh()}
        >
          GET VERIFIED ONCHAIN QUOTE
        </button>
        {quote && (
          <>
            <dl className="ticket-metrics">
              <dt>Expected output</dt>
              <dd>{formatUnits(quote.tokens, quote.decimals)}</dd>
              <dt>Fee</dt>
              <dd>
                {formatUnits(quote.fee, quote.decimals)} {quote.symbol}
              </dd>
              <dt>Minimum received</dt>
              <dd>{formatUnits(quote.minOut, quote.decimals)}</dd>
              <dt>Owned on selected side</dt>
              <dd>{formatUnits(quote.owned, quote.decimals)}</dd>
              <dt>Status</dt>
              <dd>
                {
                  [
                    "OPEN",
                    "LOCKED",
                    "AWAITING ORACLE",
                    "PROPOSED",
                    "YES WINS",
                    "NO WINS",
                    "INVALID",
                  ][quote.state]
                }
              </dd>
            </dl>
            <button
              className="primary full"
              disabled={busy}
              onClick={() => void execute()}
            >
              {busy
                ? "AWAITING WALLET…"
                : quote.state >= 4
                  ? "REDEEM FINAL CLAIMS"
                  : `CONFIRM ${action} · ${side === 0 ? "YES" : "NO"}`}
            </button>
          </>
        )}
        {error && <p className="form-error">{error}</p>}
        <p className="ticket-disclosure">
          20 bps fee. 1% slippage tolerance. Two-minute deadline. No HSX
          participation burn. Your wallet authorizes each transaction.
        </p>
      </aside>
    </div>
  );
}
