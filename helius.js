const WebSocket = require('ws');
const axios = require('axios');

/**
 * Helius Monitor — pump.fun 迁移事件监听
 *
 * 主轨：标准 Solana WebSocket（wss://mainnet.helius-rpc.com）
 *   使用标准 logsSubscribe，监听 pump.fun bonding curve program
 *   过滤包含 MigrateFunds 的交易日志，再 getTransaction 解析 mint
 *
 * 兜底：REST 轮询（getSignaturesForAddress，每20秒）
 *   WebSocket 断线期间补漏，确保不丢事件
 *
 * pump.fun 相关 Program：
 *   bonding curve:  6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P
 *   pump AMM (新):  pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA
 */

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

  isConnected() {
    return this.wsAlive;
  }

  onMigration(cb) {
    this.callbacks.push(cb);
  }

  connect() {
    console.log('[Helius] Starting pump.fun migration monitor...');
    this._connectWS();
    this._startPolling();
  }

  // ============================================================
  // 标准 Solana WebSocket（主轨）
  // ============================================================
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
      try {
        const msg = JSON.parse(data.toString());
        this._handleMessage(msg);
      } catch (e) { /* ignore */ }
    });

    this.ws.on('close', (code) => {
      this.wsAlive = false;
      this.subId = null;
      this._stopPing();
      console.log(`[Helius] WS closed (${code}), reconnecting in 5s...`);
      setTimeout(() => this._connectWS(), 5000);
    });

    this.ws.on('error', (err) => {
      console.error('[Helius] WS error:', err.message);
    });
  }

  _subscribe() {
    // logsSubscribe：监听 pump.fun bonding curve program 的所有日志
    // mentions 过滤：只推送包含该 program 地址的交易
    const req = {
      jsonrpc: '2.0',
      id: 1,
      method: 'logsSubscribe',
      params: [
        { mentions: [PUMP_BC_PROGRAM] },
        { commitment: 'confirmed' },
      ],
    };
    this.ws.send(JSON.stringify(req));
    console.log('[Helius] logsSubscribe sent for pump.fun BC program');
  }

  _handleMessage(msg) {
    // 订阅确认
    if (msg.id === 1) {
      if (msg.error) {
        console.error('[Helius] logsSubscribe error:', JSON.stringify(msg.error));
        return;
      }
      this.subId = msg.result;
      console.log(`[Helius] logsSubscribe confirmed (subId=${this.subId}) ✓`);
      return;
    }

    // pong
    if (msg.result === 'pong') return;

    // 日志通知
    if (msg.method === 'logsNotification') {
      const value = msg.params?.result?.value;
      if (!value) return;

      // 跳过失败交易
      if (value.err) return;

      const logs = value.logs || [];
      const sig  = value.signature;

      // 只处理包含迁移相关指令的交易
      if (!this._isMigrationLogs(logs)) return;

      console.log(`[Helius] WS migration log detected: ${sig?.slice(0,8)}...`);

      // 异步解析完整交易获取 mint
      this._parseTxFromRpc(sig).catch(err =>
        console.error(`[Helius] parseTx error (${sig?.slice(0,8)}):`, err.message)
      );
    }
  }

  // ============================================================
  // Ping（保持连接，防止10分钟超时断线）
  // ============================================================
  _startPing() {
    this._stopPing();
    this.pingTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.ping(); // 标准 WebSocket ping frame
      }
    }, PING_INTERVAL_MS);
  }

  _stopPing() {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  // ============================================================
  // REST 轮询兜底
  // ============================================================
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
    // 建立已有签名的基准线，启动后不处理历史交易
    const [sigs1, sigs2] = await Promise.all([
      this._fetchSigs(PUMP_BC_PROGRAM),
      this._fetchSigs(PUMP_AMM_PROGRAM),
    ]);
    [...sigs1, ...sigs2].forEach(s => this.seenSigs.add(s.signature));
    console.log(`[Helius] Polling baseline: ${this.seenSigs.size} sigs`);
  }

  async _pollOnce() {
    try {
      await Promise.all([
        this._processNewSigs(PUMP_BC_PROGRAM),
        this._processNewSigs(PUMP_AMM_PROGRAM),
      ]);
    } catch (err) {
      console.error('[Helius] Poll error:', err.message);
    }
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
    // 防止内存泄漏
    if (this.seenSigs.size > 2000) {
      const arr = Array.from(this.seenSigs);
      arr.slice(0, 1000).forEach(s => this.seenSigs.delete(s));
    }
  }

  // ============================================================
  // 解析交易，提取 mint 地址
  // ============================================================
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
      console.log(`[Helius] Migration tx but mint not found: ${signature.slice(0,8)}...`);
      return;
    }

    if (this.seenMints.has(mint)) return;
    this.seenMints.add(mint);

    console.log(`[Helius] ✅ Migration: ${'mint'} = ${mint}`);
    this._emit(mint, signature);
  }

  // ============================================================
  // 工具方法
  // ============================================================
  _isMigrationLogs(logs) {
    return logs.some(log =>
      log.includes('MigrateFunds') ||
      log.includes('CreatePool')   ||
      log.includes('InitializePool')
    );
  }

  _extractMint(tx) {
    // 1. postTokenBalances 里找以 pump 结尾的 mint
    const post = tx.meta?.postTokenBalances || [];
    for (const b of post) {
      if (b.mint?.endsWith('pump')) return b.mint;
    }
    // 2. preTokenBalances
    const pre = tx.meta?.preTokenBalances || [];
    for (const b of pre) {
      if (b.mint?.endsWith('pump')) return b.mint;
    }
    // 3. accountKeys
    const keys = tx.transaction?.message?.accountKeys || [];
    for (const acc of keys) {
      const k = acc.pubkey || acc;
      if (typeof k === 'string' && k.endsWith('pump') && k.length > 30) return k;
    }
    return null;
  }

  _emit(mint, signature) {
    const event = { mint, signature, symbol: null, name: null };
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
