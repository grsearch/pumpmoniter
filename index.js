require('dotenv').config();
const express = require('express');
const WebSocket = require('ws');
const http = require('http');
const path = require('path');
const axios = require('axios');

const { HeliusMonitor } = require('./helius');
const { BirdeyeService } = require('./birdeye');
const { XMentionsService } = require('./xmentions');
const { TokenStore, STABLE_INTERVAL_MS } = require('./tokenStore');
const { WebhookService } = require('./webhook');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

const store = new TokenStore();

function broadcast(type, data) {
  const msg = JSON.stringify({ type, data, ts: Date.now() });
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) client.send(msg);
  });
}

const birdeye = new BirdeyeService(process.env.BIRDEYE_API_KEY);
const xService = new XMentionsService(process.env.X_BEARER_TOKEN);
const helius   = new HeliusMonitor(process.env.HELIUS_API_KEY);
const webhook  = new WebhookService();
webhook.setBroadcast(broadcast);

const HELIUS_RPC_URL = `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`;

// ========== Helius RPC: 查询所有 token accounts ==========
// 返回 { holders, top10Pct, devPct }
// devAddress 可为 null，此时 devPct = null
async function fetchHolderStats(mintAddress, devAddress) {
  try {
    // 拉取所有 token accounts（含余额）
    let allAccounts = [];
    let page = 1;
    while (true) {
      const res = await axios.post(HELIUS_RPC_URL, {
        jsonrpc: '2.0', id: 1,
        method: 'getTokenAccounts',
        params: { mint: mintAddress, limit: 1000, page },
      }, { timeout: 15000 });

      const accounts = res.data?.result?.token_accounts;
      if (!Array.isArray(accounts) || accounts.length === 0) break;
      allAccounts = allAccounts.concat(accounts);
      if (accounts.length < 1000) break; // 最后一页
      page++;
    }

    if (allAccounts.length === 0) return { holders: 0, top10Pct: null, devPct: null };

    // 总供应量 = 所有账户余额之和
    const totalSupply = allAccounts.reduce((sum, a) => sum + Number(a.amount || 0), 0);
    if (totalSupply === 0) return { holders: allAccounts.length, top10Pct: null, devPct: null };

    // 按余额降序排列
    allAccounts.sort((a, b) => Number(b.amount) - Number(a.amount));

    // Top 10 占比
    const top10Sum = allAccounts.slice(0, 10).reduce((sum, a) => sum + Number(a.amount || 0), 0);
    const top10Pct = (top10Sum / totalSupply) * 100;

    // DEV 持仓占比
    let devPct = null;
    if (devAddress) {
      const devAccount = allAccounts.find(a => a.owner === devAddress);
      const devAmount = devAccount ? Number(devAccount.amount || 0) : 0;
      devPct = (devAmount / totalSupply) * 100;
    }

    console.log(`[Stats] ${mintAddress.slice(0,8)}... holders=${allAccounts.length} top10=${top10Pct.toFixed(1)}% dev=${devPct !== null ? devPct.toFixed(1)+'%' : 'N/A'}`);
    return { holders: allAccounts.length, top10Pct, devPct };

  } catch (err) {
    console.error(`[Stats] fetchHolderStats(${mintAddress.slice(0,8)}...) error:`, err.message);
    return { holders: 0, top10Pct: null, devPct: null };
  }
}

// ========== REST API ==========
app.get('/api/tokens', (req, res) => res.json(store.getAll()));

app.get('/api/stats', (req, res) => {
  res.json({
    total: store.size(),
    heliusConnected: helius.isConnected(),
    uptime: Math.floor(process.uptime()),
    webhookEnabled: webhook.enabled,
    webhookFired: webhook.getFired().length,
  });
});

app.get('/api/webhook/fired', (req, res) => {
  res.json({ fired: webhook.getFired() });
});

// ========== Process new migration event ==========
async function processNewToken(mintAddress, symbol, name, devAddress) {
  if (store.get(mintAddress)) {
    console.log(`[SKIP] ${mintAddress} already tracked`);
    return;
  }

  console.log(`[NEW] Migration detected: ${mintAddress} dev=${devAddress || 'unknown'}`);

  try {
    const authOk = await birdeye.checkAuthorities(mintAddress);
    if (!authOk) { console.log(`[SKIP] ${mintAddress} failed authority check`); return; }

    const tokenData = await birdeye.getTokenData(mintAddress);
    if (!tokenData) { console.log(`[SKIP] ${mintAddress} no token data`); return; }

    const entry = {
      mint:    mintAddress,
      symbol:  tokenData.symbol || symbol || '???',
      name:    tokenData.name   || name   || '',
      logoURI: tokenData.logoURI || '',
      addedAt: Date.now(),
      lp:             Number(tokenData.liquidity)      || 0,
      fdv:            Number(tokenData.fdv)            || 0,
      holders:        0,
      top10Pct:       null,   // Top 10 持仓占比 (%)
      devPct:         null,   // DEV 持仓占比 (%)
      devAddress:     devAddress || null,
      price:          Number(tokenData.price)          || 0,
      priceChange24h: Number(tokenData.priceChange24h) || 0,
      xMentions:      null,
      xMentions10m:   null,
    };

    store.add(entry);
    store.recordLpFdv(mintAddress, entry.lp, entry.fdv);
    broadcast('token_added', entry);
    console.log(`[ADD] $${entry.symbol} | LP=$${fmtNum(entry.lp)} FDV=$${fmtNum(entry.fdv)}`);

    // 异步查 holder stats（holders + top10 + dev）
    fetchHolderStats(mintAddress, devAddress).then(stats => {
      if (!store.get(mintAddress)) return;
      store.update(mintAddress, stats);
      broadcast('token_updated', store.get(mintAddress));
    });

    fetchXMentions(mintAddress, entry.symbol, 'initial');

    setTimeout(() => {
      if (store.get(mintAddress)) fetchXMentions(mintAddress, entry.symbol, '10m');
    }, 2 * 60 * 1000);

  } catch (err) {
    console.error(`[ERROR] processNewToken ${mintAddress}:`, err.message);
  }
}

async function fetchXMentions(mintAddress, symbol, stage) {
  try {
    const count = await xService.getMentions(symbol, mintAddress);
    const token = store.get(mintAddress);
    if (!token) return;

    store.update(mintAddress, stage === 'initial' ? { xMentions: count } : { xMentions10m: count });

    const updated = store.get(mintAddress);
    broadcast('token_updated', updated);
    console.log(`[X] $${symbol} mentions (${stage}): ${count}`);
    await webhook.check(updated, store.getStableReading(mintAddress));
  } catch (err) {
    console.error(`[ERROR] fetchXMentions $${symbol}:`, err.message);
  }
}

// ========== Real-time data refresh loop (Birdeye, 每30秒) ==========
async function refreshLoop() {
  const tokens = store.getAll();
  if (tokens.length === 0) return;

  for (const token of tokens) {
    try {
      const data = await birdeye.getTokenData(token.mint);
      if (!data) { await sleep(300); continue; }

      const newLp  = Number(data.liquidity ?? token.lp)  || 0;
      const newFdv = Number(data.fdv       ?? token.fdv) || 0;
      const birdeyeHolders = Number(data.holder) || 0;

      store.update(token.mint, {
        lp:             newLp,
        fdv:            newFdv,
        holders:        birdeyeHolders || token.holders,
        price:          Number(data.price          ?? token.price)          || 0,
        priceChange24h: Number(data.priceChange24h  ?? token.priceChange24h) || 0,
        logoURI:        data.logoURI || token.logoURI,
      });

      store.recordLpFdv(token.mint, newLp, newFdv);

      const updated = store.get(token.mint);
      if (!updated) { await sleep(300); continue; }

      const stable = store.getStableReading(token.mint);

      if (shouldExit(updated, stable)) {
        const reason = getExitReason(updated, stable);
        console.log(`[EXIT] $${updated.symbol} — ${reason}`);
        store.remove(token.mint);
        broadcast('token_removed', { mint: token.mint, reason });
        await sleep(300);
        continue;
      }

      broadcast('token_updated', updated);
      webhook.check(updated, stable).catch(() => {});
      await sleep(300);

    } catch (err) {
      console.error(`[ERROR] refreshLoop $${token.symbol}:`, err.message);
      await sleep(300);
    }
  }
}

// ========== Holder stats 刷新（每90秒）==========
async function holderStatsRefreshLoop() {
  const tokens = store.getAll();
  for (const token of tokens) {
    const stats = await fetchHolderStats(token.mint, token.devAddress || null);
    if (!store.get(token.mint)) continue;

    const changed =
      stats.holders  !== token.holders  ||
      stats.top10Pct !== token.top10Pct ||
      stats.devPct   !== token.devPct;

    if (changed) {
      store.update(token.mint, stats);
      broadcast('token_updated', store.get(token.mint));
    }
    await sleep(1000); // 每个 token 间隔 1s，避免 RPC 限速
  }
}

// ========== 退出条件 ==========
function getAgeHours(token) { return (Date.now() - token.addedAt) / 3600000; }

function shouldExit(token, stable) {
  const ageH = getAgeHours(token);
  if (ageH > 1) return true;
  if (ageH > 0.25 && stable && stable.fdv > 0 && stable.fdv < 20000) return true;
  return false;
}

function getExitReason(token, stable) {
  const ageH = getAgeHours(token);
  if (ageH > 1) return 'Age > 1H';
  if (ageH > 0.25 && stable && stable.fdv < 20000) return `FDV $${fmtNum(stable.fdv)} < $20K (age>15min)`;
  return 'Unknown';
}

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function fmtNum(n) {
  const v = Number(n);
  if (!v || isNaN(v)) return '0';
  if (v >= 1e6) return (v / 1e6).toFixed(2) + 'M';
  if (v >= 1e3) return (v / 1e3).toFixed(1) + 'K';
  return v.toFixed(0);
}

// ========== 定时任务 ==========
setInterval(refreshLoop, 30 * 1000);
setInterval(holderStatsRefreshLoop, 90 * 1000);

// ========== Helius 事件监听（现在带 devAddress）==========
helius.onMigration(async (event) => {
  await processNewToken(event.mint, event.symbol, event.name, event.devAddress || null);
});

helius.connect();
xService.testProxyConnection().catch(() => {});

wss.on('connection', (ws) => {
  console.log('[WS] Client connected');
  ws.send(JSON.stringify({ type: 'init', data: store.getAll(), ts: Date.now() }));
  ws.on('close', () => console.log('[WS] Client disconnected'));
  ws.on('error', (err) => console.error('[WS] Client error:', err.message));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n🚀 Pump Monitor running at http://localhost:${PORT}`);
  console.log(`📡 Listening for pump.fun migrations via Helius...`);
  console.log(`🔑 Helius:   ${process.env.HELIUS_API_KEY   ? '✓' : '✗ MISSING'}`);
  console.log(`🔑 Birdeye:  ${process.env.BIRDEYE_API_KEY  ? '✓' : '✗ MISSING'}`);
  console.log(`🔑 X API:    ${process.env.X_BEARER_TOKEN   ? '✓' : '✗ MISSING'}`);
  console.log(`🔑 Webshare: ${process.env.WEBSHARE_PROXY_USER || process.env.WEBSHARE_API_KEY ? '✓' : '✗ not set (direct)'}`);
  console.log(`🔔 Webhook:  ${process.env.WEBHOOK_URL ? `✓ → ${process.env.WEBHOOK_URL}` : '✗ not set'}`);
  console.log(`⏱  Stable check interval: ${STABLE_INTERVAL_MS / 60000} min\n`);
});
