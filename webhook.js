const axios = require('axios');

/**
 * Webhook 发送服务
 *
 * 触发条件：
 *   X mentions >= WEBHOOK_MIN_X (默认 10)
 *
 * X mentions 会被检测两次：
 *   第一次：代币收录后立即查询（xMentions）
 *   第二次：5分钟后再查一次（xMentions10m）
 *
 * 两次检测均可独立触发 webhook，条件均为 >= WEBHOOK_MIN_X。
 * 防重复：每个 mint 只触发一次，第一次已触发的不会在第二次重复发送。
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
      console.log(`[Webhook] Threshold: X >= ${this.minX} (both checks)`);
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
   * @param {string} [stage]      - 'initial' | '10m' | undefined（refreshLoop 调用时不传）
   */
  async check(token, stable, stage) {
    if (!this.enabled) return;
    if (this.firedSet.has(token.mint)) return;

    // refreshLoop 调用时不传 stage，跳过（webhook 只由 X 检测回调触发）
    if (!stage) return;

    if (stage === 'initial') {
      // 第一次检测：xMentions 有值才判断
      if (token.xMentions === null || token.xMentions === undefined) return;
      if (token.xMentions < this.minX) return;
      this.firedSet.add(token.mint);
      await this._send(token, token.xMentions, 'initial');

    } else if (stage === '10m') {
      // 第二次检测：xMentions10m 有值才判断，且第一次未触发
      if (token.xMentions10m === null || token.xMentions10m === undefined) return;
      if (token.xMentions10m < this.minX) return;
      this.firedSet.add(token.mint);
      await this._send(token, token.xMentions10m, '5min-check');
    }
  }

  async _send(token, xCount, checkLabel) {
    const payload = {
      network: 'solana',
      address: token.mint,
      symbol:  token.symbol,
    };

    console.log(`[Webhook] 🚀 Firing $${token.symbol} | X=${xCount} (${checkLabel})`);

    try {
      const res = await axios.post(this.url, payload, {
        headers: { 'Content-Type': 'application/json' },
        timeout: 10000,
      });
      console.log(`[Webhook] ✅ $${token.symbol} → HTTP ${res.status} (${checkLabel})`);

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
