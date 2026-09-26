import { createServer, type IncomingMessage } from "node:http";
import {
  INDEXES,
  validateDefinition,
  type MarketDefinition,
} from "@hyperstrike/market-types";
import { quoteBuy, quoteSell } from "@hyperstrike/sdk";
import { openStore, stringify } from "./store";
import { opportunities } from "./opportunities";
import { getHsxChart } from "./hsx-chart";
import { createIndicativeFeed } from "./indicative";
export const db = openStore();
const indicativeFeed = createIndicativeFeed(db);
const now = () => Math.floor(Date.now() / 1000);
const parse = (row: unknown) =>
  row ? JSON.parse((row as { data: string }).data) : null;
function latest(id: string) {
  return parse(
    db
      .prepare(
        "SELECT data FROM index_observations WHERE index_id=? AND provenance='CANONICAL' ORDER BY observed_at DESC LIMIT 1",
      )
      .get(id),
  );
}
async function body(req: IncomingMessage) {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 16384) throw new Error("Body too large");
  }
  return JSON.parse(raw);
}
function exactKeys(value: Record<string, unknown>, keys: string[]) {
  if (Object.keys(value).some((k) => !keys.includes(k)))
    throw new Error(
      "Unsupported field: market APIs accept index definitions only",
    );
}
function readDefinition(value: Record<string, unknown>): MarketDefinition {
  exactKeys(value, [
    "template",
    "indexId",
    "direction",
    "thresholdE8",
    "creationReferenceTime",
    "creationReferenceValueE8",
    "tradeCloseTime",
    "resolutionTime",
    "settlementPolicyId",
  ]);
  return {
    ...value,
    thresholdE8: BigInt(String(value.thresholdE8)),
    creationReferenceValueE8: BigInt(String(value.creationReferenceValueE8)),
  } as MarketDefinition;
}
export const server = createServer(async (req, res) => {
  res.setHeader("Content-Type", "application/json");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Cache-Control", "no-store");
  try {
    const url = new URL(req.url ?? "/", "http://localhost"),
      parts = url.pathname.split("/").filter(Boolean);
    let result: unknown;
    if (req.method === "GET" && url.pathname === "/metrics") {
      res.setHeader("Content-Type", "text/plain; version=0.0.4");
      const lines = INDEXES.flatMap((i) => {
        const o = latest(i.indexId);
        return [
          `hyperstrike_index_available{index="${i.ticker}"} ${o && now() - o.observedAt <= 390 ? 1 : 0}`,
          `hyperstrike_publication_latency_seconds{index="${i.ticker}"} ${o ? Math.max(0, now() - o.observedAt - 300) : 1e9}`,
          `hyperstrike_oracle_signatures{index="${i.ticker}"} ${o?.signatureCount ?? 0}`,
        ];
      });
      const providers = db
        .prepare(
          "SELECT provider_id,MAX(observed_at) AS observed_at FROM venue_observations GROUP BY provider_id",
        )
        .all();
      for (const p of providers)
        lines.push(
          `hyperstrike_source_age_seconds{provider="${String(p.provider_id).replace(/[^a-zA-Z0-9_-]/g, "_")}"} ${Math.max(0, now() - Number(p.observed_at) / 1000)}`,
        );
      const snapshot = db
        .prepare(
          "SELECT data FROM audit_events WHERE kind='COLLATERAL_SNAPSHOT' ORDER BY id DESC LIMIT 1",
        )
        .get();
      if (snapshot)
        for (const m of JSON.parse(String(snapshot.data)))
          lines.push(
            `hyperstrike_collateral_surplus{market="${m.address}"} ${m.surplus}`,
          );
      const finalMarkets = new Set(
        db
          .prepare("SELECT data FROM chain_events WHERE kind='Finalized'")
          .all()
          .map((r) => String(parse(r).market).toLowerCase()),
      );
      for (const row of db
        .prepare("SELECT market_id,data FROM markets")
        .all()) {
        const market = parse(row),
          address = String(row.market_id);
        const delay = finalMarkets.has(address.toLowerCase())
          ? 0
          : Math.max(0, now() - market.definition.resolutionTime);
        lines.push(
          `hyperstrike_resolution_delay_seconds{market="${address.replace(/[^a-zA-Z0-9]/g, "")}"} ${delay}`,
        );
      }
      res.end(lines.join("\n") + "\n");
      return;
    } else if (req.method === "GET" && url.pathname === "/v1/hsx/ohlcv") {
      result = await getHsxChart();
    } else if (
      req.method === "GET" &&
      url.pathname === "/v1/indicative/indexes"
    ) {
      result = await indicativeFeed();
    } else if (req.method === "GET" && url.pathname === "/v1/indexes")
      result = INDEXES.map((i) => ({
        ...i,
        latest: latest(i.indexId),
        status: latest(i.indexId)
          ? now() - latest(i.indexId).observedAt <= 390
            ? latest(i.indexId).status
            : "UNAVAILABLE"
          : "UNAVAILABLE",
      }));
    else if (req.method === "GET" && parts[1] === "indexes" && parts[2]) {
      const index = INDEXES.find(
        (i) => i.indexId === parts[2] || i.ticker === parts[2],
      );
      if (!index) {
        res.statusCode = 404;
        result = { error: "Unknown canonical index" };
      } else if (parts[3] === "latest") result = latest(index.indexId);
      else if (parts[3] === "history")
        result = db
          .prepare(
            "SELECT data,provenance FROM index_observations WHERE index_id=? ORDER BY observed_at DESC LIMIT 8640",
          )
          .all(index.indexId)
          .map((r) => ({ ...parse(r), provenance: r.provenance }))
          .reverse();
      else if (parts[3] === "contributions") {
        const observation = latest(index.indexId);
        const replay = observation
          ? db
              .prepare(
                "SELECT output FROM replay_records WHERE index_id=? AND observed_at=?",
              )
              .get(index.indexId, observation.observedAt)
          : null;
        if (!replay) {
          res.statusCode = 503;
          result = {
            status: "UNAVAILABLE",
            reason: "No replay record for latest canonical observation",
          };
        } else
          result = {
            observedAt: observation.observedAt,
            ...JSON.parse(String(replay.output)).index,
          };
      } else if (parts[3] === "composition" || parts[3] === "methodology") {
        result = parse(
          db
            .prepare(
              "SELECT data FROM index_versions WHERE index_id=? AND activates_at<=? ORDER BY activates_at DESC LIMIT 1",
            )
            .get(index.indexId, now()),
        );
        if (!result) {
          res.statusCode = 503;
          result = {
            status: "UNAVAILABLE",
            reason:
              "Approved composition and source history have not been published",
          };
        }
      } else result = { ...index, latest: latest(index.indexId) };
    } else if (req.method === "GET" && url.pathname === "/v1/oracle/status")
      result = {
        status: INDEXES.every((i) => {
          const r = latest(i.indexId);
          return r && now() - r.observedAt < 390 && r.confidenceBps >= 8500;
        })
          ? "HEALTHY"
          : "UNAVAILABLE",
        quorum: "2 of 3",
        rail: "NATIVE",
        indexes: INDEXES.map((i) => ({
          ticker: i.ticker,
          latest: latest(i.indexId),
        })),
        deploymentConfigured: !!process.env.HS_FACTORY_ADDRESS,
      };
    else if (req.method === "GET" && parts[1] === "opportunities") {
      const existing = new Set(
        db
          .prepare("SELECT market_key FROM markets")
          .all()
          .map((r) => String(r.market_key)),
      );
      const rows = INDEXES.flatMap((i) => {
        const r = latest(i.indexId);
        return r ? opportunities(i.indexId, r, now(), existing) : [];
      });
      result = parts[2] ? (rows.find((r) => r.id === parts[2]) ?? null) : rows;
    } else if (req.method === "GET" && parts[1] === "markets") {
      if (!parts[2])
        result = db.prepare("SELECT data FROM markets").all().map(parse);
      else if (!parts[3])
        result = parse(
          db
            .prepare("SELECT data FROM markets WHERE market_id=?")
            .get(parts[2]),
        );
      else if (["trades", "resolution"].includes(parts[3]))
        result = db
          .prepare(
            "SELECT data FROM chain_events WHERE kind=? ORDER BY block_number DESC LIMIT 1000",
          )
          .all(parts[3] === "trades" ? "Traded" : "Finalized")
          .map(parse)
          .filter((r) => r.market === parts[2]);
      else {
        res.statusCode = 404;
        result = { error: "Unknown market route" };
      }
    } else if (
      req.method === "POST" &&
      url.pathname === "/v1/markets/prepare"
    ) {
      const data = await body(req);
      exactKeys(data, ["definition", "initialLiquidity"]);
      const d = readDefinition(data.definition),
        ref = latest(d.indexId);
      if (!ref) throw new Error("No signed canonical reference available");
      validateDefinition(d, now(), { ...ref, valueE8: BigInt(ref.valueE8) });
      if (!process.env.HS_FACTORY_ADDRESS) {
        res.statusCode = 503;
        result = { error: "Native deployment unavailable" };
      } else
        result = {
          chainId: 999,
          to: process.env.HS_FACTORY_ADDRESS,
          definition: d,
          initialLiquidity: data.initialLiquidity,
          requiresWalletConfirmation: true,
        };
    } else if (req.method === "POST" && url.pathname === "/v1/markets/quote") {
      const data = await body(req);
      exactKeys(data, ["marketId", "side", "action", "amount"]);
      if (
        !["YES", "NO"].includes(data.side) ||
        !["BUY", "SELL"].includes(data.action)
      )
        throw new Error("Invalid trade");
      const market = parse(
        db
          .prepare("SELECT data FROM markets WHERE market_id=?")
          .get(data.marketId),
      );
      // Chain reserves must be fetched at quote time, never accept user-supplied reserves.
      if (!market || !process.env.HS_RPC_URL) {
        res.statusCode = 503;
        result = { error: "Market chain state unavailable" };
      } else {
        const { Contract, JsonRpcProvider } = await import("ethers");
        const provider = new JsonRpcProvider(process.env.HS_RPC_URL, 999);
        const c = new Contract(
          data.marketId,
          [
            "function reserve(uint256) view returns(uint256)",
            "function state() view returns(uint8)",
          ],
          provider,
        );
        const [yes, no, state] = await Promise.all([
          c.reserve(0),
          c.reserve(1),
          c.state(),
        ]);
        if (Number(state) !== 0) throw new Error("Market is locked");
        result = {
          ...(data.action === "BUY"
            ? quoteBuy(yes, no, data.side, BigInt(data.amount))
            : quoteSell(yes, no, data.side, BigInt(data.amount))),
          deadline: now() + 120,
        };
        provider.destroy();
      }
    } else if (req.method === "GET" && url.pathname === "/v1/strike/quote") {
      // Quotes are unavailable until the safe onchain oracle and minter exist.
      if (!process.env.HS_MINTER_ADDRESS || !process.env.HS_RPC_URL) {
        res.statusCode = 503;
        result = {
          error:
            "STRIKE minting unavailable: safe HSX/USD oracle not configured",
        };
      } else {
        const { Contract, JsonRpcProvider } = await import("ethers");
        const p = new JsonRpcProvider(process.env.HS_RPC_URL, 999);
        const c = new Contract(
          process.env.HS_MINTER_ADDRESS,
          ["function quote(uint256) view returns(uint256,uint256,uint64)"],
          p,
        );
        const amount = BigInt(url.searchParams.get("amount") ?? "0");
        const q = await c.quote(amount);
        result = {
          amount,
          hsxIn: q[0],
          hypeIn: q[1],
          observedAt: q[2],
          deadline: now() + 120,
        };
        p.destroy();
      }
    } else if (
      req.method === "GET" &&
      ["/v1/strike/stats", "/v1/hsx/stats"].includes(url.pathname)
    ) {
      const strike = parts[1] === "strike";
      const address = strike
        ? process.env.HS_STRIKE_ADDRESS
        : "0xab5dbc5a6070d066697d8e55471877ea4343ece3";
      if (!address || !process.env.HS_RPC_URL) {
        res.statusCode = 503;
        result = {
          status: "UNAVAILABLE",
          reason: "Token RPC/deployment not configured",
        };
      } else {
        const { Contract, JsonRpcProvider } = await import("ethers");
        const p = new JsonRpcProvider(process.env.HS_RPC_URL);
        if ((await p.getNetwork()).chainId !== 999n)
          throw Error("Wrong network");
        const c = new Contract(
          address,
          [
            "function totalSupply() view returns(uint256)",
            "function decimals() view returns(uint8)",
          ],
          p,
        );
        result = {
          status: "AVAILABLE",
          chainId: 999,
          address,
          totalSupply: await c.totalSupply(),
          decimals: Number(await c.decimals()),
          observedAt: now(),
        };
        p.destroy();
      }
    } else {
      res.statusCode = 404;
      result = { error: "Not found" };
    }
    res.end(stringify(result));
  } catch (error) {
    res.statusCode = 400;
    res.end(
      stringify({
        error: error instanceof Error ? error.message : "Invalid request",
      }),
    );
  }
});
if (process.env.NODE_ENV !== "test")
  server.listen(
    Number(process.env.PORT ?? 8787),
    process.env.HOST ?? "127.0.0.1",
    () => console.log("HyperStrike API listening on :8787"),
  );
