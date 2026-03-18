const axios = require('axios');

/**
 * Webhook 发送服务
 *
 * 触发条件（AND，全部满足才发送）：
 *   FDV  >= WEBHOOK_MIN_FDV  (默认 100000)
 *   LP   >= WEBHOOK_MIN_LP   (默认 10000)
 *   X mentions >= WEBHOOK_MIN_X  (默认 500)
 *
 * 容错：LP/FDV 条件必须基于稳定读数（由 index.js 传入）。
 *       如果没有稳定读数，LP/FDV 条件暂不判断，等稳定后再触发。
 *       X mentions 无稳定性要求（不受 Birdeye 影响）。
 *
 * 防重复：每个 mint 只触发一次。
 */

class WebhookService {
  constructor() {
    this.url    = process.env.WEBHOOK_URL    || '';
    this.minFdv = Number(process.env.WEBHOOK_MIN_FDV) || 100000;
    this.minLp  = Number(process.env.WEBHOOK_MIN_LP)  || 10000;
    this.minX   = Number(process.env.WEBHOOK_MIN_X)   || 500;

    this.firedSet    = new Set();
    this.broadcastFn = null;

    if (!this.url) {
      console.warn('[Webhook] WEBHOOK_URL not set — webhook disabled');
    } else {
      console.log(`[Webhook] Enabled → ${this.url}`);
      console.log(`[Webhook] Thresholds: FDV>=${this.minFdv} LP>=${this.minLp} X>=${this.minX}`);
    }
  }

  setBroadcast(fn) {
    this.broadcastFn = fn;
  }

  get enabled() {
    return !!this.url;
  }

  /**
   * @param {object} token        - store 里的 token 对象（含最新展示值）
   * @param {object|null} stable  - 稳定读数 { lp, fdv, ts }，null 表示数据未稳定
   */
  async check(token, stable) {
    if (!this.enabled) return;
    if (this.firedSet.has(token.mint)) return;

    // X mentions：null = 还没查到，不参与判断
    if (token.xMentions === null && token.xMentions10m === null) return;
    const xCount = Math.max(token.xMentions ?? 0, token.xMentions10m ?? 0);
    if (xCount < this.minX) return;

    // LP/FDV：必须有稳定读数才判断（容错核心）
    if (!stable) {
      // 数据还太新（< 5分钟），暂不触发，等下一轮刷新
      console.log(`[Webhook] $${token.symbol} X=${xCount} ✓ but LP/FDV not stable yet, skip`);
      return;
    }

    if (stable.fdv < this.minFdv) return;
    if (stable.lp  < this.minLp)  return;

    // 所有条件满足，触发
    this.firedSet.add(token.mint);
    await this._send(token, stable, xCount);
  }

  async _send(token, stable, xCount) {
    const payload = {
      network: 'solana',
      address: token.mint,
      symbol:  token.symbol,
    };

    console.log(
      `[Webhook] 🚀 Firing $${token.symbol}` +
      ` | stableFDV=$${fmtNum(stable.fdv)} stableLP=$${fmtNum(stable.lp)} X=${xCount}`
    );

    try {
      const res = await axios.post(this.url, payload, {
        headers: { 'Content-Type': 'application/json' },
        timeout: 10000,
      });
      console.log(`[Webhook] ✅ $${token.symbol} → HTTP ${res.status}`);

      if (this.broadcastFn) {
        this.broadcastFn('webhook_fired', { mint: token.mint, symbol: token.symbol });
      }
    } catch (err) {
      // 发送失败，移除标记允许下次重试
      this.firedSet.delete(token.mint);
      const status = err.response?.status;
      if (status) {
        console.error(`[Webhook] ❌ $${token.symbol} → HTTP ${status}:`, err.response?.data ?? '');
      } else {
        console.error(`[Webhook] ❌ $${token.symbol}:`, err.message);
      }
    }
  }

  getFired() {
    return Array.from(this.firedSet);
  }
}

function fmtNum(n) {
  if (!n) return '0';
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return n.toFixed(0);
}

module.exports = { WebhookService };
