const axios = require('axios');

/**
 * Webhook 发送服务
 *
 * 当代币满足触发条件时，POST 到配置的 webhook URL：
 *   POST {WEBHOOK_URL}
 *   { "network": "solana", "address": "<mint>", "symbol": "<symbol>" }
 *
 * 触发条件（AND 关系，全部满足才发送）：
 *   FDV  > WEBHOOK_MIN_FDV        (默认 100000)
 *   LP   > WEBHOOK_MIN_LP         (默认 10000)
 *   X mentions > WEBHOOK_MIN_X   (默认 500)
 *
 * 防重复：每个 mint 只触发一次，记录在 firedSet 中。
 */

class WebhookService {
  constructor() {
    this.url = process.env.WEBHOOK_URL || '';
    this.minFdv = Number(process.env.WEBHOOK_MIN_FDV) || 100000;
    this.minLp  = Number(process.env.WEBHOOK_MIN_LP)  || 10000;
    this.minX   = Number(process.env.WEBHOOK_MIN_X)   || 500;

    // 已触发过的 mint，防止重复发送
    this.firedSet = new Set();

    // 可注入广播函数，触发后通知前端
    this.broadcastFn = null;

    if (!this.url) {
      console.warn('[Webhook] WEBHOOK_URL not set — webhook disabled');
    } else {
      console.log(`[Webhook] Enabled → ${this.url}`);
      console.log(`[Webhook] Conditions: FDV>${this.minFdv} LP>${this.minLp} X>${this.minX}`);
    }
  }

  /** 注入 broadcast 函数（由 index.js 调用） */
  setBroadcast(fn) {
    this.broadcastFn = fn;
  }

  get enabled() {
    return !!this.url;
  }

  /**
   * 检查代币是否满足条件，满足则发送 webhook
   * 每次数据更新后调用（包括 X mentions 更新后）
   *
   * @param {object} token  - store 里的代币对象
   */
  async check(token) {
    if (!this.enabled) return;
    if (this.firedSet.has(token.mint)) return; // 已发送过

    // X mentions 取 initial 和 10m 中较大的那个
    const xCount = Math.max(
      token.xMentions    ?? 0,
      token.xMentions10m ?? 0
    );

    const meetsFdv = token.fdv  >= this.minFdv;
    const meetsLp  = token.lp   >= this.minLp;
    const meetsX   = xCount     >= this.minX;

    if (!meetsFdv || !meetsLp || !meetsX) return; // 条件未全部满足

    // 标记已发送（先标记，防止并发重复触发）
    this.firedSet.add(token.mint);

    await this._send(token, xCount);
  }

  async _send(token, xCount) {
    const payload = {
      network: 'solana',
      address: token.mint,
      symbol:  token.symbol,
    };

    console.log(`[Webhook] 🚀 Firing for $${token.symbol} | FDV=$${fmtNum(token.fdv)} LP=$${fmtNum(token.lp)} X=${xCount}`);
    console.log(`[Webhook] POST ${this.url}`, JSON.stringify(payload));

    try {
      const res = await axios.post(this.url, payload, {
        headers: { 'Content-Type': 'application/json' },
        timeout: 10000,
      });
      console.log(`[Webhook] ✅ Sent $${token.symbol} → HTTP ${res.status}`);

      // Notify frontend
      if (this.broadcastFn) {
        this.broadcastFn('webhook_fired', { mint: token.mint, symbol: token.symbol });
      }
    } catch (err) {
      // 发送失败：从已发送集合里移除，允许下次重试
      this.firedSet.delete(token.mint);

      const status = err.response?.status;
      if (status) {
        console.error(`[Webhook] ❌ Failed $${token.symbol} → HTTP ${status}:`, err.response?.data ?? '');
      } else {
        console.error(`[Webhook] ❌ Failed $${token.symbol}:`, err.message);
      }
    }
  }

  /** 已触发列表（供 API 查询） */
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
