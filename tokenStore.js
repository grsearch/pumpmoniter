/**
 * In-memory token store
 *
 * 容错机制：
 * 每个 token 维护一个 lpFdvHistory 数组，记录最近 N 次 Birdeye 返回的
 * { lp, fdv, ts } 读数。退出判断和 webhook 触发都必须基于"稳定读数"：
 *
 *   稳定读数 = 最近两次读数间隔 >= 5 分钟，且值都满足/都不满足条件
 *
 * 这样单次 API 抖动（返回 0 或异常低值）不会误触发退出或 webhook。
 */

const HISTORY_MAX = 5;           // 最多保留最近5次读数
const STABLE_INTERVAL_MS = 5 * 60 * 1000;  // 两次读数最小间隔 5 分钟

class TokenStore {
  constructor() {
    this.tokens = new Map(); // mint -> token object
  }

  add(token) {
    this.tokens.set(token.mint, {
      ...token,
      lpFdvHistory: [],   // [{ lp, fdv, ts }]
    });
  }

  get(mint) {
    return this.tokens.get(mint) || null;
  }

  update(mint, fields) {
    const existing = this.tokens.get(mint);
    if (!existing) return;
    this.tokens.set(mint, { ...existing, ...fields, updatedAt: Date.now() });
  }

  /**
   * 记录一次 LP/FDV 读数到历史队列
   * 只保留最近 HISTORY_MAX 条
   */
  recordLpFdv(mint, lp, fdv) {
    const token = this.tokens.get(mint);
    if (!token) return;

    const history = token.lpFdvHistory || [];
    history.push({ lp, fdv, ts: Date.now() });

    // 只保留最近 N 条
    if (history.length > HISTORY_MAX) history.shift();

    this.tokens.set(mint, { ...token, lpFdvHistory: history });
  }

  /**
   * 获取稳定读数（用于退出判断 & webhook 触发）
   *
   * 返回条件：历史中存在两条记录，时间间隔 >= 5 分钟
   * 返回最新的那条（经过时间验证的稳定值）
   *
   * 如果没有足够的历史，返回 null（表示"数据未稳定，先不判断"）
   */
  getStableReading(mint) {
    const token = this.tokens.get(mint);
    if (!token) return null;

    const history = token.lpFdvHistory || [];
    if (history.length < 2) return null;

    // 找最新一条和它之前间隔 >= 5 分钟的最近一条
    const latest = history[history.length - 1];
    for (let i = history.length - 2; i >= 0; i--) {
      if (latest.ts - history[i].ts >= STABLE_INTERVAL_MS) {
        // 找到了，返回最新读数作为稳定值
        return { lp: latest.lp, fdv: latest.fdv, ts: latest.ts };
      }
    }

    // 所有历史都在 5 分钟内，数据还太新，不作判断
    return null;
  }

  /**
   * 获取最新一条读数（不管稳定性，用于展示）
   */
  getLatestReading(mint) {
    const token = this.tokens.get(mint);
    if (!token) return null;
    const history = token.lpFdvHistory || [];
    return history.length > 0 ? history[history.length - 1] : null;
  }

  remove(mint) {
    this.tokens.delete(mint);
  }

  getAll() {
    return Array.from(this.tokens.values())
      .sort((a, b) => b.addedAt - a.addedAt);
  }

  size() {
    return this.tokens.size;
  }
}

module.exports = { TokenStore, STABLE_INTERVAL_MS };
