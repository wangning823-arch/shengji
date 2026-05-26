import * as https from 'https';

interface LLMConfig {
  provider?: string;
  apiKey?: string;
  model?: string;
  baseURL?: string;
  timeout?: number;
  headers?: Record<string, string>;
}

interface RequestOptions {
  hostname: string;
  path: string;
  method: string;
  headers: Record<string, string>;
}

export class LLMClient {
  private provider: string;
  private apiKey: string;
  private model: string;
  private baseURL: string | undefined;
  private timeout: number;
  private customHeaders: Record<string, string>;

  constructor(config: LLMConfig) {
    this.provider = config.provider || 'anthropic';
    this.apiKey = config.apiKey || '';
    this.model = config.model || '';
    this.baseURL = config.baseURL;
    this.timeout = config.timeout || 30000;
    this.customHeaders = config.headers || {};

    // 如果provider是custom，必须提供baseURL
    if (this.provider === 'custom' && !this.baseURL) {
      throw new Error('Custom provider requires baseURL');
    }
  }

  async complete(prompt: string, options: Record<string, any> = {}): Promise<string> {
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

  private async callAnthropic(prompt: string, options: Record<string, any> = {}): Promise<string> {
    const data = JSON.stringify({
      model: options.model || this.model || 'claude-3-haiku-20240307',
      max_tokens: options.maxTokens || 2048,
      messages: [{
        role: 'user',
        content: prompt
      }],
      temperature: options.temperature || 0.7
    });

    const url = this.baseURL ? new URL(this.baseURL) : null;

    return this.makeRequest({
      hostname: url?.hostname || 'api.anthropic.com',
      path: url?.pathname || '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
        ...this.customHeaders
      }
    }, data, (body: string) => {
      const result = JSON.parse(body);
      return result.content?.[0]?.text || result.response || result.output || result.message || body;
    });
  }

  private async callOpenAI(prompt: string, options: Record<string, any> = {}): Promise<string> {
    const data = JSON.stringify({
      model: options.model || this.model || 'gpt-4o-mini',
      messages: [{
        role: 'user',
        content: prompt
      }],
      max_tokens: options.maxTokens || 2048,
      temperature: options.temperature || 0.7
    });

    const url = this.baseURL ? new URL(this.baseURL) : null;

    return this.makeRequest({
      hostname: url?.hostname || 'api.openai.com',
      path: url?.pathname || '/v1/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
        ...this.customHeaders
      }
    }, data, (body: string) => {
      const result = JSON.parse(body);
      const msg = result.choices?.[0]?.message;
      return msg?.content || msg?.reasoning_content || result.response || result.output || body;
    });
  }

  private async callCustom(prompt: string, options: Record<string, any> = {}): Promise<string> {
    const url = new URL(this.baseURL!);

    // 默认用OpenAI兼容格式，也可以自定义
    const data = options.body || JSON.stringify({
      model: options.model || this.model,
      messages: [{
        role: 'user',
        content: prompt
      }],
      max_tokens: options.maxTokens || 2048,
      temperature: options.temperature || 0.7
    });

    const headers: Record<string, string> = {
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
    }, data, (body: string) => {
      try {
        const result = JSON.parse(body);
        const msg = result.choices?.[0]?.message;
        // 尝试各种常见的响应格式（包括推理模型的reasoning_content）
        return msg?.content
            || msg?.reasoning_content
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

  private makeRequest(options: RequestOptions, data: string, parser: (body: string) => string): Promise<string> {
    return new Promise((resolve, reject) => {
      const req = https.request(options, (res) => {
        let body = '';
        res.on('data', (chunk: Buffer) => body += chunk);
        res.on('end', () => {
          try {
            if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
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
