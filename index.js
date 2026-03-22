require('dotenv').config();
const express = require('express');
const WebSocket = require('ws');
const http = require('http');
const path = require('path');

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
      // 强制转 Number，Birdeye 偶尔返回字符串
      lp:             Number(tokenData.liquidity)    || 0,
      fdv:            Number(tokenData.fdv)          || 0,
      holders:        Number(tokenData.holder)       || 0,
      price:          Number(tokenData.price)        || 0,
      priceChange24h: Number(tokenData.priceChange24h) || 0,
      xMentions:    null,
      xMentions10m: null,
    };

    store.add(entry);

    // 记录第一条 LP/FDV 历史（用于稳定性判断）
    store.recordLpFdv(mintAddress, entry.lp, entry.fdv);

    broadcast('token_added', entry);
    console.log(`[ADD] $${entry.symbol} | LP=$${fmtNum(entry.lp)} FDV=$${fmtNum(entry.fdv)}`);

    // 3. 立即查 X mentions
    fetchXMentions(mintAddress, entry.symbol, 'initial');

    // 4. 2分钟后再查一次
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

    // X mentions 更新后检查 webhook
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

      // 获取新值，强制转 Number，?? 避免 null/undefined 回退到旧值
      const newLp  = Number(data.liquidity ?? token.lp)  || 0;
      const newFdv = Number(data.fdv       ?? token.fdv) || 0;

      // 更新展示用的最新值
      store.update(token.mint, {
        lp:             newLp,
        fdv:            newFdv,
        holders:        Number(data.holder         ?? token.holders)       || 0,
        price:          Number(data.price          ?? token.price)         || 0,
        priceChange24h: Number(data.priceChange24h  ?? token.priceChange24h) || 0,
        logoURI:        data.logoURI || token.logoURI,
      });

      // 记录本次 LP/FDV 到历史队列
      store.recordLpFdv(token.mint, newLp, newFdv);

      const updated = store.get(token.mint);
      if (!updated) { await sleep(300); continue; }

      // ---- 退出判断 ----
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

      // webhook 检查
      webhook.check(updated, stable).catch(() => {});

      await sleep(300);

    } catch (err) {
      console.error(`[ERROR] refreshLoop $${token.symbol}:`, err.message);
      await sleep(300);
    }
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

// ========== 定时刷新（每30秒）==========
setInterval(refreshLoop, 30 * 1000);

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
