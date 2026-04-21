# Aave Liquidity Backend

A 24×7 collector that snapshots Aave V3 reserves every 5 minutes and stores them as JSON files in a public GitHub repo (your repo = your database). Free, runs forever, no servers to manage. The terminal HTML hydrates from this on load so the chart is populated with historical data instantly.

## Why this design

- **Truly free**: GitHub Actions has unlimited minutes for public repos.
- **Truly permanent**: Git history *is* the audit trail. Every snapshot is a commit.
- **Truly accessible**: `raw.githubusercontent.com` serves your JSON with `Access-Control-Allow-Origin: *` headers, so the static HTML can fetch it from any browser.
- **No third-party services** beyond GitHub itself.

## Setup (5 minutes)

### 1. Create a repo
On GitHub, create a new **public** repository. Call it whatever you like (e.g. `aave-liquidity-data`). Public is required — private repos consume Actions minutes from your monthly free quota.

### 2. Push these files
Copy the contents of this `backend/` folder into the root of your new repo:

```
collect.js
package.json
.gitignore
.github/workflows/collect.yml
```

Commit and push to `main`. **Do not** create the `data/` folder yourself — the workflow creates it on first run.

### 3. Enable & trigger the workflow
1. Open your repo on GitHub → **Actions** tab.
2. If GitHub asks you to enable workflows, click **I understand my workflows, go ahead and enable them**.
3. In the left sidebar pick **Collect Aave Liquidity Snapshots**.
4. Click **Run workflow** → **Run workflow** to seed the first snapshot immediately.
5. Wait ~30s, then refresh the repo page. You'll see a new commit `data: snapshot 2026-…` and a `data/` folder.

After the seed run, the workflow runs automatically every 5 minutes, 24×7. No further action needed.

### 4. Connect the terminal
Open `aave-liquidity-terminal.html` in your browser. In the header, click the **BACKEND** pill and paste the raw URL prefix to your `data/` folder, e.g.:

```
https://raw.githubusercontent.com/YOUR_USERNAME/YOUR_REPO/main/data
```

The URL is saved in `localStorage` and used on every subsequent open. The terminal will hydrate up to 24 hours of history per chain on load and continue live polling on top.

> Power-tip: append the URL to the page hash and bookmark — `aave-liquidity-terminal.html#backend=https://raw.…/data` — so anyone you share it with gets the same backend automatically.

## Data format

`data/{chain}.json`:
```json
{
  "chain": "Ethereum",
  "lastUpdated": 1776513600000,
  "retentionDays": 7,
  "snapshotCount": 2016,
  "snapshots": [
    {
      "ts": 1776513600000,
      "ethPx": 3210.5,
      "btcPx": 65000,
      "reserves": [
        {
          "pool": "db678df9-3281-4bc2-a8bb-01160ffd6d48",
          "symbol": "WETH",
          "unit": "ETH",
          "supplyUsd": 1320000000,
          "borrowUsd": 410000000,
          "availUsd":  910000000,
          "supplyNative": 411211.05,
          "borrowNative": 127720.51,
          "availNative":  283490.54,
          "util": 31.06,
          "apyBase": 1.84,
          "apyBaseBorrow": 3.92,
          "ltv": 80,
          "borrowable": true,
          "collateral": true,
          "isolated": false
        }
      ]
    }
  ]
}
```

`data/index.json` is a small summary file across all chains — useful for sanity checks and dashboards.

## Tradeoffs

- **5-minute resolution**: GitHub's minimum cron is `*/5 * * * *`. Actual delivery often drifts to 10–15 min during peak hours. Aave's on-chain rates change per block (~12s on Ethereum), so 5-min sampling captures essentially all meaningful state changes.
- **Public data**: anyone can read your repo's JSON. The underlying data is already public on Aave/DefiLlama, so nothing sensitive is exposed.
- **Repo size**: snapshots roll off after 7 days; per-chain files stabilize at 1–3 MB each. With 10 chains, total `data/` directory ≈ 15–30 MB.

## Local testing

```bash
node collect.js
```

This writes (or appends to) `./data/`. Useful to verify the script before pushing.

## Want true 1-minute resolution?

GitHub's 5-min floor isn't enough for sub-minute tracking. If you need it, replace this backend with a Cloudflare Worker + D1 setup:

- Cloudflare Workers cron supports `* * * * *` (every minute)
- D1 free tier handles ~100K writes/day (you'll fit ~30 reserves × 1 chain at 1-min)
- Same data shape, same HTML — just point `BACKEND_URL` at `https://your-worker.workers.dev/history`

Ask Claude to scaffold the `cloudflare-worker/` variant when you're ready.

## Maintenance

- The `data/` folder grows with each commit but the *file size* stays bounded by `RETENTION_DAYS` (default 7). Adjust the constant in `collect.js` if you want a longer window.
- To prune git history if the repo gets large: `git filter-repo --path data/ --invert-paths` (off-line, one-time operation).
- To pause collection: disable the workflow under Actions → ⋯ → Disable workflow.
