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

  async check(token, stable) {
    if (!this.enabled) return;
    if (this.firedSet.has(token.mint)) return;
    if ((token.fdv || 0) < this.minFdv) return;
    if ((token.lp || 0) < (Number(process.env.WEBHOOK_MIN_LP) || 5000)) return;
    if ((token.holders || 0) < (Number(process.env.WEBHOOK_MIN_HOLDERS) || 10)) return;

    this.firedSet.add(token.mint);
    await this._send(token);
  }

  async _send(token) {
    const fmt1 = (v) => v !== null && v !== undefined ? Number(v).toFixed(1) + '%' : null;

    const payload = {
      network:   'solana',
      address:   token.mint,
      symbol:    token.symbol,
      xMentions: token.xMentions ?? null,
      holders:   token.holders   ?? 0,
      top10Pct:  fmt1(token.top10Pct),
      devPct:    fmt1(token.devPct),
    };

    console.log(
      `[Webhook] 🚀 Firing $${token.symbol} | FDV=$${token.fdv}` +
      ` | X=${payload.xMentions} | Holders=${payload.holders}` +
      ` | Top10=${payload.top10Pct} | Dev=${payload.devPct}`
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
