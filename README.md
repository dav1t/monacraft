# mindfart

A Minecraft agent: a local LLM (via Ollama) plays as a bot on a Minecraft server. It observes the world, calls tools to act, remembers what happened, and can write its own reusable skills.

## Prerequisites

1. **Java 21:** `winget install EclipseAdoptium.Temurin.21.JDK`, then open a new terminal and check `java -version` (expect 21.x).
2. **Server** (folder `server/`, gitignored):
   ```powershell
   New-Item -ItemType Directory -Force server; Set-Location server
   Invoke-WebRequest https://piston-data.mojang.com/v1/objects/64bb6d763bed0a9f1d632ec347938594144943ed/server.jar -OutFile server.jar
   java -Xmx2G -jar server.jar --nogui   # first run writes eula.txt and exits
   ```
   - `eula.txt`: `eula=true`
   - `server.properties`: `online-mode=false`, `spawn-protection=0` (otherwise the non-op bot cannot break blocks near spawn), `difficulty=easy`
   - Start: `java -Xmx2G -jar server.jar --nogui`
3. **Model:** `ollama pull qwen3:8b` (tool-capable, fits the 8 GB GTX 1070).
4. **Client:** Minecraft launcher → installation for **1.21.11** → Multiplayer → `localhost`. In the server console: `op <your name>`, then in game `/gamemode creative` (or survival) to interact with the bot. Spectator mode is only for watching: a vanilla server does not send spectators to other clients, so the bot cannot see or follow you.

## Setup

```bash
cp .env.example .env          # PowerShell: Copy-Item .env.example .env
pnpm install
pnpm start
```

## Switching models

- `OLLAMA_MODEL` selects the model (default `qwen3:8b`).
- `OLLAMA_MODE=json` for models without tool support, such as `gemma3:4b`. `tools` (default) uses native tool calling.
- `OLLAMA_THINK` sets thinking: `true`/`false`, or `low`/`medium`/`high` for gpt-oss. Thinking is smarter but much slower, so it defaults to `false`.
- `OLLAMA_NUM_CTX` sets the context window in tokens (integer >= 2048, default `8192`). Ollama's own default of 4096 truncates the prompt.

## Data

The agent's memory and learned skills live in `data/agent.db` (override with `DB_PATH`). Delete it to reset memory and skills.

## Development

- `pnpm test`: run the test suite
- `pnpm typecheck`: type-check the project
