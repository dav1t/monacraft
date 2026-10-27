# monacraft

A Minecraft agent: an LLM plays as a bot on a Minecraft server. It observes the world, calls tools to act, remembers what happened, plans crafting chains, and writes its own reusable skills.

## Requirements

- Node.js 22.13+ and pnpm
- A Minecraft Java server (1.21.11) with `online-mode=false` and `spawn-protection=0`
- An LLM: Anthropic, any OpenAI-compatible API (OpenAI, OpenRouter, LM Studio, llama.cpp…), or a local model via Ollama

## Quick start

```bash
cp .env.example .env    # set LLM_PROVIDER and its model/key
pnpm install
pnpm panel              # web panel at http://127.0.0.1:3000
pnpm start              # or headless, using .env
```

Join the server with your Minecraft client to interact with the bot (use creative or survival; spectators are invisible to the bot).

## Web panel

Live bot status, an editable goal tree, the model's reasoning feed, **Revelations** (top-priority guidance you write for the bot), a sleep journal, logs, a database editor, and settings for the server and LLM provider (switchable while running). Panel settings, including API keys, are saved to `data/panel.json`.

## Configuration

See `.env.example`. Main options:

- `LLM_PROVIDER`: `anthropic`, `openai` or `ollama`
- `ANTHROPIC_MODEL`, `ANTHROPIC_API_KEY`, `ANTHROPIC_EFFORT`
- `OPENAI_BASE_URL`, `OPENAI_MODEL`, `OPENAI_API_KEY`
- `OLLAMA_MODEL`, `OLLAMA_MODE` (`tools` or `json`), `OLLAMA_THINK`, `OLLAMA_NUM_CTX`

All agent state (memory, skills, goals, journal) lives in `data/agent.db`. Delete it to reset.

## Development

```bash
pnpm test
pnpm typecheck
pnpm panel:dev    # panel with UI hot reload
```
