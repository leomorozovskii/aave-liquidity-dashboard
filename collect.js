#!/usr/bin/env node
/* ════════════════════════════════════════════════════════════════
   AAVE V3 LIQUIDITY COLLECTOR — ON-CHAIN EDITION

   Reads directly from Aave's AaveProtocolDataProvider on each chain
   (same contract app.aave.com uses). This is authoritative: DefiLlama's
   aggregated yields API was off by 10–400× on some reserves (notably
   DAI and USDe on Ethereum), because it caches and derives instead of
   reading the pool state at the latest block.

   Pipeline per chain:
     1. getAllReservesTokens()         → [{symbol, address}]
     2. multicall([
          getReserveData(asset),
          getReserveConfigurationData(asset),
        ])
     3. fetch USD prices (DefiLlama coins batched) for portfolio totals
     4. categorise + emit snapshot

   Output shape is backwards-compatible with the HTML terminal.
   Runs under GitHub Actions cron every 5 minutes.
   ──────────────────────────────────────────────────────────────── */

import fs from 'node:fs/promises';
import path from 'node:path';
import { createPublicClient, http, formatUnits } from 'viem';
import * as viemChains from 'viem/chains';

/* ───────────────────── Chain config ───────────────────── */

const CHAIN_CFG = {
  Ethereum:  { viem: viemChains.mainnet,   rpc: 'https://ethereum-rpc.publicnode.com',          dp: '0x497a1994c46d4f6C864904A9f1fac6328Cb7C8a6', llamaSlug: 'ethereum'  },
  Arbitrum:  { viem: viemChains.arbitrum,  rpc: 'https://arbitrum-one-rpc.publicnode.com',      dp: '0x7F23D86Ee20D869112572136221e173428DD740B', llamaSlug: 'arbitrum'  },
  Optimism:  { viem: viemChains.optimism,  rpc: 'https://optimism-rpc.publicnode.com',          dp: '0x7F23D86Ee20D869112572136221e173428DD740B', llamaSlug: 'optimism'  },
  Polygon:   { viem: viemChains.polygon,   rpc: 'https://polygon-bor-rpc.publicnode.com',       dp: '0x7F23D86Ee20D869112572136221e173428DD740B', llamaSlug: 'polygon'   },
  Base:      { viem: viemChains.base,      rpc: 'https://base-rpc.publicnode.com',              dp: '0xd82a47fdebB5bf5329b09441C3DaB4b5df2153Ad', llamaSlug: 'base'      },
  Avalanche: { viem: viemChains.avalanche, rpc: 'https://avalanche-c-chain-rpc.publicnode.com', dp: '0x50ddd0Cd4266299527d25De9CBb55fE0EB8dAc30', llamaSlug: 'avax'      },
  BSC:       { viem: viemChains.bsc,       rpc: 'https://bsc-rpc.publicnode.com',               dp: '0x23dF2a19384231aFD114b036C14b6b03324D79BC', llamaSlug: 'bsc'       },
  Gnosis:    { viem: viemChains.gnosis,    rpc: 'https://gnosis-rpc.publicnode.com',            dp: '0x501B4c19dd9C2e06E94dA7b6D5Ed4ddA013EC741', llamaSlug: 'xdai'      },
  Scroll:    { viem: viemChains.scroll,    rpc: 'https://scroll-rpc.publicnode.com',            dp: '0xe2108b60623C6Dcf7bBd535bD15a451fd0811f7b', llamaSlug: 'scroll'    },
  Metis:     { viem: viemChains.metis,     rpc: 'https://metis-rpc.publicnode.com',             dp: '0x99411FC17Ad1B56f49719E3850B2CDcc0f9bBFd8', llamaSlug: 'metis'     },
};

const RETENTION_DAYS = 7;
const DATA_DIR = 'data';
const RAY = 10n ** 27n;
const SECONDS_PER_YEAR = 31_536_000;

/* ───────────────────── Aave V3 ABI ───────────────────── */

const DP_ABI = [
  {
    inputs: [],
    name: 'getAllReservesTokens',
    outputs: [{
      components: [
        { name: 'symbol', type: 'string' },
        { name: 'tokenAddress', type: 'address' },
      ],
      name: '',
      type: 'tuple[]',
    }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [{ name: 'asset', type: 'address' }],
    name: 'getReserveData',
    outputs: [
      { name: 'unbacked', type: 'uint256' },
      { name: 'accruedToTreasuryScaled', type: 'uint256' },
      { name: 'totalAToken', type: 'uint256' },
      { name: 'totalStableDebt', type: 'uint256' },
      { name: 'totalVariableDebt', type: 'uint256' },
      { name: 'liquidityRate', type: 'uint256' },
      { name: 'variableBorrowRate', type: 'uint256' },
      { name: 'stableBorrowRate', type: 'uint256' },
      { name: 'averageStableBorrowRate', type: 'uint256' },
      { name: 'liquidityIndex', type: 'uint256' },
      { name: 'variableBorrowIndex', type: 'uint256' },
      { name: 'lastUpdateTimestamp', type: 'uint40' },
    ],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [{ name: 'asset', type: 'address' }],
    name: 'getReserveConfigurationData',
    outputs: [
      { name: 'decimals', type: 'uint256' },
      { name: 'ltv', type: 'uint256' },
      { name: 'liquidationThreshold', type: 'uint256' },
      { name: 'liquidationBonus', type: 'uint256' },
      { name: 'reserveFactor', type: 'uint256' },
      { name: 'usageAsCollateralEnabled', type: 'bool' },
      { name: 'borrowingEnabled', type: 'bool' },
      { name: 'stableBorrowRateEnabled', type: 'bool' },
      { name: 'isActive', type: 'bool' },
      { name: 'isFrozen', type: 'bool' },
    ],
    stateMutability: 'view',
    type: 'function',
  },
];

/* ───────────────────── Categorisation ───────────────────── */

const STABLES = new Set([
  'USDC','USDT','DAI','FRAX','LUSD','GHO','TUSD','USDE','SUSDE','MIM','CRVUSD','PYUSD',
  'FDUSD','USDS','SDAI','USDC.E','USDT.E','DAI.E','BUSD','MAI','USDM','USDP','USDD',
  'USDX','RLUSD','USDB','USR','USDX.M','USD+','USDF','EURS','EURC','EURT','AGEUR','EURE',
  'M.DAI','M.USDC','M.USDT', // Metis-prefixed stables
  'USDBC','USDC.E',
]);
const ETH_LIKE = new Set([
  'ETH','WETH','STETH','WSTETH','RETH','CBETH','WEETH','ETHX','OSETH','METH','OETH',
  'SETH','FRXETH','SFRXETH','ANKRETH','SWETH','RSETH','EZETH','PUFETH','WEETHS','WEETH.E','TETH',
]);
const BTC_LIKE = new Set([
  'WBTC','TBTC','CBBTC','BTCB','LBTC','EBTC','BTC.B','BTC','SOLVBTC','RENBTC','MBTC',
  'UBTC','PUMPBTC','XBTC','BTC.E','WBTC.E',
]);
function categorise(symbol) {
  const s = String(symbol || '').toUpperCase().trim();
  if (STABLES.has(s)) return 'USD';
  if (ETH_LIKE.has(s)) return 'ETH';
  if (BTC_LIKE.has(s)) return 'BTC';
  if (/ETH$/.test(s)) return 'ETH';
  if (/BTC$/.test(s)) return 'BTC';
  if (/USD|EUR/.test(s)) return 'USD';
  return 'USD';
}

/* ───────────────────── Helpers ───────────────────── */

function rateToApy(rateRay /* bigint */) {
  if (!rateRay || rateRay === 0n) return 0;
  const rate = Number(rateRay) / 1e27; // nominal APR as decimal (per-year)
  if (!isFinite(rate)) return 0;
  // Aave compounds per-second:  APY = (1 + rate/Y)^Y − 1
  const apy = Math.pow(1 + rate / SECONDS_PER_YEAR, SECONDS_PER_YEAR) - 1;
  return apy * 100;
}

async function jget(url, retries = 3) {
  for (let i = 0; i <= retries; i++) {
    try {
      const r = await fetch(url, {
        headers: { Accept: 'application/json', 'User-Agent': 'aave-liquidity-collector' },
      });
      if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
      return await r.json();
    } catch (e) {
      if (i === retries) throw new Error(`fetch failed: ${url} — ${e.message}`);
      await new Promise(r => setTimeout(r, 1200 * (i + 1)));
    }
  }
}

async function loadHistory(file) {
  try { return JSON.parse(await fs.readFile(file, 'utf-8')); }
  catch { return null; }
}

/* ───────────────────── Per-chain collection ───────────────────── */

async function collectChain(chainName, cfg, ts) {
  const client = createPublicClient({
    chain: cfg.viem,
    transport: http(cfg.rpc, { timeout: 15000, retryCount: 2, retryDelay: 400 }),
    batch: { multicall: true },
  });

  const tokens = await client.readContract({
    address: cfg.dp,
    abi: DP_ABI,
    functionName: 'getAllReservesTokens',
  });

  if (!tokens.length) return { chain: chainName, reserves: [], raw: [] };

  // Build multicall for every reserve: getReserveData + getReserveConfigurationData
  const calls = [];
  for (const t of tokens) {
    calls.push({
      address: cfg.dp,
      abi: DP_ABI,
      functionName: 'getReserveData',
      args: [t.tokenAddress],
    });
    calls.push({
      address: cfg.dp,
      abi: DP_ABI,
      functionName: 'getReserveConfigurationData',
      args: [t.tokenAddress],
    });
  }

  const results = await client.multicall({ contracts: calls, allowFailure: true });

  const reserves = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    const rd = results[i * 2];
    const rc = results[i * 2 + 1];
    if (rd.status !== 'success' || rc.status !== 'success') continue;

    const [, , totalAToken, totalStableDebt, totalVariableDebt,
           liquidityRate, variableBorrowRate] = rd.result;
    const [decimals, ltvBps, , , reserveFactorBps,
           usageAsCollateralEnabled, borrowingEnabled, , isActive, isFrozen] = rc.result;

    if (!isActive) continue;

    const totalDebt = totalStableDebt + totalVariableDebt;
    const available = totalAToken > totalDebt ? totalAToken - totalDebt : 0n;
    const dec = Number(decimals);
    const supplyN = Number(formatUnits(totalAToken, dec));
    const borrowN = Number(formatUnits(totalDebt,   dec));
    const availN  = Number(formatUnits(available,   dec));
    const util = supplyN > 0 ? (borrowN / supplyN) * 100 : 0;

    const addr = t.tokenAddress.toLowerCase();
    reserves.push({
      // Stable identifier: the underlying token address on this chain.
      // Frontend keys its per-reserve history off `pool`, so this must be unique.
      pool: addr,
      address: addr,
      symbol: t.symbol,
      decimals: dec,
      unit: categorise(t.symbol),
      supplyNative: supplyN,
      borrowNative: borrowN,
      availNative:  availN,
      util,
      apyBase:       rateToApy(liquidityRate),
      apyBaseBorrow: rateToApy(variableBorrowRate),
      ltv: Number(ltvBps) / 100,                    // bps → %
      reserveFactor: Number(reserveFactorBps) / 100,
      borrowable: !!borrowingEnabled,
      collateral: !!usageAsCollateralEnabled,
      isolated: false, // not derivable from ProtocolDataProvider alone; left as default
      isFrozen: !!isFrozen,
    });
  }
  return { chain: chainName, reserves };
}

/* ───────────────────── Price enrichment ───────────────────── */

async function enrichWithUsd(allChains) {
  // Collect every (llamaSlug, address) pair
  const keys = [];
  for (const { chain, reserves } of allChains) {
    const cfg = CHAIN_CFG[chain];
    for (const r of reserves) keys.push(`${cfg.llamaSlug}:${r.address}`);
  }
  // Always grab ETH + BTC reference (used when per-token fails)
  keys.push('coingecko:ethereum', 'coingecko:bitcoin');

  // DefiLlama caps URL length; chunk into groups of ~75
  const priceMap = new Map();
  for (let i = 0; i < keys.length; i += 75) {
    const slice = keys.slice(i, i + 75).join(',');
    try {
      const r = await jget(`https://coins.llama.fi/prices/current/${slice}`);
      for (const [k, v] of Object.entries(r.coins || {})) {
        if (typeof v?.price === 'number') priceMap.set(k, v.price);
      }
    } catch (e) {
      console.error(`  ! price chunk ${i} failed: ${e.message}`);
    }
  }

  const ethPx = priceMap.get('coingecko:ethereum') ?? null;
  const btcPx = priceMap.get('coingecko:bitcoin')  ?? null;

  for (const { chain, reserves } of allChains) {
    const cfg = CHAIN_CFG[chain];
    for (const r of reserves) {
      // Preferred: per-token spot price from DefiLlama coins
      const direct = priceMap.get(`${cfg.llamaSlug}:${r.address}`);
      let px;
      if (direct && direct > 0) {
        px = direct;
      } else if (r.unit === 'ETH' && ethPx) {
        px = ethPx;
      } else if (r.unit === 'BTC' && btcPx) {
        px = btcPx;
      } else if (r.unit === 'USD') {
        px = 1;
      } else {
        px = 0; // unknown — USD fields stay 0, native units still valid
      }
      r.priceUsd  = px;
      r.supplyUsd = r.supplyNative * px;
      r.borrowUsd = r.borrowNative * px;
      r.availUsd  = r.availNative  * px;
    }
  }
  return { ethPx, btcPx };
}

/* ───────────────────── Main ───────────────────── */

async function main() {
  const ts = Date.now();
  console.log(`▸ Collecting Aave V3 on-chain at ${new Date(ts).toISOString()}`);
  console.log(`▸ Chains: ${Object.keys(CHAIN_CFG).join(', ')}`);

  // Parallel fetch all chains
  const results = await Promise.allSettled(
    Object.entries(CHAIN_CFG).map(async ([name, cfg]) => {
      const t0 = Date.now();
      const out = await collectChain(name, cfg, ts);
      console.log(`  · ${name.padEnd(10)} ${out.reserves.length.toString().padStart(3)} active reserves · ${Date.now() - t0}ms`);
      return out;
    })
  );

  const ok = [];
  for (let i = 0; i < results.length; i++) {
    const chainName = Object.keys(CHAIN_CFG)[i];
    const r = results[i];
    if (r.status === 'fulfilled') ok.push(r.value);
    else console.error(`  ✗ ${chainName} failed: ${r.reason?.shortMessage || r.reason?.message || r.reason}`);
  }

  // USD enrichment (ETH/BTC + per-token)
  const { ethPx, btcPx } = await enrichWithUsd(ok);
  console.log(`▸ ETH=$${ethPx?.toFixed(2)}  BTC=$${btcPx?.toFixed(2)}`);

  await fs.mkdir(DATA_DIR, { recursive: true });

  const summary = {
    lastUpdated: ts,
    ethPx, btcPx,
    retentionDays: RETENTION_DAYS,
    dataSource: 'Aave V3 on-chain (AaveProtocolDataProvider)',
    chains: {},
  };

  for (const { chain, reserves } of ok) {
    const snapshot = { ts, ethPx, btcPx, reserves };

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
      dataSource: summary.dataSource,
      snapshots,
    }));

    summary.chains[chain] = {
      reserveCount: reserves.length,
      snapshotCount: snapshots.length,
      sizeKb: Math.round(JSON.stringify(snapshots).length / 1024),
    };
  }

  await fs.writeFile(path.join(DATA_DIR, 'index.json'), JSON.stringify(summary, null, 2));
  console.log('▸ Done.');
}

main().catch(e => {
  console.error('FATAL:', e);
  process.exit(1);
});
