const axios = require('axios');
const { WebshareProxyManager } = require('./proxy');

/**
 * X (Twitter) mentions service
 * Uses GET /2/tweets/counts/recent — cheapest endpoint (~$0.005/req)
 *
 * 支持通过 Webshare 代理访问，解决腾讯云 IP 被 X 封锁问题。
 */

class XMentionsService {
  constructor(bearerToken) {
    this.bearerToken = bearerToken;
    this.baseUrl = 'https://api.twitter.com/2';

    // 初始化代理管理器（从环境变量读取配置）
    this.proxy = new WebshareProxyManager();
  }

  /**
   * 获取 symbol/合约 在过去24小时的 X 提及数
   * @param {string} symbol     代币符号，如 "BONK"
   * @param {string} mintAddress 合约地址
   * @returns {number|null}
   */
  async getMentions(symbol, mintAddress) {
    if (!this.bearerToken) {
      console.warn('[X] No bearer token configured, skipping');
      return null;
    }

    try {
      const query = this._buildQuery(symbol, mintAddress);
      if (!query) return null;

      const now = new Date();
      const start = new Date(now.getTime() - 24 * 60 * 60 * 1000);

      const params = {
        query,
        granularity: 'hour',
        start_time: start.toISOString(),
        end_time: now.toISOString(),
      };

      // 获取代理配置（失败时为 null，退化为直连）
      const proxyCfg = await this.proxy.getAxiosConfig();

      const reqConfig = {
        headers: {
          Authorization: `Bearer ${this.bearerToken}`,
        },
        params,
        timeout: 20000,
        ...(proxyCfg || {}),  // 展开代理配置（httpsAgent + proxy:false）
      };

      const res = await axios.get(
        `${this.baseUrl}/tweets/counts/recent`,
        reqConfig
      );

      const total = res.data?.meta?.total_tweet_count ?? 0;
      return total;

    } catch (err) {
      this._handleError(err, symbol);
      return null;
    }
  }

  _buildQuery(symbol, mintAddress) {
    let query = '';

    if (symbol && symbol !== '???' && symbol.length > 1) {
      // 搜索 $SYMBOL 或 #SYMBOL
      query = `($${symbol} OR #${symbol})`;
      // 同时搜索合约地址前缀（增加命中率）
      if (mintAddress) {
        const shortMint = mintAddress.slice(0, 8);
        query += ` OR "${shortMint}"`;
      }
    } else if (mintAddress) {
      query = `"${mintAddress}"`;
    } else {
      return null;
    }

    // 排除转推，减少噪音
    query += ' -is:retweet';
    return query;
  }

  _handleError(err, symbol) {
    const status = err.response?.status;
    if (status === 401) {
      console.error('[X] 401 Unauthorized — Bearer Token 无效或已过期');
    } else if (status === 403) {
      console.error('[X] 403 Forbidden — 你的 X 计划不支持此 endpoint（需要 Basic+）');
    } else if (status === 429) {
      console.warn(`[X] 429 Rate Limited — ${symbol} 稍后重试`);
    } else if (err.code === 'ECONNREFUSED' || err.code === 'ETIMEDOUT') {
      console.error(`[X] 连接失败 (${err.code}) — 代理可能不可用`);
    } else if (err.code === 'ECONNRESET') {
      console.error(`[X] 连接被重置 — 代理或 X API 拒绝了请求`);
    } else {
      console.error(`[X] getMentions(${symbol}) error:`, err.message);
    }
  }

  /**
   * 测试代理连通性（启动时调用）
   */
  async testProxyConnection() {
    if (!this.proxy.enabled) {
      console.log('[X] No proxy configured, will connect direct');
      return { ok: false, error: 'not configured' };
    }
    console.log('[X] Testing proxy connection to Twitter...');
    const result = await this.proxy.testProxy();
    if (result.ok) {
      console.log(`[X] Proxy OK — exit IP: ${result.ip}`);
    } else {
      console.warn(`[X] Proxy test failed: ${result.error}`);
      console.warn('[X] Will attempt direct connection as fallback');
    }
    return result;
  }
}

module.exports = { XMentionsService };
