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
pnpm panel                    # builds the UI, then serves the web panel at http://127.0.0.1:3000
pnpm start                    # or: headless, settings from .env, logs in the terminal
```

## Web panel

`pnpm panel` builds the UI (Svelte + Vite, source in `ui/`) and starts a Minecraft-styled control panel. While working on the UI, run `pnpm panel:dev` instead: Vite runs inside the panel server with hot reload.

The panel (bound to `127.0.0.1:3000`, change with `PANEL_HOST`/`PANEL_PORT`):

- **Bot**: health, hunger, XP, position, armor, inventory and nearby mobs, live. The **Mind** feed streams the model's reasoning and text as it is written, then the chosen tool and its outcome.
- **Revelations**: guidance you write for the bot. Revelations sit at the top of every prompt as highest priority until you remove them; adding one interrupts the current action so the bot reconsiders. The goal can be edited here too.
- **Logs**: everything the headless mode prints, with a filter.
- **Database**: view, edit and delete memory, skills and history.
- **Settings**: server address, port, username and version (Join Server / Disconnect), and the brain: Ollama, any OpenAI-compatible server, or Anthropic. Applying brain settings switches provider while the bot runs, starting with the next decision.

`.env` only provides the panel's defaults; what you enter in the panel is saved to `data/panel.json` (API keys included, so keep `data/` private; it is gitignored). Keys are never sent back to the browser.

Do not run the panel bot and a headless bot with the same username on one server: the second login kicks the first.

## Switching models

- `LLM_PROVIDER` picks `ollama` (default), `openai` (any OpenAI-compatible server: `OPENAI_BASE_URL`, `OPENAI_MODEL`, `OPENAI_API_KEY`) or `anthropic` (`ANTHROPIC_MODEL`, default `claude-opus-5-5`; `ANTHROPIC_EFFORT`; `ANTHROPIC_API_KEY`).

- `OLLAMA_MODEL` selects the model (default `qwen3:8b`).
- `OLLAMA_MODE=json` for models without tool support, such as `gemma3:4b`. `tools` (default) uses native tool calling.
- `OLLAMA_THINK` sets thinking: `true`/`false`, or `low`/`medium`/`high` for gpt-oss. Thinking is smarter but much slower, so it defaults to `false`.
- `OLLAMA_NUM_CTX` sets the context window in tokens (integer >= 2048, default `8192`). Ollama's own default of 4096 truncates the prompt.

## Data

The agent's memory, learned skills, history and revelations live in `data/agent.db` (override with `DB_PATH`). Delete it to reset everything.

## Development

- `pnpm test`: run the test suite
- `pnpm typecheck`: type-check the server and the UI's TypeScript modules (TypeScript 7; `.svelte` files are compiled by Vite but not type-checked, since svelte-check does not support TypeScript 7 yet)
