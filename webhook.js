const axios = require('axios');

/**
 * Webhook 发送服务
 *
 * 触发条件：
 *   X mentions（第一次检测值）>= WEBHOOK_MIN_X (默认 10)
 *
 * X mentions 会被检测两次：
 *   第一次：代币收录后立即查询（xMentions）
 *   第二次：10分钟后再查一次（xMentions10m）
 * Webhook 只基于第一次的值判断，第二次检测后不再触发。
 *
 * 防重复：每个 mint 只触发一次。
 */

class WebhookService {
  constructor() {
    this.url    = process.env.WEBHOOK_URL    || '';
    this.minX   = Number(process.env.WEBHOOK_MIN_X) || 10;

    this.firedSet    = new Set();
    this.broadcastFn = null;

    if (!this.url) {
      console.warn('[Webhook] WEBHOOK_URL not set — webhook disabled');
    } else {
      console.log(`[Webhook] Enabled → ${this.url}`);
      console.log(`[Webhook] Threshold: X >= ${this.minX} (first check only)`);
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
   * @param {object|null} stable  - 稳定读数（不再使用，保留参数兼容调用方）
   */
  async check(token, stable) {
    if (!this.enabled) return;
    if (this.firedSet.has(token.mint)) return;

    // xMentions10m 已有值，说明是第二次检测调用，跳过
    if (token.xMentions10m !== null && token.xMentions10m !== undefined) return;

    // 第一次检测还没完成，等待
    if (token.xMentions === null || token.xMentions === undefined) return;

    // 用第一次的值判断
    if (token.xMentions < this.minX) return;

    // 条件满足，触发
    this.firedSet.add(token.mint);
    await this._send(token, token.xMentions);
  }

  async _send(token, xCount) {
    const payload = {
      network: 'solana',
      address: token.mint,
      symbol:  token.symbol,
    };

    console.log(`[Webhook] 🚀 Firing $${token.symbol} | X=${xCount}`);

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
