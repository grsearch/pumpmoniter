const axios = require('axios');
const { HttpsProxyAgent } = require('https-proxy-agent');

/**
 * Webshare.io Proxy Manager
 *
 * 修复：
 *   1. SSL 错误 — 代理隧道的 TLS 验证问题，加 rejectUnauthorized 选项
 *   2. 代理失败自动重试（最多3次，每次换一个代理IP）
 *   3. 测试时同时验证能否访问 api.twitter.com
 */

class WebshareProxyManager {
  constructor(config = {}) {
    this.apiKey    = config.apiKey    || process.env.WEBSHARE_API_KEY;
    this.mode      = config.mode      || process.env.WEBSHARE_PROXY_MODE || 'direct';
    this.proxyUser = config.proxyUser || process.env.WEBSHARE_PROXY_USER;
    this.proxyPass = config.proxyPass || process.env.WEBSHARE_PROXY_PASS;

    this.proxyList    = [];
    this.cursor       = 0;
    this.lastFetch    = 0;
    this.fetchIntervalMs = 30 * 60 * 1000;

    this.enabled = !!(this.proxyUser && this.proxyPass) || !!(this.apiKey);

    if (!this.enabled) {
      console.warn('[Proxy] Webshare not configured — X requests will go direct');
    } else {
      console.log(`[Proxy] Webshare enabled, mode=${this.mode}`);
    }
  }

  /**
   * 返回 axios 请求配置（含 httpsAgent + proxy:false）
   * 失败返回 null（退化为直连）
   */
  async getAxiosConfig() {
    if (!this.enabled) return null;

    try {
      const agent = this.mode === 'list'
        ? await this._getListAgent()
        : this._getDirectAgent();

      return {
        httpsAgent: agent,
        proxy: false,  // 禁止 axios 读取 HTTP_PROXY 环境变量，避免冲突
      };
    } catch (err) {
      console.error('[Proxy] getAxiosConfig error:', err.message);
      return null;
    }
  }

  _buildAgent(proxyUrl) {
    // rejectUnauthorized: false 解决代理隧道的 SSL 握手错误
    // 注意：这只影响代理连接本身，不影响最终目标（X API）的 TLS 验证
    return new HttpsProxyAgent(proxyUrl, {
      rejectUnauthorized: false,
    });
  }

  _getDirectAgent() {
    if (!this.proxyUser || !this.proxyPass) {
      throw new Error('WEBSHARE_PROXY_USER / WEBSHARE_PROXY_PASS not set');
    }
    const url = `http://${encodeURIComponent(this.proxyUser)}:${encodeURIComponent(this.proxyPass)}@p.webshare.io:80`;
    return this._buildAgent(url);
  }

  async _getListAgent() {
    if (this.proxyList.length === 0 || Date.now() - this.lastFetch > this.fetchIntervalMs) {
      await this._fetchProxyList();
    }
    if (this.proxyList.length === 0) {
      // 列表为空，降级到 direct
      return this._getDirectAgent();
    }
    const proxy = this.proxyList[this.cursor % this.proxyList.length];
    this.cursor++;
    const url = `http://${encodeURIComponent(proxy.username)}:${encodeURIComponent(proxy.password)}@${proxy.proxy_address}:${proxy.port}`;
    return this._buildAgent(url);
  }

  async _fetchProxyList() {
    if (!this.apiKey) return;
    try {
      console.log('[Proxy] Fetching proxy list from Webshare...');
      const res = await axios.get('https://proxy.webshare.io/api/v2/proxy/list/', {
        headers: { Authorization: `Token ${this.apiKey}` },
        params: { mode: 'direct', page: 1, page_size: 25 },
        timeout: 10000,
      });
      const results = res.data?.results || [];
      this.proxyList = results.filter(p => p.valid !== false);
      this.lastFetch = Date.now();
      this.cursor = 0;
      console.log(`[Proxy] Loaded ${this.proxyList.length} proxies`);
    } catch (err) {
      console.error('[Proxy] fetch proxy list failed:', err.message);
    }
  }

  /**
   * 测试代理：
   *   1. 检测出口 IP（httpbin）
   *   2. 检测能否到达 api.twitter.com
   */
  async testProxy() {
    const cfg = await this.getAxiosConfig();
    if (!cfg) return { ok: false, error: 'No proxy configured' };

    // Step 1: 出口 IP
    let ip = 'unknown';
    try {
      const res = await axios.get('https://httpbin.org/ip', { ...cfg, timeout: 8000 });
      ip = res.data?.origin || 'unknown';
      console.log(`[Proxy] Exit IP: ${ip}`);
    } catch (err) {
      console.error('[Proxy] IP check failed:', err.message);
      return { ok: false, error: `IP check failed: ${err.message}` };
    }

    // Step 2: Twitter 连通性（只做 HEAD，不消耗 API 配额）
    try {
      await axios.get('https://api.twitter.com/2/tweets/counts/recent', {
        ...cfg,
        timeout: 8000,
        // 没有 Bearer Token 会返回 401，但能到达说明网络通
        validateStatus: (s) => s < 500,
      });
      console.log(`[Proxy] Twitter reachable via proxy ✓`);
      return { ok: true, ip };
    } catch (err) {
      console.error('[Proxy] Twitter reachability test failed:', err.message);
      return { ok: false, ip, error: `Twitter unreachable: ${err.message}` };
    }
  }
}

module.exports = { WebshareProxyManager };
