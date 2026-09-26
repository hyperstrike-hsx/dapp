# Index incident runbook

This repository is a pilot candidate, not a production approval. Never substitute demo prices when a provider or signer fails.

SEV-1: preserve payloads, replay inputs, signatures, receipts and the affected block range. Pause creation and affected trading. Record the affected canonical index and an immutable incident report hash. Remove compromised signer authority through the separately controlled oracle administration path. Existing final redemptions and accrued fee claims remain callable. Reproduce the disputed observation against independently committed inputs; publish a correction record, never update an observation.

SEV-2: publish degraded/unavailable status for an outage or delayed quorum. Alert immediately for unavailable indexes and source age >5 minutes. Refuse new slots below 90% confidence. Settlement requires 85%, full boundary coverage and at least three samples. Try ±5 minutes, then ±15 minutes with at most 15 minutes between valid observations. After 24 hours without a defensible value, propose INVALID and honor the challenge window.

Chain indexer: run against finalized blocks with independent RPC confirmation. A checkpoint hash mismatch halts indexing. Preserve the old database; rebuild a new audit read model from the deployment block after investigation. Do not delete or edit historical rows to hide the reorg.

Signature services: run the same replay implementation on three isolated hosts/accounts, each with its own raw source ingestion and a single key. Never put all signer keys in one process, container, CI secret group or deployment account. Only the broadcaster needs gas; oracle signers have no treasury authority.

Before resuming: replay bit-for-bit, verify active methodology, reconcile collateral/claims and fee balances, review the public incident report, and obtain the configured multisig/timelock authorization. No operator can type a replacement settlement price into the contracts.
