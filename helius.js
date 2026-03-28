const WebSocket = require('ws');
const axios = require('axios');

const PUMP_BC_PROGRAM  = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const PUMP_AMM_PROGRAM = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';

const STANDARD_WS_URL  = (apiKey) => `wss://mainnet.helius-rpc.com/?api-key=${apiKey}`;
const RPC_URL          = (apiKey) => `https://mainnet.helius-rpc.com/?api-key=${apiKey}`;

const POLL_INTERVAL_MS = 20 * 1000;
const SIGNATURES_LIMIT = 25;
const PING_INTERVAL_MS = 30 * 1000;

class HeliusMonitor {
  constructor(apiKey) {
    this.apiKey    = apiKey;
    this.rpcUrl    = RPC_URL(apiKey);
    this.wsUrl     = STANDARD_WS_URL(apiKey);
    this.callbacks = [];
    this.ws        = null;
    this.wsAlive   = false;
    this.subId     = null;
    this.pingTimer = null;
    this.pollTimer = null;
    this.seenSigs  = new Set();
    this.seenMints = new Set();
  }

  isConnected() { return this.wsAlive; }
  onMigration(cb) { this.callbacks.push(cb); }

  connect() {
    console.log('[Helius] Starting pump.fun migration monitor...');
    this._connectWS();
    this._startPolling();
  }

  _connectWS() {
    console.log('[Helius] Connecting Standard WebSocket...');
    this.ws = new WebSocket(this.wsUrl);

    this.ws.on('open', () => {
      this.wsAlive = true;
      console.log('[Helius] Standard WebSocket connected ✓');
      this._subscribe();
      this._startPing();
    });

    this.ws.on('message', (data) => {
      try { this._handleMessage(JSON.parse(data.toString())); } catch (e) {}
    });

    this.ws.on('close', (code) => {
      this.wsAlive = false;
      this.subId = null;
      this._stopPing();
      console.log(`[Helius] WS closed (${code}), reconnecting in 5s...`);
      setTimeout(() => this._connectWS(), 5000);
    });

    this.ws.on('error', (err) => console.error('[Helius] WS error:', err.message));
  }

  _subscribe() {
    this.ws.send(JSON.stringify({
      jsonrpc: '2.0', id: 1,
      method: 'logsSubscribe',
      params: [{ mentions: [PUMP_BC_PROGRAM] }, { commitment: 'confirmed' }],
    }));
    console.log('[Helius] logsSubscribe sent for pump.fun BC program');
  }

  _handleMessage(msg) {
    if (msg.id === 1) {
      if (msg.error) { console.error('[Helius] logsSubscribe error:', JSON.stringify(msg.error)); return; }
      this.subId = msg.result;
      console.log(`[Helius] logsSubscribe confirmed (subId=${this.subId}) ✓`);
      return;
    }
    if (msg.result === 'pong') return;

    if (msg.method === 'logsNotification') {
      const value = msg.params?.result?.value;
      if (!value || value.err) return;
      const logs = value.logs || [];
      if (!this._isMigrationLogs(logs)) return;
      const sig = value.signature;
      console.log(`[Helius] WS migration log detected: ${sig?.slice(0,8)}...`);
      this._parseTxFromRpc(sig).catch(err =>
        console.error(`[Helius] parseTx error (${sig?.slice(0,8)}):`, err.message)
      );
    }
  }

  _startPing() {
    this._stopPing();
    this.pingTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) this.ws.ping();
    }, PING_INTERVAL_MS);
  }

  _stopPing() {
    if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; }
  }

  _startPolling() {
    this._pollInit().then(() => {
      this.pollTimer = setInterval(() => this._pollOnce(), POLL_INTERVAL_MS);
      console.log(`[Helius] Polling fallback started (every ${POLL_INTERVAL_MS / 1000}s)`);
    }).catch(err => {
      console.error('[Helius] Poll init error:', err.message);
      this.pollTimer = setInterval(() => this._pollOnce(), POLL_INTERVAL_MS);
    });
    }

  async _pollInit() {
    const [sigs1, sigs2] = await Promise.all([
      this._fetchSigs(PUMP_BC_PROGRAM),
      this._fetchSigs(PUMP_AMM_PROGRAM),
    ]);
    [...sigs1, ...sigs2].forEach(s => this.seenSigs.add(s.signature));
    console.log(`[Helius] Polling baseline: ${this.seenSigs.size} sigs`);
  }

  async _pollOnce() {
    try { await this._processNewSigs(PUMP_BC_PROGRAM); }
    catch (err) { console.error('[Helius] Poll error:', err.message); }
  }

  async _fetchSigs(program) {
    const res = await axios.post(this.rpcUrl, {
      jsonrpc: '2.0', id: 1,
      method: 'getSignaturesForAddress',
      params: [program, { limit: SIGNATURES_LIMIT, commitment: 'confirmed' }],
    }, { timeout: 10000 });
    return res.data?.result || [];
  }

  async _processNewSigs(program) {
    const sigs = await this._fetchSigs(program);
    for (const info of sigs) {
      if (!info.signature || this.seenSigs.has(info.signature)) continue;
      this.seenSigs.add(info.signature);
      if (info.err) continue;
      this._parseTxFromRpc(info.signature).catch(() => {});
    }
    if (this.seenSigs.size > 2000) {
      const arr = Array.from(this.seenSigs);
      arr.slice(0, 1000).forEach(s => this.seenSigs.delete(s));
    }
  }

  async _parseTxFromRpc(signature) {
    const res = await axios.post(this.rpcUrl, {
      jsonrpc: '2.0', id: 1,
      method: 'getTransaction',
      params: [signature, {
        encoding: 'jsonParsed',
        commitment: 'confirmed',
        maxSupportedTransactionVersion: 0,
      }],
    }, { timeout: 12000 });

    const tx = res.data?.result;
    if (!tx) return;

    const logs = tx.meta?.logMessages || [];
    if (!this._isMigrationLogs(logs)) return;

    const mint = this._extractMint(tx);
    if (!mint) {
      const post = tx.meta?.postTokenBalances || [];
      console.log(`[Helius] mint extract failed sig=${signature.slice(0,8)} postBalanceMints=${JSON.stringify(post.map(b => b.mint))}`);
      return;
    }

    if (this.seenMints.has(mint)) return;
    this.seenMints.add(mint);

    // 提取 DEV 地址：迁移交易的 fee payer（第一个 accountKey）
    const devAddress = this._extractDevAddress(tx);

    console.log(`[Helius] ✅ Migration: mint=${mint} dev=${devAddress || 'unknown'}`);
    this._emit(mint, signature, devAddress);
  }

  _isMigrationLogs(logs) {
    return logs.some(log =>
      log.includes('MigrateFunds') ||
      log.includes('CreatePool')   ||
      log.includes('InitializePool')
    );
  }

  _extractMint(tx) {
    const post = tx.meta?.postTokenBalances || [];
    for (const b of post) { if (b.mint?.endsWith('pump')) return b.mint; }
    const pre = tx.meta?.preTokenBalances || [];
    for (const b of pre)  { if (b.mint?.endsWith('pump')) return b.mint; }
    const keys = tx.transaction?.message?.accountKeys || [];
    for (const acc of keys) {
      const k = acc.pubkey || acc;
      if (typeof k === 'string' && k.endsWith('pump') && k.length > 30) return k;
    }
    return null;
  }

  // Fee payer = 第一个 accountKey，且 signer: true, writable: true
  _extractDevAddress(tx) {
    try {
      const keys = tx.transaction?.message?.accountKeys || [];
      for (const acc of keys) {
        const pubkey = acc.pubkey || acc;
        const isSigner   = acc.signer   ?? false;
        const isWritable = acc.writable ?? false;
        if (isSigner && isWritable && typeof pubkey === 'string') {
          return pubkey;
        }
      }
    } catch (e) {}
    return null;
  }

  _emit(mint, signature, devAddress) {
    const event = { mint, signature, devAddress, symbol: null, name: null };
    for (const cb of this.callbacks) {
      cb(event).catch(e => console.error('[Helius] callback error:', e.message));
    }
  }

  stop() {
    this._stopPing();
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
    if (this.ws) { this.ws.close(); this.ws = null; }
    this.wsAlive = false;
    console.log('[Helius] Monitor stopped');
  }
}

module.exports = { HeliusMonitor };
