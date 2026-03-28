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

// ========================================================
// ⏰ 工作时间控制（北京时间 07:00 开始，23:30 停止）
// UTC 换算：停止 = UTC 15:30，启动 = UTC 23:00
// ========================================================

// 工作时段：北京时间 [07:00, 23:30)
// 即 UTC [23:00, 15:30) —— 跨午夜，需特别处理
const WORK_START_BJT = { hour: 7,  minute: 0  }; // 北京时间 07:00
const WORK_STOP_BJT  = { hour: 23, minute: 30 }; // 北京时间 23:30

let isWorking = false; // 当前是否处于工作状态
let refreshTimer = null;
let holderRefreshTimer = null;

/**
 * 判断当前北京时间是否处于工作时段
 * 工作时段: 07:00 <= BJT < 23:30
 */
function isWorkingHour() {
  // 北京时间 = UTC + 8h
  const nowUTC = new Date();
  const bjtMs = nowUTC.getTime() + 8 * 60 * 60 * 1000;
  const bjt = new Date(bjtMs);

  const h = bjt.getUTCHours();
  const m = bjt.getUTCMinutes();
  const totalMin = h * 60 + m;

  const startMin = WORK_START_BJT.hour * 60 + WORK_START_BJT.minute; // 420
  const stopMin  = WORK_STOP_BJT.hour  * 60 + WORK_STOP_BJT.minute;  // 1410

  return totalMin >= startMin && totalMin < stopMin;
}

/** 格式化北京时间，仅用于日志 */
function bjtTimeStr() {
  const nowUTC = new Date();
  const bjtMs = nowUTC.getTime() + 8 * 60 * 60 * 1000;
  const bjt = new Date(bjtMs);
  const h = String(bjt.getUTCHours()).padStart(2, '0');
  const m = String(bjt.getUTCMinutes()).padStart(2, '0');
  return `${h}:${m} BJT`;
}

/** 启动工作模式：开启 Helius 监听 + 刷新定时器 */
function startWork() {
  if (isWorking) return;
  isWorking = true;
  console.log(`\n▶️  [Schedule] Work START at ${bjtTimeStr()} — monitoring resumed`);

  // 启动 Helius 监听
  helius.connect();

  // 启动数据刷新定时器
  if (!refreshTimer) {
    refreshTimer = setInterval(refreshLoop, 30 * 1000);
  }
  if (!holderRefreshTimer) {
    holderRefreshTimer = setInterval(holderStatsRefreshLoop, 90 * 1000);
  }

  broadcast('schedule', { working: true, message: '监控已开启 (BJT 07:00)' });
}

/** 停止工作模式：停止 Helius 监听 + 刷新定时器，清空追踪列表 */
function stopWork() {
  if (!isWorking) return;
  isWorking = false;
  console.log(`\n⏸️  [Schedule] Work STOP at ${bjtTimeStr()} — monitoring paused`);

  // 停止 Helius 监听
  helius.stop();

  // 清除刷新定时器
  if (refreshTimer)       { clearInterval(refreshTimer);       refreshTimer = null; }
  if (holderRefreshTimer) { clearInterval(holderRefreshTimer); holderRefreshTimer = null; }

  // 清空当前追踪的 token 列表，通知前端
  store.getAll().forEach(t => {
    store.remove(t.mint);
    broadcast('token_removed', { mint: t.mint, reason: '休市清空' });
  });

  broadcast('schedule', { working: false, message: '监控已暂停 (BJT 23:30)，将于 07:00 恢复' });
}

/**
 * 每分钟检查一次工作时段，到点自动切换状态
 * 使用秒级对齐（等到整分钟后首次运行）
 */
function startScheduler() {
  const shouldWork = isWorkingHour();
  console.log(`[Schedule] Init at ${bjtTimeStr()} — should work: ${shouldWork}`);

  if (shouldWork) {
    startWork();
  } else {
    console.log(`[Schedule] Outside working hours, monitoring paused until BJT 07:00`);
    isWorking = false; // 确保标记正确，但不重复调用 stop
  }

  // 对齐到下一个整分钟后开始轮询，减少漂移
  const nowMs = Date.now();
  const msToNextMinute = 60000 - (nowMs % 60000);

  setTimeout(() => {
    // 首次检查
    checkSchedule();
    // 之后每分钟检查一次
    setInterval(checkSchedule, 60 * 1000);
  }, msToNextMinute);
}

function checkSchedule() {
  const shouldWork = isWorkingHour();

  if (shouldWork && !isWorking) {
    startWork();
  } else if (!shouldWork && isWorking) {
    stopWork();
  }
}

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
    working: isWorking,
    currentBJT: bjtTimeStr(),
  });
});

app.get('/api/webhook/fired', (req, res) => {
  res.json({ fired: webhook.getFired() });
});

// ========== Process new migration event ==========
async function processNewToken(mintAddress, symbol, name, devAddress) {
  // 非工作时间忽略事件（理论上 helius 已 stop，这是双重保险）
  if (!isWorking) return;

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
      top10Pct:       null,
      devPct:         null,
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
  if (!isWorking) return; // 非工作时间跳过
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
  if (!isWorking) return; // 非工作时间跳过
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
    await sleep(1000);
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

// ========== Helius 事件监听（现在带 devAddress）==========
helius.onMigration(async (event) => {
  await processNewToken(event.mint, event.symbol, event.name, event.devAddress || null);
});

// ========== 启动调度器（替代原来直接调用 helius.connect()）==========
startScheduler();
xService.testProxyConnection().catch(() => {});

wss.on('connection', (ws) => {
  console.log('[WS] Client connected');
  // 连接时同步推送工作状态
  ws.send(JSON.stringify({
    type: 'schedule',
    data: { working: isWorking, currentBJT: bjtTimeStr() },
    ts: Date.now(),
  }));
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
  console.log(`⏱  Stable check interval: ${STABLE_INTERVAL_MS / 60000} min`);
  console.log(`🕐 Schedule: BJT 07:00 – 23:30 (UTC 23:00 – 15:30)\n`);
});
