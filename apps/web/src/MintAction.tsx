import { useEffect, useState } from "react";
import { formatUnits, parseUnits } from "ethers";
import { mintNativeStrike } from "./nativeClient";
import { API_ENABLED } from "./dataMode";
export function MintAction({ amount }: { amount: string }) {
  const [supply, setSupply] = useState<string | null>(null),
    [quote, setQuote] = useState<{
      hsxIn: string;
      hypeIn: string;
      observedAt: number;
      deadline: number;
    } | null>(null),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!API_ENABLED) return;
    let active = true;
    setQuote(null);
    fetch("/v1/strike/stats")
      .then((r) => (r.ok ? r.json() : null))
      .then((s) => {
        if (active) setSupply(s?.totalSupply ?? null);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [amount]);
  const refresh = async () => {
    if (!API_ENABLED) return;
    setBusy(true);
    try {
      const r = await fetch(
          `/v1/strike/quote?amount=${parseUnits(amount, 18)}`,
        ),
        q = await r.json();
      if (!r.ok) throw Error(q.error);
      setQuote(q);
      setMessage("");
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Quote unavailable");
    } finally {
      setBusy(false);
    }
  };
  const mint = async () => {
    if (!quote) return;
    setBusy(true);
    try {
      const tx = await mintNativeStrike(
        parseUnits(amount, 18),
        (BigInt(quote.hsxIn) * 101n) / 100n,
        (BigInt(quote.hypeIn) * 101n) / 100n,
        quote.deadline,
      );
      setMessage(`STRIKE minted. Transaction ${tx}`);
      setQuote(null);
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Mint failed");
    } finally {
      setBusy(false);
    }
  };
  if (supply === null)
    return (
      <>
        <button className="primary full" disabled>
          {API_ENABLED
            ? "MINT UNAVAILABLE · ORACLE REQUIRED"
            : "MINT NOT ENABLED · STATIC DEMO"}
        </button>
        <small>
          Live minting requires a reviewed HSX/USD TWAP, independent reference,
          max-cost limits and a transaction deadline.
        </small>
      </>
    );
  return (
    <section>
      <p>Onchain outstanding: {formatUnits(supply, 18)} STRIKE</p>
      <button
        className="secondary full"
        onClick={() => void refresh()}
        disabled={busy}
      >
        GET LIVE INTEGRATED QUOTE
      </button>
      {quote && (
        <>
          <dl className="ticket-metrics">
            <dt>HSX burned</dt>
            <dd>{formatUnits(quote.hsxIn, 18)}</dd>
            <dt>HYPE contributed</dt>
            <dd>{formatUnits(quote.hypeIn, 18)}</dd>
            <dt>Reference timestamp</dt>
            <dd>{new Date(Number(quote.observedAt) * 1000).toISOString()}</dd>
            <dt>Maximum cost protection</dt>
            <dd>+1% on each input</dd>
          </dl>
          <button
            className="primary full"
            disabled={busy}
            onClick={() => void mint()}
          >
            CONFIRM MINT · {amount} STRIKE
          </button>
        </>
      )}
      {message && <p role="status">{message}</p>}
    </section>
  );
}
