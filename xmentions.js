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
   * 获取合约地址在过去24小时的 X 提及数
   * @param {string} symbol      代币符号（仅用于日志）
   * @param {string} mintAddress 合约地址（唯一搜索关键字）
   * @returns {number|null}
   */
  async getMentions(symbol, mintAddress) {
    if (!this.bearerToken) {
      console.warn('[X] No bearer token configured, skipping');
      return null;
    }
    if (!mintAddress) {
      console.warn(`[X] No mint address for ${symbol}, skipping`);
      return null;
    }

    try {
      const query = this._buildQuery(mintAddress);

      const now = new Date();
      const start = new Date(now.getTime() - 24 * 60 * 60 * 1000);

      const params = {
        query,
        granularity: 'hour',
        start_time: start.toISOString(),
        end_time: now.toISOString(),
      };

      const proxyCfg = await this.proxy.getAxiosConfig();

      const reqConfig = {
        headers: {
          Authorization: `Bearer ${this.bearerToken}`,
        },
        params,
        timeout: 20000,
        ...(proxyCfg || {}),
      };

      const res = await axios.get(
        `${this.baseUrl}/tweets/counts/recent`,
        reqConfig
      );

      const total = res.data?.meta?.total_tweet_count ?? 0;
      console.log(`[X] $${symbol} (${mintAddress.slice(0,8)}...) mentions: ${total}`);
      return total;

    } catch (err) {
      this._handleError(err, symbol);
      return null;
    }
  }

  /**
   * 以合约地址为唯一关键字构建搜索 query
   * 完整地址用引号包裹，确保精确匹配，排除转推
   */
  _buildQuery(mintAddress) {
    // 用完整合约地址做精确匹配，加引号防止被拆分
    return `"${mintAddress}" -is:retweet`;
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
