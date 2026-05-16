// LLM AI配置示例
// 复制此文件为 config.js 并填入你的API Key

module.exports = {
  llm: {
    // 选择提供商：'anthropic', 'openai', 或 'custom'
    provider: 'anthropic',

    // 你的API Key
    apiKey: 'your_api_key_here',

    // 模型选择（任意模型名称都支持）
    model: 'claude-3-haiku-20240307',

    // 自定义API URL（可选，用于自定义模型或代理）
    // baseURL: 'https://api.example.com/v1/chat',

    // 自定义请求头（可选）
    // headers: {
    //   'Authorization': 'Bearer ...',
    //   'X-Custom-Header': 'value'
    // },

    // 超时时间（毫秒）
    timeout: 30000
  }
};

/*
配置示例：

1. 使用Anthropic Claude:
{
  provider: 'anthropic',
  apiKey: 'sk-ant-...',
  model: 'claude-3-haiku-20240307'
}

2. 使用OpenAI GPT:
{
  provider: 'openai',
  apiKey: 'sk-...',
  model: 'gpt-4o-mini'
}

3. 使用自定义模型（兼容OpenAI格式）:
{
  provider: 'custom',
  apiKey: 'your_key',
  model: 'your-model-name',
  baseURL: 'https://your-api.com/v1/chat/completions'
}

4. 不配置（使用规则AI，不需要API Key）:
直接删除 config.js 或不填 apiKey
*/

