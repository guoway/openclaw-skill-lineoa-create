# LLM Provider Configurations

This guide covers configuration for various OpenAI-compatible API providers.

## Moonshot AI

```bash
OPENAI_BASE_URL=https://api.moonshot.cn/v1
LLM_MODEL=moonshot-v1-8k
```

Available models:
- `moonshot-v1-8k`
- `moonshot-v1-32k`
- `moonshot-v1-128k`

Get API key: https://platform.moonshot.cn/

## Zaiku

```bash
OPENAI_BASE_URL=https://api.zaiku.ai/v1
LLM_MODEL=zaiku-1
```

## Google Gemini

```bash
OPENAI_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai/
LLM_MODEL=gemini-1.5-flash
```

Available models:
- `gemini-1.5-flash` (fast, cost-effective)
- `gemini-1.5-pro` (higher quality)

Get API key: https://aistudio.google.com/app/apikey

## OpenAI

```bash
OPENAI_BASE_URL=https://api.openai.com/v1
LLM_MODEL=gpt-4o-mini
```

Available models:
- `gpt-4o`
- `gpt-4o-mini`
- `gpt-3.5-turbo`

## OpenRouter

```bash
OPENAI_BASE_URL=https://openrouter.ai/api/v1
LLM_MODEL=anthropic/claude-3.5-sonnet
```

Available models (examples):
- `anthropic/claude-3.5-sonnet`
- `google/gemini-pro-1.5`
- `moonshot-ai/moonshot-v1-8k`

Get API key: https://openrouter.ai/keys

## Local Models (Ollama)

```bash
OPENAI_BASE_URL=http://host.docker.internal:11434/v1
LLM_MODEL=llama3.1
```

Make sure Ollama is running on your host machine.

## Testing Your Configuration

After setting up `.env`, test the connection:

```bash
cd line-webhook
docker-compose run --rm webhook node -e "
const axios = require('axios');
axios.post(process.env.OPENAI_BASE_URL + '/chat/completions', {
    model: process.env.LLM_MODEL,
    messages: [{role: 'user', content: 'Hello'}]
}, {
    headers: { 'Authorization': 'Bearer ' + process.env.OPENAI_API_KEY }
}).then(r => console.log('OK:', r.data.choices[0].message.content))
.catch(e => console.error('Error:', e.message));
"
```
