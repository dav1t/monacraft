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

- **Bot**: health, hunger, XP, position, armor, inventory and nearby mobs, live. The **goal tree** (goal → sub-goals → steps of the active sub-goal) can be edited: set a new goal, rename, mark done, drop, add sub-goals and steps. The **Mind** feed streams the model's reasoning and text as it is written, then the chosen tool and its outcome. The top bar shows the size of the last prompt.
- **Revelations**: guidance you write for the bot. Revelations sit at the top of every prompt as highest priority until you remove them; adding one interrupts the current action so the bot reconsiders. The goal can be edited here too. Revelations are never trimmed, so the page warns when they pass 1500 characters.
- **Journal**: one entry per sleep or nap, the lessons the bot learned (add your own; sleep keeps them), and skills flagged for review. **Nap now** makes the bot reflect right away.
- **Logs**: everything the headless mode prints, with a filter.
- **Database**: view, edit and delete memory (pin facts so sleep never changes them), skills, plan templates and history.
- **Settings**: server address, port, username and version (Join Server / Disconnect), and the brain: Ollama, any OpenAI-compatible server, or Anthropic. Applying brain settings switches provider while the bot runs, starting with the next decision.

`.env` only provides the panel's defaults; what you enter in the panel is saved to `data/panel.json` (API keys included, so keep `data/` private; it is gitignored). Keys are never sent back to the browser.

Do not run the panel bot and a headless bot with the same username on one server: the second login kicks the first.

## Planning and sleep

- **Planner** (`src/planning/`): exact crafting chains from minecraft-data, with counts, crafting stations, required tool tiers, smelting, and time estimates from real dig times. It also checks whether making a faster tool first pays off. The bot asks it with `plan_item`.
- **Goal tree**: `set_goal` with an item name ("get iron_pickaxe") builds sub-goals and steps from the planner without a model call; other goals are split by the model with `plan_goal` / `set_steps`. Craft, mine, smelt and place steps tick off by themselves; sub-goals finish when their item is in the inventory. Completed non-crafting plans are saved as templates and offered for similar goals.
- **Sleep**: at dusk the bot is told to sleep (`sleep` tool: walks to a bed within 64 blocks or places a carried one). When it lies down, or at night anyway, the agent loop pauses (reflexes keep running) and one reflection call writes a journal, rewrites the lessons and tidies memory and goals. The next day starts with a fresh history; the prompt only carries the last journal, ≤ 10 lessons, ≤ 20 memory facts, ≤ 8 relevant skills and today's last 15 history entries. A nap does the same during the day when the history or the prompt grows too long.

- **Building and remembering**: `build` puts up a whole shelter, wall, floor or pillar from one block type (code does the geometry, checks the inventory first, never digs through its own walls, and resumes an interrupted build by name). What it builds is stored in the `structures` table and shown to the bot as "Built"; a building goal can only be marked done once a build completes. Fighting uses mineflayer-pvp (hits timed to the attack cooldown, shield against creepers); mineflayer-armor-manager puts on the best armor picked up, crafted or carried at spawn. `recall` searches older history, journals, memory, lessons and structures by keyword.

## Switching models

- `LLM_PROVIDER` picks `ollama` (default), `openai` (any OpenAI-compatible server: `OPENAI_BASE_URL`, `OPENAI_MODEL`, `OPENAI_API_KEY`) or `anthropic` (`ANTHROPIC_MODEL`, default `claude-opus-5-5`; `ANTHROPIC_EFFORT`; `ANTHROPIC_API_KEY`).

- `OLLAMA_MODEL` selects the model (default `qwen3:8b`).
- `OLLAMA_MODE=json` for models without tool support, such as `gemma3:4b`. `tools` (default) uses native tool calling.
- `OLLAMA_THINK` sets thinking: `true`/`false`, or `low`/`medium`/`high` for gpt-oss (qwen3 only knows on/off; a level means on). Thinking is smarter but much slower, so it defaults to `false`.
- `OLLAMA_NUM_CTX` sets the context window in tokens (integer >= 2048, default `8192`). Ollama's own default of 4096 truncates the prompt.
- Faster Ollama (settings of the Ollama server, not of this project): `setx OLLAMA_FLASH_ATTENTION 1` and `setx OLLAMA_KV_CACHE_TYPE q8_0`, then quit Ollama from the tray and start it again. The cache then takes half the memory, so a bigger `OLLAMA_NUM_CTX` fits. The bot asks Ollama to keep the model loaded for 30 minutes between requests, and its prompt puts the parts that rarely change first so Ollama can reuse its cache.

## Data

The agent's memory, learned skills, history, revelations, goals, plan templates, journal and lessons live in `data/agent.db` (override with `DB_PATH`). Delete it to reset everything.

## Development

- `pnpm test`: run the test suite
- `pnpm typecheck`: type-check the server and the UI's TypeScript modules (TypeScript 7; `.svelte` files are compiled by Vite but not type-checked, since svelte-check does not support TypeScript 7 yet)
