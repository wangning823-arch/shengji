const https = require('https');

class LLMClient {
  constructor(config) {
    this.provider = config.provider || 'anthropic';
    this.apiKey = config.apiKey;
    this.model = config.model;
    this.baseURL = config.baseURL; // 支持自定义URL
    this.timeout = config.timeout || 30000;
    this.customHeaders = config.headers || {};

    // 如果provider是custom，必须提供baseURL
    if (this.provider === 'custom' && !this.baseURL) {
      throw new Error('Custom provider requires baseURL');
    }
  }

  async complete(prompt, options = {}) {
    if (this.provider === 'anthropic') {
      return this.callAnthropic(prompt, options);
    } else if (this.provider === 'openai') {
      return this.callOpenAI(prompt, options);
    } else if (this.provider === 'custom') {
      return this.callCustom(prompt, options);
    } else {
      throw new Error('Unsupported LLM provider: ' + this.provider);
    }
  }

  async callAnthropic(prompt, options = {}) {
    const data = JSON.stringify({
      model: options.model || this.model || 'claude-3-haiku-20240307',
      max_tokens: options.maxTokens || 1024,
      messages: [{
        role: 'user',
        content: prompt
      }],
      temperature: options.temperature || 0.7
    });

    const url = this.baseURL ? new URL(this.baseURL) : { hostname: 'api.anthropic.com', path: '/v1/messages' };

    return this.makeRequest({
      hostname: url.hostname || 'api.anthropic.com',
      path: url.pathname || '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
        ...this.customHeaders
      }
    }, data, (body) => {
      const result = JSON.parse(body);
      return result.content?.[0]?.text || result.response || result.output || result.message || body;
    });
  }

  async callOpenAI(prompt, options = {}) {
    const data = JSON.stringify({
      model: options.model || this.model || 'gpt-4o-mini',
      messages: [{
        role: 'user',
        content: prompt
      }],
      max_tokens: options.maxTokens || 1024,
      temperature: options.temperature || 0.7
    });

    const url = this.baseURL ? new URL(this.baseURL) : { hostname: 'api.openai.com', path: '/v1/chat/completions' };

    return this.makeRequest({
      hostname: url.hostname || 'api.openai.com',
      path: url.pathname || '/v1/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
        ...this.customHeaders
      }
    }, data, (body) => {
      const result = JSON.parse(body);
      return result.choices?.[0]?.message?.content || result.response || result.output || body;
    });
  }

  async callCustom(prompt, options = {}) {
    const url = new URL(this.baseURL);

    // 默认用OpenAI兼容格式，也可以自定义
    const data = options.body || JSON.stringify({
      model: options.model || this.model,
      messages: [{
        role: 'user',
        content: prompt
      }],
      max_tokens: options.maxTokens || 1024,
      temperature: options.temperature || 0.7
    });

    const headers = {
      'Content-Type': 'application/json',
      ...this.customHeaders
    };

    if (this.apiKey) {
      headers['Authorization'] = `Bearer ${this.apiKey}`;
    }

    return this.makeRequest({
      hostname: url.hostname,
      path: url.pathname,
      method: 'POST',
      headers
    }, data, (body) => {
      try {
        const result = JSON.parse(body);
        // 尝试各种常见的响应格式
        return result.choices?.[0]?.message?.content
            || result.content?.[0]?.text
            || result.response
            || result.output
            || result.message
            || result.answer
            || body;
      } catch {
        return body;
      }
    });
  }

  makeRequest(options, data, parser) {
    return new Promise((resolve, reject) => {
      const req = https.request(options, (res) => {
        let body = '';
        res.on('data', (chunk) => body += chunk);
        res.on('end', () => {
          try {
            if (res.statusCode >= 200 && res.statusCode < 300) {
              resolve(parser(body));
            } else {
              reject(new Error(`LLM API error: ${res.statusCode} - ${body}`));
            }
          } catch (e) {
            reject(e);
          }
        });
      });

      req.on('error', reject);
      req.setTimeout(this.timeout, () => {
        req.destroy();
        reject(new Error('LLM request timeout'));
      });

      req.write(data);
      req.end();
    });
  }
}

module.exports = { LLMClient };
