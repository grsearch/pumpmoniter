const WebSocket = require('ws');
const axios = require('axios');

/**
 * Helius Monitor — pump.fun 迁移事件监听
 *
 * 主轨：Enhanced WebSocket（atlas-mainnet.helius-rpc.com）
 *   使用 Helius 专有的 transactionSubscribe 方法
 *   过滤包含 pump.fun AMM program 的交易，实时推送完整交易体
 *   无需再单独 getTransaction，延迟极低（<1s）
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

// Enhanced WS 用 atlas 域名，标准 RPC 用 mainnet 域名
const ENHANCED_WS_URL  = (apiKey) => `wss://atlas-mainnet.helius-rpc.com/?api-key=${apiKey}`;
const RPC_URL          = (apiKey) => `https://mainnet.helius-rpc.com/?api-key=${apiKey}`;

const POLL_INTERVAL_MS = 20 * 1000;
const SIGNATURES_LIMIT = 20;
const PING_INTERVAL_MS = 30 * 1000;

class HeliusMonitor {
  constructor(apiKey) {
    this.apiKey     = apiKey;
    this.rpcUrl     = RPC_URL(apiKey);
    this.wsUrl      = ENHANCED_WS_URL(apiKey);
    this.callbacks  = [];
    this.ws         = null;
    this.wsAlive    = false;         // Enhanced WS 是否在线
    this.pingTimer  = null;
    this.pollTimer  = null;
    this.seenSigs   = new Set();     // 已处理签名（轮询去重用）
    this.seenMints  = new Set();     // 已处理 mint（全局去重）
  }

  isConnected() {
    return this.wsAlive;
  }

  onMigration(cb) {
    this.callbacks.push(cb);
  }

  connect() {
    console.log('[Helius] Starting pump.fun migration monitor...');
    this._connectEnhancedWS();
    this._startPolling();           // 同时启动轮询兜底
  }

  // ============================================================
  // Enhanced WebSocket（主轨）
  // ============================================================
  _connectEnhancedWS() {
    console.log('[Helius] Connecting Enhanced WebSocket...');
    this.ws = new WebSocket(this.wsUrl);

    this.ws.on('open', () => {
      this.wsAlive = true;
      console.log('[Helius] Enhanced WebSocket connected ✓');
      this._sendSubscription();
      this._startPing();
    });

    this.ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        this._handleEnhancedMessage(msg);
      } catch (e) { /* ignore parse errors */ }
    });

    this.ws.on('close', (code, reason) => {
      this.wsAlive = false;
      this._stopPing();
      console.log(`[Helius] Enhanced WS closed (${code}). Reconnecting in 5s...`);
      setTimeout(() => this._connectEnhancedWS(), 5000);
    });

    this.ws.on('error', (err) => {
      console.error('[Helius] Enhanced WS error:', err.message);
      // close 事件会在 error 之后触发，由 close 处理重连
    });
  }

  _sendSubscription() {
    // transactionSubscribe：监听包含 pump AMM program 的成功交易
    // accountInclude 表示"交易中至少包含这些账户之一"
    const req = {
      jsonrpc: '2.0',
      id: 1,
      method: 'transactionSubscribe',
      params: [
        {
          failed: false,                  // 只要成功的交易
          accountInclude: [
            PUMP_AMM_PROGRAM,             // pump.fun AMM（新版迁移目标）
            PUMP_BC_PROGRAM,              // bonding curve（迁移发起方）
          ],
        },
        {
          commitment: 'confirmed',
          encoding: 'jsonParsed',
          transactionDetails: 'full',
          maxSupportedTransactionVersion: 0,
        }
      ]
    };
    this.ws.send(JSON.stringify(req));
    console.log('[Helius] transactionSubscribe sent');
  }

  _handleEnhancedMessage(msg) {
    // 订阅确认
    if (msg.id === 1) {
      if (msg.error) {
        console.error('[Helius] transactionSubscribe error:', msg.error.message);
        console.error('[Helius] Falling back to polling only');
      } else {
        console.log(`[Helius] transactionSubscribe confirmed (id=${msg.result})`);
      }
      return;
    }

    // pong 响应
    if (msg.result === 'pong') return;

    // 交易通知
    if (msg.method === 'transactionNotification') {
      const tx = msg.params?.result?.transaction;
      const sig = msg.params?.result?.signature;
      if (!tx || !sig) return;

      // 检查是否迁移交易
      const logs = tx.meta?.logMessages || [];
      const isMigration = this._isMigrationTx(logs);
      if (!isMigration) return;

      // 提取 mint
      const mint = this._extractMint(tx);
      if (!mint) return;
      if (this.seenMints.has(mint)) return;
      this.seenMints.add(mint);

      console.log(`[Helius] ✅ WS Migration: ${mint} (${sig.slice(0,8)}...)`);
      this._emit(mint, sig);
    }
  }

  // ============================================================
  // Ping / Pong（保持 WS 连接，Helius 10分钟无活动会断）
  // ============================================================
  _startPing() {
    this._stopPing();
    this.pingTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        // Helius 支持 ping method
        this.ws.send(JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method: 'ping' }));
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
    // 先跑一次建立基准线（不触发回调）
    this._pollInit().then(() => {
      this.pollTimer = setInterval(() => this._pollOnce(), POLL_INTERVAL_MS);
      console.log(`[Helius] Polling fallback started (every ${POLL_INTERVAL_MS / 1000}s)`);
    });
  }

  async _pollInit() {
    try {
      const sigs = await this._fetchSigs(PUMP_AMM_PROGRAM);
      sigs.forEach(s => this.seenSigs.add(s.signature));
      const sigs2 = await this._fetchSigs(PUMP_BC_PROGRAM);
      sigs2.forEach(s => this.seenSigs.add(s.signature));
      console.log(`[Helius] Polling baseline: ${this.seenSigs.size} signatures`);
    } catch (err) {
      console.error('[Helius] Poll init error:', err.message);
    }
  }

  async _pollOnce() {
    try {
      await Promise.all([
        this._processNewSigs(PUMP_AMM_PROGRAM),
        this._processNewSigs(PUMP_BC_PROGRAM),
      ]);
    } catch (err) {
      console.error('[Helius] Poll error:', err.message);
    }
  }

  async _fetchSigs(program) {
    const res = await axios.post(this.rpcUrl, {
      jsonrpc: '2.0', id: 1,
      method: 'getSignaturesForAddress',
      params: [program, { limit: SIGNATURES_LIMIT, commitment: 'confirmed' }]
    }, { timeout: 10000 });
    return res.data?.result || [];
  }

  async _processNewSigs(program) {
    const sigs = await this._fetchSigs(program);
    for (const info of sigs) {
      if (!info.signature || this.seenSigs.has(info.signature)) continue;
      this.seenSigs.add(info.signature);
      if (info.err) continue;

      // 异步解析交易
      this._parseTxFromRpc(info.signature).catch(() => {});
    }
    // 防止 seenSigs 无限增长
    if (this.seenSigs.size > 2000) {
      const arr = Array.from(this.seenSigs);
      arr.slice(0, arr.length - 1000).forEach(s => this.seenSigs.delete(s));
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
      }]
    }, { timeout: 12000 });

    const tx = res.data?.result;
    if (!tx) return;

    const logs = tx.meta?.logMessages || [];
    if (!this._isMigrationTx(logs)) return;

    const mint = this._extractMint(tx);
    if (!mint || this.seenMints.has(mint)) return;
    this.seenMints.add(mint);

    console.log(`[Helius] ✅ Poll Migration: ${mint} (${signature.slice(0,8)}...)`);
    this._emit(mint, signature);
  }

  // ============================================================
  // 公共工具
  // ============================================================
  _isMigrationTx(logs) {
    return logs.some(log =>
      log.includes('MigrateFunds') ||
      log.includes('CreatePool')   ||
      log.includes('InitializePool') ||
      log.includes('initialize') && log.includes('amm')
    );
  }

  _extractMint(tx) {
    // 优先从 postTokenBalances 找以 pump 结尾的 mint
    const post = tx.meta?.postTokenBalances || [];
    for (const b of post) {
      if (b.mint?.endsWith('pump')) return b.mint;
    }
    const pre = tx.meta?.preTokenBalances || [];
    for (const b of pre) {
      if (b.mint?.endsWith('pump')) return b.mint;
    }
    // 从 accountKeys 找
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
