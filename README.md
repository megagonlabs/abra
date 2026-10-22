# ABRA: Agent-Bound Readable interActions

ABRA is a reference prototype of **Agent-Bound UI**, the interaction model introduced in *[ABRA: Agent-Bound UI for Human–Agent Communication beyond Chat with Reusable Views](https://megagon.ai/publications/abra-shared-interaction-semantics-ai-agents/) (EMNLP 2026, System Demonstrations).* Agents and users collaborate over a fixed set of reusable views (graph, table, text, display); an agent binds task-specific meanings to the interactions a view offers and publishes those bindings as shared canvas state, so people and other agents can read what an interaction will mean before performing it.

This repository has three parts:

- **Canvas model** (`packages/`): the four views, the canvas and message schema, and the reducer that applies every update.
- **Hub and client** (`apps/`): the system prototype, a Node.js hub that maintains canvas state and synchronizes updates among participants, and a web client (Vite + React) with the chat panel and the canvases.
- **Agents** (`adapters/`): example Python agents, defined in `adapters/roster.toml` (model, tools, prompt) along with which ones join a session by default.

This README covers running and configuring the prototype; the interaction model is described in the paper.

## 🎬 Demo Video

[![Demo video](https://img.youtube.com/vi/ik-6EX0dn_M/maxresdefault.jpg)](https://www.youtube.com/watch?v=ik-6EX0dn_M)

▶ [Watch the demo video](https://www.youtube.com/watch?v=ik-6EX0dn_M) (2:43).

## 🚀 Quickstart

**Prerequisites.** Node.js ≥ 24 (with [`corepack`](https://nodejs.org/api/corepack.html) for pnpm) and Python ≥ 3.11 (with [`uv`](https://docs.astral.sh/uv/getting-started/installation/)).

```bash
# 1. Install the JS workspace and the Python adapters
corepack enable && pnpm install
uv venv && uv pip install -e ".[dev,agent]"

# 2. Configure (the default agents run on Anthropic; see "API Keys" below)
export ANTHROPIC_API_KEY="sk-ant-..."

# 3. Run the whole demo from one command (Ctrl-C stops all three processes)
pnpm demo
```

`pnpm demo` starts the hub (`ws://localhost:8787`), the agent host, and the UI, then prints the UI's URL. Open it in your browser.

## 🖥️ Using it

- **A browser tab is one session.** Its id is the `?s=…` in the URL. The agent host adds the default agents (**Researcher**, **Analyst**, **Curator**) to each session automatically.
- **Open another tab for a separate, isolated session** (its own agents, its own canvases). Share a tab's URL to collaborate in the *same* session, or use **Start fresh** in the top bar to mint a clean session in the current tab.
- **Type in the chat panel.** The agents answer you, reply when you `@mention` them, and create canvases on request. On a canvas you can act directly (on a graph: reposition, connect, drag-to-merge; on a table: edit cells); hover a canvas's info affordance to read what each action does. If an agent adds controls to a canvas (buttons, toggles), they appear in that canvas's header.
- **A first message to try:** *"Let's map the 2022 World Cup knockout stage: a results table, a bracket graph, and a gallery of the key players."* The agents reply in chat and open canvases for what they build; hover a team in one canvas to see it highlighted in the others.
- **Follow the links between views.** Hovering an element highlights the same entity across the other open canvases (brushing-and-linking); an agent's chat message can carry `{ref}` chips that, on hover, light up the exact element they point to.
- **Add or remove agents live.** The participants popover lists who is in the session (with each agent's status: online, working, or crashed); you can remove an agent, restart a crashed one, or add any agent that is defined in `adapters/roster.toml` but not active by default.
- **Arrange the canvases.** A side rail lists the live canvases; toggle each one's visibility (the eye) and reorder them with ↑/↓. This is your own view only (client-local): hiding a canvas does not close it, and the owning agent is unaffected.

## 🔑 API Keys

Set as environment variables before launching. A `.env` file at the repository root is also read by `pnpm demo`, which loads it into the agent host only (the hub and the UI dev server are not given the `.env` values).

- **`ANTHROPIC_API_KEY`**: required by the default agents (all three are Anthropic-backed). Get one at <https://console.anthropic.com/>.
- **`OPENAI_API_KEY`** / **`FIREWORKS_API_KEY`**: only if you enlist OpenAI- or Fireworks-backed agents (see below).
- **`GOOGLE_API_KEY`** + **`GOOGLE_CSE_ID`**: only for the `web_search` custom tool (Google Programmable Search).

**No Anthropic key, only OpenAI?** Switch to OpenAI-backed agents in [`adapters/roster.toml`](adapters/roster.toml): give the `custom` agents `provider = "openai"` (install `.[custom-openai]`), or enlist the `openai_agents_sdk` agent (install `.[openai]`). Set `OPENAI_API_KEY` and run `pnpm demo` as usual.

**No web-search key?** The demo still runs, and you do not need to disable anything. `web_search` is not auto-removed: it stays offered to the agents, and a call without the keys returns an error that the agent recovers from (it falls back to the keyless tools). The other custom tools (Wikipedia, geocoding, calculator, Python, datetime) need no key, and the SDK-based agents (`claude_agent_sdk`, `openai_agents_sdk`) have their own hosted web search that does not use the Google key. To hide it entirely, drop `"web_search"` from the agents' `tools` in [`adapters/roster.toml`](adapters/roster.toml).

## 🧩 Configuring the agents

The roster lives in [`adapters/roster.toml`](adapters/roster.toml). Define agents under `[agents.<key>]` (type, model, prompt, tools, provider, optional one-line `blurb`) and list which of them run in `active`. Defining an agent does not enlist it: only the keys in `active` spawn, so you can keep a library and switch the subset freely. Four agent frameworks ship, each driving the same shared canvases through the tool interface:

| Type | Framework | Extra to install |
|---|---|---|
| `custom` | a minimal tool-calling agent loop (no framework), across providers (`anthropic` / `openai` / `fireworks`) | `.[agent]` (Anthropic) or `.[custom-openai]` (OpenAI-format) |
| `claude_agent_sdk` | the Claude Agent SDK (also needs the Claude Code CLI on `$PATH`) | `.[claude-sdk]` |
| `langgraph` | LangGraph 1.x (a `StateGraph` tool-calling loop) | `.[langgraph]` |
| `openai_agents_sdk` | the OpenAI Agents SDK | `.[openai]` |

To run a **single** agent against one session by hand (the `--session` id is the `?s=…` value from the UI's URL):

```bash
.venv/bin/python -m adapters.run --type custom --name Bob --session <session-id>
```

## ⚠️ Caveats

This is a research prototype meant to run on one machine. Before running it anywhere else, note the following.

- **The hub only accepts local connections.** It listens on `127.0.0.1:8787`, and a browser page can connect only if it was served from localhost (the dev server), so other websites open in your browser cannot reach it. For a demo over a LAN, start the hub with `ABRA_HUB_HOST=0.0.0.0` (it prints a warning), run the UI with `pnpm --filter demo dev --host`, and add the UI's address to `ABRA_ALLOWED_ORIGINS` (comma-separated).
- **The hub does not check who is connecting.** When a client joins, it sends a name and a token; the hub accepts any non-empty token and trusts the name. So anyone who can reach the hub port can join a session as any user or agent. Keep the port on a network you trust.
- **Agents run tools with your permissions.** The `python` tool runs code written by the model in a separate process with an empty environment, a temporary working directory, and a timeout, but it is not sandboxed: the code can read your files and use the network. `fetch_url` and the other web tools only fetch public http(s) URLs (no `file://`, no local or private addresses, and redirects are checked again). A web page an agent reads can contain instructions the agent may follow. If you point agents at sites you do not trust, remove `"python"` from the agents' `tools` in [`adapters/roster.toml`](adapters/roster.toml).
- **API keys** from `.env` are passed only to the agent host, not to the hub or the UI dev server. Variables you have already exported in your shell are inherited by every process, as usual.

## 🗂️ Repository Layout

```
abra/
├── packages/
│   ├── abra-views/      the four views (graph, table, text, display) and their view definitions
│   ├── abra-spec/       canvas and message schema (JSON Schema) with generated JS and Python types
│   └── abra-reducer/    canvas-state reducer shared by the hub and the clients
├── apps/
│   ├── hub/             canvas hub (Node.js): sessions, state, synchronization
│   ├── demo/            web client (Vite + React)
│   └── playground/      a manual test bed for the views, with preset scenarios (no hub, agents, or API key)
├── adapters/            agent adapters (Python)
│   ├── roster.toml      which agents run, with model, tools, and prompt
│   ├── host.py          runs the roster for every session
│   ├── run.py           runs one agent against one session
│   ├── agents/          the four agent types
│   ├── tools/           the custom tools
│   └── common/          canvas tools, bridge, state mirror
└── scripts/             demo launcher, codegen
```

## 🛠️ Development

To run the three processes separately instead of `pnpm demo`:

```bash
pnpm --filter hub start                       # the hub
pnpm --filter demo dev                        # the UI
.venv/bin/python -m adapters.host             # the agent host (the whole roster)
```

To try the views on their own, with preset scenarios and no hub, agents, or API key:

```bash
pnpm playground
```

Codegen and checks:

```bash
pnpm gen              # regenerate the JS/Python types from the JSON-Schema source (committed)
pnpm gen:check        # verify the committed mirrors match the schema
pnpm typecheck        # tsc --noEmit over the typed packages
pnpm lint             # biome
```

**Tested environment.** macOS 15 (Darwin 24.4) on Apple Silicon with Node.js 24 and Python 3.11. No GPU required. Internet access is required for the agents' LLM calls and for tools that reach the web.

## 📄 License

This project is licensed under the BSD 3-Clause License. See the [LICENSE](LICENSE) file for details.

## Disclosures

This software may include, incorporate, or access open source software (OSS) components, datasets and other third party components, including those identified below. The license terms respectively governing the datasets and third-party components continue to govern those portions, and you agree to those license terms may limit any distribution, use, and copying. You may use any OSS components under the terms of their respective licenses, which may include BSD 3, Apache 2.0, and other licenses. In the event of conflicts between Megagon Labs, Inc. ("Megagon") license conditions and the OSS license conditions, the applicable OSS conditions governing the corresponding OSS components shall prevail. You agree not to, and are not permitted to, distribute actual datasets used with the OSS components listed below. You agree and are limited to distribute only links to datasets from known sources by listing them in the datasets overview table below. You agree that any right to modify datasets originating from parties other than Megagon are governed by the respective third party's license conditions. You agree that Megagon grants no license as to any of its intellectual property and patent rights. THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS (INCLUDING MEGAGON) "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE. You agree to cease using, incorporating, and distributing any part of the provided materials if you do not agree with the terms or the lack of any warranty herein. While Megagon makes commercially reasonable efforts to ensure that citations in this document are complete and accurate, errors may occur. If you see any error or omission, please help us improve this document by sending information to contact_oss@megagon.ai.

### Datasets

All datasets used within the product are listed below (including their copyright holders and the license information).

No third-party datasets are bundled in this release. The sample media in `apps/playground/public/display/` is generated by a script in this repository, plus the first page of the project's own paper.

### Open Source Software (OSS) Components

All OSS components used within the product are listed below (including their copyright holders and the license information).

For OSS components having different portions released under different licenses, please refer to the included Upstream link(s) specified for each of the respective OSS components for identifications of code files released under the identified licenses.

</br>

| ID  | OSS Component Name | Modified | Copyright Holder | Upstream Link | License  |
|-----|----------------------------------|----------|------------------|-----------------------------------------------------------------------------------------------------------|--------------------|
| 1 | @biomejs/biome | No | Biome Developers and Contributors | [link](https://github.com/biomejs/biome) | MIT License / Apache Software License |
| 2 | @blueprintjs/core | No | Palantir Technologies, Inc. | [link](https://github.com/palantir/blueprint) | Apache Software License |
| 3 | @blueprintjs/icons | No | Palantir Technologies, Inc. | [link](https://github.com/palantir/blueprint) | Apache Software License |
| 4 | @dagrejs/dagre | No | Chris Pettitt | [link](https://github.com/dagrejs/dagre) | MIT License |
| 5 | @playwright/test | No | Microsoft Corporation | [link](https://github.com/microsoft/playwright) | Apache Software License |
| 6 | @tanstack/react-table | No | Tanner Linsley | [link](https://github.com/TanStack/table) | MIT License |
| 7 | @types/node, @types/react, @types/react-dom, @types/ws | No | Microsoft Corporation | [link](https://github.com/DefinitelyTyped/DefinitelyTyped) | MIT License |
| 8 | @vitejs/plugin-react | No | Yuxi (Evan) You and Vite contributors | [link](https://github.com/vitejs/vite-plugin-react) | MIT License |
| 9 | @xyflow/react | No | webkid GmbH | [link](https://github.com/xyflow/xyflow) | MIT License |
| 10 | d3-force | No | Mike Bostock | [link](https://github.com/d3/d3-force) | ISC License |
| 11 | json-schema-to-typescript | No | Boris Cherny | [link](https://github.com/bcherny/json-schema-to-typescript) | MIT License |
| 12 | leaflet | No | Volodymyr Agafonkin | [link](https://github.com/Leaflet/Leaflet) | BSD License |
| 13 | partysocket | No | Joe Walnes | [link](https://github.com/cloudflare/partykit) | MIT License |
| 14 | react | No | Facebook, Inc. and its affiliates | [link](https://github.com/facebook/react) | MIT License |
| 15 | react-dom | No | Facebook, Inc. and its affiliates | [link](https://github.com/facebook/react) | MIT License |
| 16 | react-leaflet | No | Paul Le Cam and contributors | [link](https://github.com/PaulLeCam/react-leaflet) | Hippocratic License 2.1 |
| 17 | react-pdf | No | Wojciech Maj | [link](https://github.com/wojtekmaj/react-pdf) | MIT License |
| 18 | react-resizable-panels | No | Brian Vaughn | [link](https://github.com/bvaughn/react-resizable-panels) | MIT License |
| 19 | typescript | No | Microsoft Corporation | [link](https://github.com/microsoft/TypeScript) | Apache Software License |
| 20 | vite | No | VoidZero Inc. and Vite contributors | [link](https://github.com/vitejs/vite) | MIT License |
| 21 | ws | No | Einar Otto Stangvik | [link](https://github.com/websockets/ws) | MIT License |
| 22 | zustand | No | Paul Henschel | [link](https://github.com/pmndrs/zustand) | MIT License |
| 23 | anthropic | No | Anthropic, PBC | [link](https://github.com/anthropics/anthropic-sdk-python) | MIT License |
| 24 | claude-agent-sdk | No | Anthropic, PBC | [link](https://github.com/anthropics/claude-agent-sdk-python) | MIT License |
| 25 | datamodel-code-generator | No | Koudai Aono | [link](https://github.com/datamodel-code-generator/datamodel-code-generator) | MIT License |
| 26 | hatchling | No | Ofek Lev | [link](https://github.com/pypa/hatch) | MIT License |
| 27 | langchain-anthropic | No | LangChain, Inc. | [link](https://github.com/langchain-ai/langchain) | MIT License |
| 28 | langgraph | No | LangChain, Inc. | [link](https://github.com/langchain-ai/langgraph) | MIT License |
| 29 | openai | No | OpenAI | [link](https://github.com/openai/openai-python) | Apache Software License |
| 30 | openai-agents | No | OpenAI | [link](https://github.com/openai/openai-agents-python) | MIT License |
| 31 | pydantic | No | Pydantic Services Inc. and individual contributors | [link](https://github.com/pydantic/pydantic) | MIT License |
| 32 | websockets | No | Aymeric Augustin and contributors | [link](https://github.com/python-websockets/websockets) | BSD License |

## 📚 Citation

TBA.
