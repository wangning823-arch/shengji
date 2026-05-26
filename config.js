module.exports = {
  llm: {
    provider: 'openai',
    apiKey: '', // 留空=纯规则AI
    model: 'doubao-seed-2.0-pro',
    baseURL: 'https://ark.cn-beijing.volces.com/api/coding/v3/chat/completions',
    timeout: 30000
  }
};
