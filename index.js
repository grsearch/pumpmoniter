require('dotenv').config();
const express = require('express');
const WebSocket = require('ws');
const http = require('http');
const path = require('path');

const { HeliusMonitor } = require('./helius');
const { BirdeyeService } = require('./birdeye');
const { XMentionsService } = require('./xmentions');
const { TokenStore } = require('./tokenStore');
const { WebhookService } = require('./webhook');

const app = express();
const server = http.createServer(app);

// WebSocket server for frontend clients
const wss = new WebSocket.Server({ server });

app.use(express.static(path.join(__dirname, '../public')));
app.use(express.json());

// ========== Token Store ==========
const store = new TokenStore();

// ========== Services ==========
const birdeye = new BirdeyeService(process.env.BIRDEYE_API_KEY);
const xService = new XMentionsService(process.env.X_BEARER_TOKEN);
const helius = new HeliusMonitor(process.env.HELIUS_API_KEY);
const webhook = new WebhookService();

// Wire broadcast into webhook so it can notify frontend
webhook.setBroadcast(broadcast);

// ========== Broadcast to all WS clients ==========
function broadcast(type, data) {
  const msg = JSON.stringify({ type, data, ts: Date.now() });
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(msg);
    }
  });
}

// ========== REST API ==========
app.get('/api/tokens', (req, res) => {
  res.json(store.getAll());
});

app.get('/api/stats', (req, res) => {
  const tokens = store.getAll();
  res.json({
    total: tokens.length,
    heliusConnected: helius.isConnected(),
    uptime: process.uptime(),
    webhookEnabled: webhook.enabled,
    webhookFired: webhook.getFired().length,
  });
});

// List all mints that have triggered the webhook
app.get('/api/webhook/fired', (req, res) => {
  res.json({ fired: webhook.getFired() });
});

// ========== Process new migration event ==========
async function processNewToken(mintAddress, symbol, name) {
  console.log(`[NEW] Migration detected: ${symbol} (${mintAddress})`);

  try {
    // 1. Check authorities (pre-filter)
    const authOk = await birdeye.checkAuthorities(mintAddress);
    if (!authOk) {
      console.log(`[SKIP] ${symbol} failed authority check`);
      return;
    }

    // 2. Fetch initial token data
    const tokenData = await birdeye.getTokenData(mintAddress);
    if (!tokenData) {
      console.log(`[SKIP] ${symbol} no token data`);
      return;
    }

    const entry = {
      mint: mintAddress,
      symbol: symbol || tokenData.symbol || '???',
      name: name || tokenData.name || '',
      addedAt: Date.now(),
      lp: tokenData.liquidity || 0,
      fdv: tokenData.fdv || 0,
      holders: tokenData.holder || 0,
      price: tokenData.price || 0,
      xMentions: null,
      xMentions10m: null,
      priceChange24h: tokenData.priceChange24h || 0,
    };

    store.add(entry);
    broadcast('token_added', entry);
    console.log(`[ADD] ${symbol} | LP: ${entry.lp} | FDV: ${entry.fdv}`);

    // 3. Fetch X mentions immediately
    fetchXMentions(mintAddress, symbol, 'initial');

    // 4. Schedule X mentions at 10 minutes
    setTimeout(() => {
      fetchXMentions(mintAddress, symbol, '10m');
    }, 10 * 60 * 1000);

  } catch (err) {
    console.error(`[ERROR] processNewToken ${mintAddress}:`, err.message);
  }
}

async function fetchXMentions(mintAddress, symbol, stage) {
  try {
    const count = await xService.getMentions(symbol, mintAddress);
    const token = store.get(mintAddress);
    if (!token) return;

    if (stage === 'initial') {
      store.update(mintAddress, { xMentions: count });
    } else {
      store.update(mintAddress, { xMentions10m: count });
    }

    const updated = store.get(mintAddress);
    broadcast('token_updated', updated);
    console.log(`[X] ${symbol} mentions (${stage}): ${count}`);

    // Check webhook condition after every X update
    await webhook.check(updated);
  } catch (err) {
    console.error(`[ERROR] fetchXMentions ${symbol}:`, err.message);
  }
}

// ========== Real-time data refresh loop ==========
async function refreshLoop() {
  const tokens = store.getAll();
  if (tokens.length === 0) return;

  for (const token of tokens) {
    try {
      const data = await birdeye.getTokenData(token.mint);
      if (!data) continue;

      store.update(token.mint, {
        lp: data.liquidity || token.lp,
        fdv: data.fdv || token.fdv,
        holders: data.holder || token.holders,
        price: data.price || token.price,
        priceChange24h: data.priceChange24h || token.priceChange24h,
      });

      // Check auto-exit conditions
      const updated = store.get(token.mint);
      if (updated && shouldExit(updated)) {
        console.log(`[EXIT] ${updated.symbol} removed: age/LP/FDV condition`);
        store.remove(token.mint);
        broadcast('token_removed', { mint: token.mint, reason: getExitReason(updated) });
      } else if (updated) {
        broadcast('token_updated', updated);
        // Check webhook condition on every refresh (LP/FDV may have grown)
        webhook.check(updated).catch(() => {});
      }
    } catch (err) {
      // silent, continue
    }
  }
}

function getAgeHours(token) {
  return (Date.now() - token.addedAt) / (1000 * 3600);
}

function shouldExit(token) {
  const ageH = getAgeHours(token);
  if (ageH > 48) return true;
  if (ageH > 1 && token.fdv < 50000) return true;
  if (ageH > 1 && token.lp < 10000) return true;
  if (token.lp < 2000) return true;
  return false;
}

function getExitReason(token) {
  const ageH = getAgeHours(token);
  if (ageH > 48) return 'Age > 48H';
  if (ageH > 1 && token.fdv < 50000) return 'FDV < $50K (age>1H)';
  if (ageH > 1 && token.lp < 10000) return 'LP < $10K (age>1H)';
  if (token.lp < 2000) return 'LP < $2K';
  return 'Unknown';
}

// Refresh every 30 seconds
setInterval(refreshLoop, 30 * 1000);

// ========== Helius event handler ==========
helius.onMigration(async (event) => {
  await processNewToken(event.mint, event.symbol, event.name);
});

helius.connect();

// Test X proxy connectivity on startup (non-blocking)
xService.testProxyConnection().catch(() => {});

// ========== WebSocket client connect ==========
wss.on('connection', (ws) => {
  console.log('[WS] Client connected');
  // Send current state on connect
  ws.send(JSON.stringify({ type: 'init', data: store.getAll(), ts: Date.now() }));

  ws.on('close', () => console.log('[WS] Client disconnected'));
});

// ========== Start server ==========
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n🚀 Pump Monitor running on http://localhost:${PORT}`);
  console.log(`📡 Listening for pump.fun migrations via Helius...`);
  console.log(`🔑 Helius: ${process.env.HELIUS_API_KEY ? '✓' : '✗ MISSING'}`);
  console.log(`🔑 Birdeye: ${process.env.BIRDEYE_API_KEY ? '✓' : '✗ MISSING'}`);
  console.log(`🔑 X API: ${process.env.X_BEARER_TOKEN ? '✓' : '✗ MISSING'}`);
  console.log(`🔑 Webshare: ${process.env.WEBSHARE_PROXY_USER || process.env.WEBSHARE_API_KEY ? '✓' : '✗ not set (direct connect)'}`);
  console.log(`🔔 Webhook: ${process.env.WEBHOOK_URL ? `✓ → ${process.env.WEBHOOK_URL}` : '✗ not set'}\n`);
});
