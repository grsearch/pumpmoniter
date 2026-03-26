const axios = require('axios');

/**
 * Webhook 发送服务
 *
 * 触发条件：FDV >= 25000
 * firedSet 保证每个 mint 只发送一次，不会重复。
 */

class WebhookService {
  constructor() {
    this.url    = process.env.WEBHOOK_URL || '';
    this.minFdv = Number(process.env.WEBHOOK_MIN_FDV) || 25000;

    this.firedSet    = new Set();
    this.broadcastFn = null;

    if (!this.url) {
      console.warn('[Webhook] WEBHOOK_URL not set — webhook disabled');
    } else {
      console.log(`[Webhook] Enabled → ${this.url}`);
      console.log(`[Webhook] Threshold: FDV >= $${this.minFdv}`);
    }
  }

  setBroadcast(fn) {
    this.broadcastFn = fn;
  }

  get enabled() {
    return !!this.url;
  }

  /**
   * @param {object} token        - store 里的 token 对象
   * @param {object|null} stable  - 稳定读数（保留参数兼容调用方）
   */
  async check(token, stable) {
    if (!this.enabled) return;

    // 已发送过，不重复
    if (this.firedSet.has(token.mint)) return;

    // 条件：FDV >= 25000
    if ((token.fdv || 0) < this.minFdv) return;

    // 条件满足，触发
    this.firedSet.add(token.mint);
    await this._send(token);
  }

  async _send(token) {
    const payload = {
      network: 'solana',
      address: token.mint,
      symbol:  token.symbol,
    };

    console.log(`[Webhook] 🚀 Firing $${token.symbol} | FDV=$${token.fdv}`);

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

module.exports = { WebhookService };
