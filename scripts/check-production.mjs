const required = [
  "HIP4_DEPLOYER_ADDRESS",
  "HIP4_TEMPLATE_ID",
  "HIP4_MARKET_ALLOWLIST",
  "HSX_BURN_GATE_MAINNET",
  "VITE_HSX_BURN_GATE_ADDRESS",
  "ORACLE_POLICY_ID",
  "DATABASE_URL",
  "REDIS_URL",
  "SENTRY_DSN_WEB",
];

const addressPattern = /^0x[a-fA-F0-9]{40}$/;
const errors = [];
for (const key of required) {
  if (!process.env[key]?.trim()) errors.push(`${key} is required`);
}
for (const key of ["HIP4_DEPLOYER_ADDRESS", "HSX_BURN_GATE_MAINNET", "VITE_HSX_BURN_GATE_ADDRESS"]) {
  if (process.env[key] && !addressPattern.test(process.env[key])) errors.push(`${key} must be a 20-byte 0x address`);
}
if (process.env.HSX_BURN_GATE_MAINNET && process.env.VITE_HSX_BURN_GATE_ADDRESS && process.env.HSX_BURN_GATE_MAINNET.toLowerCase() !== process.env.VITE_HSX_BURN_GATE_ADDRESS.toLowerCase()) {
  errors.push("HSX_BURN_GATE_MAINNET and VITE_HSX_BURN_GATE_ADDRESS must match");
}

const allowlist = (process.env.HIP4_MARKET_ALLOWLIST ?? "").split(",").map((value) => value.trim()).filter(Boolean);
if (allowlist.some((value) => !/^\d+$/.test(value))) errors.push("HIP4_MARKET_ALLOWLIST must contain comma-separated numeric outcome IDs");
if (allowlist.length !== 3) errors.push("HIP4_MARKET_ALLOWLIST must contain exactly the three approved launch outcomes");

const response = await fetch("https://api.hyperliquid.xyz/info", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ type: "outcomeMeta" }),
});
if (!response.ok) errors.push(`mainnet outcomeMeta returned HTTP ${response.status}`);
else {
  const metadata = await response.json();
  const liveIds = new Set(Array.isArray(metadata?.outcomes) ? metadata.outcomes.map((item) => String(item.outcome)) : []);
  for (const id of allowlist) if (!liveIds.has(id)) errors.push(`approved outcome ${id} is not discoverable on mainnet outcomeMeta`);
}

if (errors.length) {
  console.error("Production readiness check failed:\n" + errors.map((error) => `- ${error}`).join("\n"));
  process.exit(1);
}

console.log("Production readiness check passed: configuration is complete and all three approved HIP-4 outcomes are live on mainnet.");
