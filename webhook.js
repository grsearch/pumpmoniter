const axios = require('axios');

/**
 * Webhook 发送服务
 *
 * 触发条件：
 *   X mentions >= WEBHOOK_MIN_X (默认 10)
 *
 * X mentions 会被检测两次：
 *   第一次：代币收录后立即查询（xMentions）
 *   第二次：2分钟后再查一次（xMentions10m）
 *
 * 两次都会尝试触发，取各自的值判断。
 * firedSet 保证每个 mint 只发送一次，不会重复。
 *
 * 例：第一次 X=3 不触发，第二次 X=16 触发发送。
 *     第一次 X=12 触发发送，第二次不重发。
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
      console.log(`[Webhook] Threshold: X >= ${this.minX}`);
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

    // 已发送过，不重复
    if (this.firedSet.has(token.mint)) return;

    // 取当前这次调用时有值的 xMentions
    // 第一次调用：xMentions 有值，xMentions10m 为 null
    // 第二次调用：xMentions10m 有值
    // 用最新有值的那个判断
    const xCount = token.xMentions10m !== null && token.xMentions10m !== undefined
      ? token.xMentions10m
      : token.xMentions;

    // 还没查到，等待
    if (xCount === null || xCount === undefined) return;

    if (xCount < this.minX) return;

    // 条件满足，触发
    this.firedSet.add(token.mint);
    await this._send(token, xCount);
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
