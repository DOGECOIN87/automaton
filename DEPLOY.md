# DEPLOY.md — First-Deployment Runbook (Solana-only Automaton)

> **PREPARE ONLY.** Nothing here deploys, funds, or spends anything on its own.
> Every step below is a deliberate human action. Nothing is automated.

## 1. Prerequisites

- Docker Engine 24+ with the Compose plugin, **or** Node.js ≥ 20 + pnpm 10.28.1
  for a bare-metal install.
- A Solana wallet with a **small** amount of SOL for fees (see §4) — the
  automaton generates its own wallet; you fund it.
- An inference provider key (OpenAI, Anthropic, or a local Ollama) — the
  automaton's brain. At least one is required.
- A Conway API key for credits/inference accounting.
- **Matt's Helius API key** — ALL Solana chain traffic routes through Helius.
  Have it ready; it goes into `.env` (never into git).

## 2. Configure

```bash
cp .env.example .env
# Edit .env and fill in:
#   HELIUS_API_KEY=            <- paste YOUR Helius key here
#   OPENAI_API_KEY=            <- at least one inference key
#   CONWAY_API_KEY=
#   GUI_PORT=8787
```

How the RPC URL is resolved (`src/config.ts`, `getSolanaRpcUrl()`):

1. `HELIUS_API_KEY` set → `https://mainnet.helius-rpc.com/?api-key=<key>` (production)
2. else `SOLANA_RPC_URL` if set (dev override)
3. else `https://api.mainnet-beta.solana.com` (last-resort dev fallback)

Richer chain data (token metadata, holders, tx history) uses Helius surfaces
(`mainnet.helius-rpc.com` RPC, `api.helius.xyz` DAS API) via `src/solana/helius.ts`,
keyed exclusively through `HELIUS_API_KEY`. The raw key is never logged or committed.

## 3. Build

```bash
docker compose build        # builds runtime + React dashboard into one image
# bare metal instead:
pnpm install && pnpm build
```

`docker build` could not be verified on the build machine (no Docker there) —
**run `docker compose build` once on the deploy host and confirm it succeeds
before proceeding.**

## 4. First run — setup wizard (interactive)

```bash
docker compose run --rm automaton node dist/index.js --setup
```

The wizard walks through: agent name, inference provider/model, Solana RPC
(via Helius), commitment level, and **generates the automaton's Solana keypair**
(Ed25519). The keypair is written to `/data/wallet.json` inside the
`automaton-data` volume (mode 0600). It never leaves that volume unless you copy it.

**Back up `wallet.json` now** (before any funding):

```bash
docker run --rm -v automaton-data:/data alpine \
  sh -c 'cp /data/wallet.json /data/wallet.json.bak && chmod 600 /data/wallet.json.bak'
```

## 5. Fund the funding wallet (REQUIRED before any spawn)

This is the dedicated wallet Matt funds personally. Every spawned child agent
receives `CHILD_FUND_SOL` (default 0.005) SOL from it. **Spawning is refused**
until this wallet exists and holds enough for at least one child allocation.

**Funding wallet address (generated during deploy prep):**

```
BP1Umo5jLtpRgyYHzHgne7WJiLRmPYHpJ5tX1MUQjsEE
```

1. Send SOL to the address above — enough for the children you plan to spawn
   (e.g. 1 SOL ≈ 20 children at the default 0.05 allocation). A few dollars is
   plenty for the first run.
2. Confirm the balance: the setup wizard's step 7 shows the live balance, and
   the GUI Overview page has a prominent **Child funding wallet** banner
   (address + live balance + funded/INSUFFICIENT status).
3. Only proceed when the GUI shows **funded**. If a spawn is attempted while
   unfunded, the runtime refuses loudly (log line + `replication.spawn_refused`
   event, visible in the GUI Replication tab) — before any sandbox is created,
   so no Conway spend is wasted.

**Importing the keypair into the deployment** — the key lives in
`deploy/funding-wallet.json` (0600, gitignored, never committed). Two options:

- **File mount (default, docker-compose):** `./deploy/funding-wallet.json` is
  mounted read-only at `/app/deploy/funding-wallet.json`; set
  `FUNDING_WALLET_PATH=/app/deploy/funding-wallet.json` in `.env`.
- **Secret env var (hosted envs):** set
  `FUNDING_WALLET_SECRET='[1,2,3,...]'` (the secret-key JSON array) or the
  base58-encoded secret key. Takes precedence over the file.

⚠️ **Key-custody warning:** this keypair controls real SOL. It is used only to
sign child-funding transfers and never leaves the runtime process, but anyone
with the file or the env var can drain it. Keep `deploy/funding-wallet.json`
off git (already gitignored), back it up to encrypted storage, and never paste
it into chat, logs, or screenshots.

## 6. Fund the agent wallet (small amount only)

1. Get the address: `docker compose run --rm automaton node dist/index.js --status`
   (or read it from the GUI Overview page after starting).
2. Send a **small** amount of SOL (enough for fees + one USDC top-up test —
   a few dollars is plenty for the first run).
3. The automaton buys Conway credits itself via x402 USDC-SPL when it needs them
   (`topup_credits` tool / bootstrap top-up). Watch the first top-up in the GUI.

## 7. Start the runtime + GUI

```bash
docker compose up -d
```

- GUI dashboard: `http://<host>:8787` (or your `GUI_PORT`)
- Agent loop runs inside the container with `--run --gui`.

Verify health:

```bash
curl http://localhost:8787/health
docker compose logs -f automaton
```

In the dashboard, confirm: Overview shows the wallet address and SOL balance,
Agent Loop streams think→act→observe turns, Tools lists ~57 tools, Heartbeat
ticks on schedule.

Bare-metal equivalent:

```bash
node dist/index.js --run --gui --gui-port 8787
# dashboard only (no agent loop):
pnpm gui
```

## 8. Rollback

- **Stop everything:** `docker compose down` (the `automaton-data` volume with
  wallet + SQLite DB survives).
- **Full reset (DANGER — destroys wallet + state):**
  `docker compose down -v` — only do this if you have `wallet.json` backed up
  elsewhere and intend to start over.
- **Revert to a previous image:** rebuild from the tagged commit on branch
  `solana-only` (`git checkout <commit> && docker compose build`).

## 9. Key-custody & security notes

- The Solana keypair **is** the automaton's identity and its money. Anyone with
  `wallet.json` controls it. Volume backups are encrypted-at-rest only if your
  host disk is.
- Never commit `.env`, `wallet.json`, or any backup of it. `.gitignore` covers
  `.env` and `dist/`; the runtime keeps keys under `~/.automaton` (mode 0700)
  on bare metal.
- The **funding wallet** (`deploy/funding-wallet.json` / `FUNDING_WALLET_SECRET`)
  is a second key with real SOL on it: same rules — never committed (gitignored),
  backed up to encrypted storage only, never pasted into chat or screenshots.
  It only ever signs child-funding transfers, but possession = control.
- The dashboard (`/api/*`) has **no authentication** — bind it to localhost or
  put it behind a reverse proxy with auth before exposing it to a network.
- The Helius key in `.env` is a paid API credential: treat it like a password.
- First deployment should stay **small**: minimal SOL, default $5 credit top-up
  tier, and watch the GUI for a full day before increasing funding.
- `constitution.md` is immutable by repo law — the agent carries it into every
  child it spawns. Do not edit it.

## 10. Known limitations / documented stubs

- **x402 v2 Solana payload shape** (`payload.transaction` = base64 signed
  SPL-transfer tx) is a best-effort adaptation — no live facilitator existed to
  test against during development. Watch the first real 402 flow in the GUI
  Tools view and confirm settlement on Solscan before relying on it.
- **Attestation discovery** scans Memo-program signatures via RPC — correct but
  RPC-heavy compared to ERC-8004 enumeration. Fine for a first deployment;
  revisit if discovery becomes a hot path.
- Network-touching functions (`publishAttestation`, `discoverAttestations`,
  `signSolanaPayment`, `fundChildWallet`, `getUsdcBalance`) have no unit tests —
  they need a live RPC. Their pure cores (memo build/parse/verify, USDC amount
  parsing, ATA derivation) are covered offline.
