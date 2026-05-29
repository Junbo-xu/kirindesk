# Audit Log Hash Chain Specification

## Overview

KirinDesk audit logs use a SHA-256 hash chain to detect tampering.
Each log entry's `row_hash` depends on the previous entry's hash,
forming an append-only chain per tenant (and one for platform operations).

## Hash Input Format

Fields are concatenated with `|` separator in this fixed order:

```
hash_version|prev_hash|tenant_id|actor_type|actor_id|action|resource_type|resource_id|before_json|after_json|metadata_json|request_id|ip_address|user_agent|reason|created_at
```

## Rules

- NULL fields serialize as empty string `""`
- JSON fields use canonical JSON (keys sorted alphabetically, no extra whitespace)
- `created_at` uses ISO 8601 UTC format (e.g. `2026-01-15T08:30:00.000Z`)
- `hash_version` is currently `1`
- First entry in a chain uses `prev_hash` = 64 zeros

## JSON Canonicalization

Keys sorted recursively. Arrays preserve order. No trailing commas.

Example: `{"b":2,"a":1}` becomes `{"a":1,"b":2}`

## Chain Structure

- Each tenant has its own chain: `tenant:{uuid}`
- Platform operations share one chain: `platform`
- `audit_log_chains` table tracks the head of each chain

## Concurrency Control

Writing to a chain requires:
1. BEGIN transaction
2. SELECT last_hash FROM audit_log_chains WHERE chain_key = $1 FOR UPDATE
3. Compute row_hash from prev_hash + fields
4. INSERT INTO audit_logs
5. UPDATE audit_log_chains SET last_hash, last_log_id
6. COMMIT

The FOR UPDATE lock serializes writes within the same chain.
Different chains do not block each other.

## Verification

Run: `pnpm db:verify-chain <chain_key>`

Verification reads all entries in a chain (ORDER BY id ASC) and:
1. Checks each entry's prev_hash matches the prior entry's row_hash
2. Recomputes row_hash and compares to stored value

## Limitations

- Hash chain does not prevent a database superuser from rewriting the entire chain
- It detects partial tampering (modifying one row breaks the chain)
- For stronger guarantees, periodic chain head snapshots could be stored externally
