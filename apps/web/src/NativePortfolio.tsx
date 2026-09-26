import { useState } from "react";
import { Contract, formatUnits } from "ethers";
import { nativeConfig, readNativeMarket, signer } from "./nativeClient";
import type { NativeRecord } from "./NativeTicket";

type Holding = {
  record: NativeRecord;
  yes: string;
  no: string;
  state: number;
  creator: boolean;
  pool: string;
};
export function NativePortfolio({
  records,
  onSelect,
  onNotice,
  creatorOnly = false,
}: {
  records: NativeRecord[];
  onSelect: (r: NativeRecord) => void;
  onNotice: (s: string) => void;
  creatorOnly?: boolean;
}) {
  const [holdings, setHoldings] = useState<Holding[]>([]),
    [loaded, setLoaded] = useState(false),
    [busy, setBusy] = useState(false);
  const [fees, setFees] = useState(""),
    [account, setAccount] = useState("");
  const refresh = async () => {
    setBusy(true);
    try {
      const s = await signer(),
        address = await s.getAddress();
      setAccount(address);
      const rows: Holding[] = [];
      for (const record of records) {
        const { market, decimals, state } = await readNativeMarket(
          record.address,
          record.definition,
        );
        const [yes, no, creator, pool] = await Promise.all([
          market.balanceOf(address, 0),
          market.balanceOf(address, 1),
          market.creator(),
          market.lockedCollateral(),
        ]);
        const owned = creator.toLowerCase() === address.toLowerCase();
        if (
          (creatorOnly && owned) ||
          (!creatorOnly && (yes > 0n || no > 0n || owned))
        )
          rows.push({
            record,
            yes: formatUnits(yes, decimals),
            no: formatUnits(no, decimals),
            state,
            creator: owned,
            pool: formatUnits(pool, decimals),
          });
      }
      setHoldings(rows);
      setLoaded(true);
      if (nativeConfig.feeVault && nativeConfig.collateral) {
        const vault = new Contract(
          nativeConfig.feeVault,
          [
            "function accrued(address) view returns(uint256)",
            "function collateral() view returns(address)",
          ],
          s,
        );
        if (
          (await vault.collateral()).toLowerCase() !==
          nativeConfig.collateral.toLowerCase()
        )
          throw Error("Fee vault collateral mismatch");
        const token = new Contract(
          nativeConfig.collateral,
          [
            "function decimals() view returns(uint8)",
            "function symbol() view returns(string)",
          ],
          s,
        );
        setFees(
          `${formatUnits(await vault.accrued(address), Number(await token.decimals()))} ${await token.symbol()}`,
        );
      }
    } catch (e) {
      onNotice(e instanceof Error ? e.message : "Chain state unavailable");
    } finally {
      setBusy(false);
    }
  };
  const claim = async (record?: NativeRecord) => {
    setBusy(true);
    try {
      const s = await signer();
      if ((await s.getAddress()) !== account)
        throw Error("Wallet changed. Refresh your positions.");
      if (record) await readNativeMarket(record.address, record.definition);
      const address = record?.address ?? nativeConfig.feeVault;
      if (!address) throw Error("Fee vault unavailable");
      const c = new Contract(
        address,
        [
          record
            ? "function redeemPool() returns(uint256)"
            : "function claim()",
        ],
        s,
      );
      const tx = await c[record ? "redeemPool" : "claim"]();
      await tx.wait();
      onNotice(`Confirmed on HyperEVM: ${tx.hash}`);
      await refresh();
    } catch (e) {
      onNotice(e instanceof Error ? e.message : "Claim failed");
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="activity-feed onchain-portfolio">
      <span className="overline">HYPEREVM / USDC</span>
      <h3>
        {creatorOnly ? "Your native markets & fees" : "Onchain positions"}
      </h3>
      <p>
        Verified factory markets only. Separate from the browser-local paper
        ledger.
      </p>
      <button
        className="primary"
        disabled={busy || !nativeConfig.factory}
        onClick={refresh}
      >
        {busy ? "READING CHAIN…" : "CONNECT & REFRESH POSITIONS"}
      </button>
      {!nativeConfig.factory && (
        <p className="chain-unavailable">
          Live portfolio is not available yet. Paper positions and sports
          receipts are accessible in their own tabs; no wallet connection is
          required.
        </p>
      )}
      {loaded && !holdings.length && (
        <p>
          No positions found among indexed native markets for{" "}
          {account.slice(0, 8)}…
        </p>
      )}
      {holdings.map((h) => (
        <div key={h.record.address} className="native-holding">
          <strong>{h.record.question}</strong>
          <span>
            YES {h.yes} · NO {h.no}
          </span>
          <span>
            {
              [
                "OPEN",
                "LOCKED",
                "AWAITING ORACLE",
                "PROPOSED",
                "RESOLVED YES",
                "RESOLVED NO",
                "INVALID",
              ][h.state]
            }
          </span>
          <button onClick={() => onSelect(h.record)}>MANAGE / REDEEM ↗</button>
          {h.creator && h.state >= 4 && Number(h.pool) > 0 && (
            <button disabled={busy} onClick={() => claim(h.record)}>
              REDEEM CREATOR POOL
            </button>
          )}
        </div>
      ))}
      {fees && (
        <div>
          <span>Accrued creator / treasury fees: {fees}</span>
          <button disabled={busy} onClick={() => claim()}>
            CLAIM FEES
          </button>
        </div>
      )}
    </section>
  );
}
