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

// ========== Token Store ==========
const store = new TokenStore();

// ========== Broadcast（先定义，再传给 webhook）==========
function broadcast(type, data) {
  const msg = JSON.stringify({ type, data, ts: Date.now() });
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(msg);
    }
  });
}

// ========== Services ==========
const birdeye = new BirdeyeService(process.env.BIRDEYE_API_KEY);
const xService = new XMentionsService(process.env.X_BEARER_TOKEN);
const helius   = new HeliusMonitor(process.env.HELIUS_API_KEY);
const webhook  = new WebhookService();
webhook.setBroadcast(broadcast);

// ========== Helius RPC: 查询 holder 数量 ==========
const HELIUS_RPC_URL = `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`;

async function getHolderCount(mintAddress) {
  try {
    const res = await axios.post(HELIUS_RPC_URL, {
      jsonrpc: '2.0',
      id: 1,
      method: 'getTokenAccounts',
      params: {
        mint: mintAddress,
        limit: 1000,
        page: 1,
      },
    }, { timeout: 10000 });

    const accounts = res.data?.result?.token_accounts;
    if (!Array.isArray(accounts)) return 0;
    return accounts.length;
  } catch (err) {
    console.error(`[Holders] getHolderCount(${mintAddress.slice(0,8)}...) error:`, err.message);
    return 0;
  }
}

// ========== REST API ==========
app.get('/api/tokens', (req, res) => {
  res.json(store.getAll());
});

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
async function processNewToken(mintAddress, symbol, name) {
  if (store.get(mintAddress)) {
    console.log(`[SKIP] ${mintAddress} already tracked`);
    return;
  }

  console.log(`[NEW] Migration detected: ${mintAddress}`);

  try {
    // 1. 权限检查
    const authOk = await birdeye.checkAuthorities(mintAddress);
    if (!authOk) {
      console.log(`[SKIP] ${mintAddress} failed authority check`);
      return;
    }

    // 2. 获取代币数据
    const tokenData = await birdeye.getTokenData(mintAddress);
    if (!tokenData) {
      console.log(`[SKIP] ${mintAddress} no token data`);
      return;
    }

    const entry = {
      mint: mintAddress,
      symbol: tokenData.symbol || symbol || '???',
      name:   tokenData.name   || name   || '',
      logoURI: tokenData.logoURI || '',
      addedAt: Date.now(),
      lp:             Number(tokenData.liquidity)    || 0,
      fdv:            Number(tokenData.fdv)          || 0,
      holders:        0,   // 先用0，异步查完再更新
      price:          Number(tokenData.price)        || 0,
      priceChange24h: Number(tokenData.priceChange24h) || 0,
      xMentions:    null,
      xMentions10m: null,
    };

    store.add(entry);
    store.recordLpFdv(mintAddress, entry.lp, entry.fdv);
    broadcast('token_added', entry);
    console.log(`[ADD] $${entry.symbol} | LP=$${fmtNum(entry.lp)} FDV=$${fmtNum(entry.fdv)}`);

    // 3. 异步查 holders（不阻塞主流程）
    getHolderCount(mintAddress).then(holders => {
      if (!store.get(mintAddress)) return;
      store.update(mintAddress, { holders });
      broadcast('token_updated', store.get(mintAddress));
      console.log(`[Holders] $${entry.symbol}: ${holders}`);
    });

    // 4. 立即查 X mentions
    fetchXMentions(mintAddress, entry.symbol, 'initial');

    // 5. 2分钟后再查一次
    setTimeout(() => {
      if (store.get(mintAddress)) {
        fetchXMentions(mintAddress, entry.symbol, '10m');
      }
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

    store.update(mintAddress, stage === 'initial'
      ? { xMentions: count }
      : { xMentions10m: count }
    );

    const updated = store.get(mintAddress);
    broadcast('token_updated', updated);
    console.log(`[X] $${symbol} mentions (${stage}): ${count}`);

    await webhook.check(updated, store.getStableReading(mintAddress));
  } catch (err) {
    console.error(`[ERROR] fetchXMentions $${symbol}:`, err.message);
  }
}

// ========== Real-time data refresh loop ==========
async function refreshLoop() {
  const tokens = store.getAll();
  if (tokens.length === 0) return;

  for (const token of tokens) {
    try {
      const data = await birdeye.getTokenData(token.mint);
      if (!data) {
        await sleep(300);
        continue;
      }

      const newLp  = Number(data.liquidity ?? token.lp)  || 0;
      const newFdv = Number(data.fdv       ?? token.fdv) || 0;

      // Birdeye 的 holder 字段对新币是 null，用旧值保留
      const birdeyeHolders = Number(data.holder) || 0;

      store.update(token.mint, {
        lp:             newLp,
        fdv:            newFdv,
        // 只有 Birdeye 返回有效值时才覆盖，否则保留已有的 Helius 数据
        holders:        birdeyeHolders || token.holders,
        price:          Number(data.price          ?? token.price)         || 0,
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

// ========== holders 单独刷新（每60秒，与 Birdeye 刷新错开）==========
async function holdersRefreshLoop() {
  const tokens = store.getAll();
  for (const token of tokens) {
    const holders = await getHolderCount(token.mint);
    if (!store.get(token.mint)) continue;
    // 只在有变化时更新，减少不必要的 broadcast
    if (holders !== token.holders) {
      store.update(token.mint, { holders });
      broadcast('token_updated', store.get(token.mint));
      console.log(`[Holders] $${token.symbol}: ${token.holders} → ${holders}`);
    }
    await sleep(500); // 每个 token 间隔 500ms，避免 RPC 限速
  }
}

// ========== 退出条件 ==========
function getAgeHours(token) {
  return (Date.now() - token.addedAt) / 3600000;
}

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

// ========== 工具函数 ==========
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function fmtNum(n) {
  const v = Number(n);
  if (!v || isNaN(v)) return '0';
  if (v >= 1e6) return (v / 1e6).toFixed(2) + 'M';
  if (v >= 1e3) return (v / 1e3).toFixed(1) + 'K';
  return v.toFixed(0);
}

// ========== 定时任务 ==========
setInterval(refreshLoop, 30 * 1000);          // Birdeye 数据每30秒刷新
setInterval(holdersRefreshLoop, 60 * 1000);   // Holders 每60秒刷新

// ========== Helius 事件监听 ==========
helius.onMigration(async (event) => {
  await processNewToken(event.mint, event.symbol, event.name);
});

helius.connect();
xService.testProxyConnection().catch(() => {});

// ========== WebSocket 客户端连接 ==========
wss.on('connection', (ws) => {
  console.log('[WS] Client connected');
  ws.send(JSON.stringify({ type: 'init', data: store.getAll(), ts: Date.now() }));
  ws.on('close', () => console.log('[WS] Client disconnected'));
  ws.on('error', (err) => console.error('[WS] Client error:', err.message));
});

// ========== 启动 ==========
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
