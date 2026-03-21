const WebSocket = require('ws');
const axios = require('axios');

/**
 * Helius Monitor — pump.fun 迁移事件监听
 *
 * 主轨：标准 Solana WebSocket（wss://mainnet.helius-rpc.com）
 *   使用标准 logsSubscribe，同时监听 BC 和新 AMM program
 *   过滤包含 MigrateFunds / CreatePool / InitializePool 的交易日志
 *   再 getTransaction 解析 mint
 *
 * 兜底：REST 轮询（getSignaturesForAddress，每20秒）
 *   只轮询 BC program，避免 AMM 上大量老币交易误触发
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

const POLL_INTERVAL_MS  = 20 * 1000;
const SIGNATURES_LIMIT  = 25;
const PING_INTERVAL_MS  = 30 * 1000;
const SEEN_SIGS_MAX     = 2000;
const SEEN_SIGS_TRIM    = 1000;
const SEEN_MINTS_MAX    = 2000;
const SEEN_MINTS_TRIM   = 1000;

class HeliusMonitor {
  constructor(apiKey) {
    this.apiKey    = apiKey;
    this.rpcUrl    = RPC_URL(apiKey);
    this.wsUrl     = STANDARD_WS_URL(apiKey);
    this.callbacks = [];
    this.ws        = null;
    this.wsAlive   = false;
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
      this._stopPing();
      console.log(`[Helius] WS closed (${code}), reconnecting in 5s...`);
      setTimeout(() => this._connectWS(), 5000);
    });

    this.ws.on('error', (err) => {
      console.error('[Helius] WS error:', err.message);
    });
  }

  _subscribe() {
    // 主订阅：BC program（MigrateFunds 在这里触发）
    this.ws.send(JSON.stringify({
      jsonrpc: '2.0', id: 1,
      method: 'logsSubscribe',
      params: [
        { mentions: [PUMP_BC_PROGRAM] },
        { commitment: 'confirmed' },
      ],
    }));

    // 辅助订阅：新 AMM program（捕获 CreatePool / InitializePool）
    // WS 实时推送安全：_isMigrationLogs 会过滤掉普通 buy/sell
    this.ws.send(JSON.stringify({
      jsonrpc: '2.0', id: 2,
      method: 'logsSubscribe',
      params: [
        { mentions: [PUMP_AMM_PROGRAM] },
        { commitment: 'confirmed' },
      ],
    }));

    console.log('[Helius] logsSubscribe sent for BC + AMM programs');
  }

  _handleMessage(msg) {
    // 订阅确认
    if (msg.id === 1 || msg.id === 2) {
      if (msg.error) {
        console.error('[Helius] logsSubscribe error:', JSON.stringify(msg.error));
        return;
      }
      console.log(`[Helius] logsSubscribe confirmed (id=${msg.id} subId=${msg.result}) ✓`);
      return;
    }

    if (msg.result === 'pong') return;

    if (msg.method === 'logsNotification') {
      const value = msg.params?.result?.value;
      if (!value || value.err) return;

      const logs = value.logs || [];
      const sig  = value.signature;

      if (!this._isMigrationLogs(logs)) return;

      console.log(`[Helius] WS migration log detected: ${sig?.slice(0, 8)}...`);

      this._parseTxFromRpc(sig).catch(err =>
        console.error(`[Helius] parseTx error (${sig?.slice(0, 8)}):`, err.message)
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
        this.ws.ping();
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
    // 两个 program 都要建基准线，防止重启后重复处理历史签名
    const [sigs1, sigs2] = await Promise.all([
      this._fetchSigs(PUMP_BC_PROGRAM),
      this._fetchSigs(PUMP_AMM_PROGRAM),
    ]);
    [...sigs1, ...sigs2].forEach(s => this.seenSigs.add(s.signature));
    console.log(`[Helius] Polling baseline: ${this.seenSigs.size} sigs`);
  }

  async _pollOnce() {
    try {
      // ⚠️ 只轮询 BC program
      // AMM program 每秒有大量老币的 buy/sell 交易，轮询会扫到历史签名
      // 即使 _isMigrationLogs 过滤，风险仍高于收益
      // AMM 的实时迁移事件已由 WS 订阅覆盖
      await this._processNewSigs(PUMP_BC_PROGRAM);
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
    if (this.seenSigs.size > SEEN_SIGS_MAX) {
      Array.from(this.seenSigs).slice(0, SEEN_SIGS_TRIM).forEach(s => this.seenSigs.delete(s));
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
      const post = tx.meta?.postTokenBalances || [];
      console.log(`[Helius] _extractMint failed sig=${signature.slice(0, 8)} postBalanceMints=${JSON.stringify(post.map(b => b.mint))}`);
      return;
    }

    if (this.seenMints.has(mint)) return;
    this.seenMints.add(mint);

    // 防止 seenMints 无限增长
    if (this.seenMints.size > SEEN_MINTS_MAX) {
      Array.from(this.seenMints).slice(0, SEEN_MINTS_TRIM).forEach(m => this.seenMints.delete(m));
    }

    console.log(`[Helius] ✅ Migration: mint = ${mint}`);
    this._emit(mint, signature);
  }

  // ============================================================
  // 工具方法
  // ============================================================

  /**
   * 判断是否为迁移交易
   *
   * 只匹配明确的迁移指令关键词：
   *   MigrateFunds   — 旧路径：BC → Raydium
   *   CreatePool     — 新路径：BC → pump AMM
   *   InitializePool — 部分新格式变体
   *
   * ⚠️ 不匹配 program 地址字符串：
   *   AMM 上所有 buy/sell 日志都含 program 地址，
   *   匹配地址会把老币每一笔交易都误判为迁移。
   */
  _isMigrationLogs(logs) {
    return logs.some(log =>
      log.includes('MigrateFunds')   ||
      log.includes('CreatePool')     ||
      log.includes('InitializePool')
    );
  }

  /**
   * 从交易中提取 mint 地址
   *
   * 只使用 postTokenBalances / preTokenBalances，不使用 accountKeys。
   *
   * 原因：accountKeys 包含 fee_payer（用户钱包）、各类 program、以及 mint，
   * 无法可靠区分 mint 与其他地址，极易误返回钱包地址。
   * pump.fun 迁移交易必然有 token balance 变动，postTokenBalances 足够可靠。
   */
  _extractMint(tx) {
    const post = tx.meta?.postTokenBalances || [];
    const pre  = tx.meta?.preTokenBalances  || [];

    // 1. postTokenBalances — 优先（迁移后 token balance 必有变动）
    for (const b of post) {
      if (b.mint && b.mint.length >= 32) return b.mint;
    }

    // 2. preTokenBalances — 备选
    for (const b of pre) {
      if (b.mint && b.mint.length >= 32) return b.mint;
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
