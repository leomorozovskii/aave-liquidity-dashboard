#!/usr/bin/env node
/* ════════════════════════════════════════════════════════
   AAVE LIQUIDITY COLLECTOR
   Pulls Aave V3 reserves from DefiLlama, computes native-unit
   liquidity per asset, appends to per-chain JSON files.
   Designed to run under GitHub Actions cron (every 5 min).
   ──────────────────────────────────────────────────────── */

import fs from 'node:fs/promises';
import path from 'node:path';

const CHAINS = [
  'Ethereum','Arbitrum','Optimism','Polygon','Base',
  'Avalanche','BSC','Gnosis','Scroll','Metis'
];
const RETENTION_DAYS = 7;       // keep last N days of snapshots
const DATA_DIR = 'data';

/* ─────────── Asset → unit categorisation ─────────── */

const STABLES = new Set([
  'USDC','USDT','DAI','FRAX','LUSD','GHO','TUSD','USDE','SUSDE','MIM','CRVUSD','PYUSD',
  'FDUSD','USDS','SDAI','USDC.E','USDT.E','DAI.E','BUSD','MAI','USDM','USDP','USDD',
  'USDX','RLUSD','USDB','USR','USDX.M','USD+','USDF','EURS','EURC','EURT','AGEUR','EURE'
]);
const ETH_LIKE = new Set([
  'ETH','WETH','STETH','WSTETH','RETH','CBETH','WEETH','ETHX','OSETH','METH','OETH',
  'SETH','FRXETH','SFRXETH','ANKRETH','SWETH','RSETH','EZETH','PUFETH','WEETHS','WEETH.E'
]);
const BTC_LIKE = new Set([
  'WBTC','TBTC','CBBTC','BTCB','LBTC','EBTC','BTC.B','BTC','SOLVBTC','RENBTC','MBTC',
  'UBTC','PUMPBTC','XBTC','BTC.E','WBTC.E'
]);

function categorise(symbol) {
  const s = String(symbol || '').toUpperCase().trim();
  if (STABLES.has(s)) return 'USD';
  if (ETH_LIKE.has(s)) return 'ETH';
  if (BTC_LIKE.has(s)) return 'BTC';
  if (/ETH$/.test(s)) return 'ETH';
  if (/BTC$/.test(s)) return 'BTC';
  if (/USD/.test(s) || /^E?EUR/.test(s)) return 'USD';
  return 'USD';
}

/* ─────────── HTTP helper with retry ─────────── */

async function jget(url, retries = 3) {
  for (let i = 0; i <= retries; i++) {
    try {
      const r = await fetch(url, {
        headers: { 'Accept': 'application/json', 'User-Agent': 'aave-liquidity-collector' }
      });
      if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
      return await r.json();
    } catch (e) {
      if (i === retries) throw new Error(`fetch failed for ${url}: ${e.message}`);
      await new Promise(r => setTimeout(r, 1500 * (i + 1)));
    }
  }
}

async function loadHistory(file) {
  try { return JSON.parse(await fs.readFile(file, 'utf-8')); }
  catch { return null; }
}

/* ─────────── Main ─────────── */

async function main() {
  console.log('▸ Fetching DefiLlama yields, lendBorrow, prices…');
  const [pools, lendBorrow, prices] = await Promise.all([
    jget('https://yields.llama.fi/pools'),
    jget('https://yields.llama.fi/lendBorrow'),
    jget('https://coins.llama.fi/prices/current/coingecko:ethereum,coingecko:bitcoin'),
  ]);

  const ethPx = prices?.coins?.['coingecko:ethereum']?.price || null;
  const btcPx = prices?.coins?.['coingecko:bitcoin']?.price  || null;
  const lbMap = new Map(lendBorrow.map(p => [p.pool, p]));
  const ts = Date.now();

  console.log(`▸ ETH=$${ethPx?.toFixed(2)}  BTC=$${btcPx?.toFixed(2)}  ts=${new Date(ts).toISOString()}`);
  await fs.mkdir(DATA_DIR, { recursive: true });

  const summary = {
    lastUpdated: ts,
    ethPx, btcPx,
    retentionDays: RETENTION_DAYS,
    chains: {}
  };

  for (const chain of CHAINS) {
    const reserves = (pools.data || []).filter(p => p.project === 'aave-v3' && p.chain === chain);
    if (!reserves.length) {
      summary.chains[chain] = { reserveCount: 0, snapshotCount: 0 };
      continue;
    }

    const snapshot = { ts, ethPx, btcPx, reserves: [] };

    for (const p of reserves) {
      const lb = lbMap.get(p.pool) || {};
      const supplyUsd = lb.totalSupplyUsd ?? p.tvlUsd ?? 0;
      const borrowUsd = lb.totalBorrowUsd ?? 0;
      const availUsd  = Math.max(supplyUsd - borrowUsd, 0);
      const util      = supplyUsd > 0 ? (borrowUsd / supplyUsd) * 100 : 0;
      let ltv = lb.ltv ?? 0;
      if (ltv > 0 && ltv < 1.5) ltv *= 100;

      const unit = categorise(p.symbol);
      const px   = unit === 'ETH' ? ethPx : unit === 'BTC' ? btcPx : 1;
      if (!px) continue;  // skip if reference price missing

      snapshot.reserves.push({
        pool: p.pool,
        symbol: p.symbol,
        unit,
        supplyUsd, borrowUsd, availUsd,
        supplyNative: supplyUsd / px,
        borrowNative: borrowUsd / px,
        availNative:  availUsd  / px,
        util,
        apyBase:       (p.apyBase ?? 0) + (p.apyReward ?? 0),
        apyBaseBorrow: (lb.apyBaseBorrow ?? 0) - (lb.apyRewardBorrow ?? 0),
        ltv,
        borrowable: !!lb.borrowable,
        collateral: ltv > 0,
        isolated:   !!(lb.debtCeilingUsd && lb.debtCeilingUsd > 0),
      });
    }

    // Append + retention prune
    const filePath = path.join(DATA_DIR, `${chain}.json`);
    const prev = await loadHistory(filePath);
    const cutoff = ts - RETENTION_DAYS * 86400 * 1000;
    const snapshots = (prev?.snapshots || []).filter(s => s.ts >= cutoff);
    snapshots.push(snapshot);

    await fs.writeFile(filePath, JSON.stringify({
      chain,
      lastUpdated: ts,
      retentionDays: RETENTION_DAYS,
      snapshotCount: snapshots.length,
      snapshots,
    }));

    summary.chains[chain] = {
      reserveCount: snapshot.reserves.length,
      snapshotCount: snapshots.length,
      sizeKb: Math.round(JSON.stringify(snapshots).length / 1024),
    };
    console.log(`  · ${chain.padEnd(10)} ${snapshot.reserves.length.toString().padStart(3)} reserves · ${snapshots.length.toString().padStart(4)} snapshots stored`);
  }

  await fs.writeFile(path.join(DATA_DIR, 'index.json'), JSON.stringify(summary, null, 2));
  console.log('▸ Done.');
}

main().catch(e => {
  console.error('FATAL:', e);
  process.exit(1);
});
