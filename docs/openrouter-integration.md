# OpenRouter Integration

NanoClaw OpenRouter integrációja lehetővé teszi, hogy a container agent nem csak Claude modellel, hanem bármely OpenRouter-en elérhető OpenAI-kompatibilis modellel fusson.

---

## Architektúra

### Eredeti folyamat (Claude)

```
Telegram → NanoClaw host → Docker container → Claude Agent SDK → Anthropic API
                                                                      ↑
                                                               OneCLI proxy (credentials)
```

### Új folyamat (OpenRouter / nem-Claude)

```
Telegram → NanoClaw host → Docker container → OpenRouter runner → OpenRouter API
                                                                       ↑
                                                              OPENROUTER_API_KEY (env)
```

A két runner párhuzamosan létezik — az `index.ts` induláskor dönt:

```typescript
const openRouterModel = process.env.OPENROUTER_MODEL;
if (openRouterModel && !openRouterModel.startsWith('anthropic/')) {
  await runOpenRouterAgent(containerInput);
  return;
}
// ... eredeti Claude Agent SDK flow
```

Claude modelleket (`anthropic/...` prefix) a meglévő OneCLI proxy kezel, az OpenRouter runner nem veszi át őket.

---

## Módosított fájlok

| Fájl | Változás |
|------|----------|
| `container/agent-runner/src/openrouter-runner.ts` | **Új.** Teljes OpenAI SDK-alapú agent runner (memória, MCP, toolok). |
| `container/agent-runner/src/index.ts` | Import + routing logika a `main()` elejére. |
| `container/agent-runner/package.json` | `openai`, `mem0ai` csomagok hozzáadva. |
| `src/container-runner.ts` | OpenRouter/mem0 env var-ok átadása a containernek; group könyvtár `chmod 777` hogy a `node` user írhasson. |
| `src/container-runtime.ts` | `findOrphanContainers()` export; `cleanupOrphans()` refaktorálva. |
| `src/index.ts` | Orphan kontainerek `_close` signallal leállítva (mem0 extraction) indítás előtt; `DATA_DIR` import. |
| `.env` | Kommentezett konfiguráció példák. |

---

## OpenRouter runner (`openrouter-runner.ts`)

### Tool-készlet

A runner OpenAI function calling protokollon keresztül biztosít eszközöket. Két forrásból:

**Lokális toolok** (mindig elérhetők):

| Tool | Leírás |
|------|--------|
| `bash` | Bash parancs futtatása a container sandboxban (`/workspace/group` cwd, 30s timeout) |
| `read_file` | Fájl tartalmának olvasása |
| `write_file` | Fájl írása (könyvtárakat is létrehozza) |
| `edit_file` | String csere fájlban (első előfordulás) |
| `web_search` | DuckDuckGo keresés (JSON API) |
| `web_fetch` | URL lekérése, HTML strip, 8000 karakter limit |

**MCP toolok** (az `ipc-mcp-stdio.ts` szerverről, automatikusan felderítve induláskor):

| Tool | Leírás |
|------|--------|
| `mcp__send_message` | Azonnali üzenet küldése Telegramra feldolgozás közben |
| `mcp__schedule_task` | Feladat ütemezése (cron / interval / once) |
| `mcp__list_tasks` | Ütemezett feladatok listázása |
| `mcp__pause_task` | Feladat szüneteltetése |
| `mcp__resume_task` | Szüneteltetett feladat folytatása |
| `mcp__cancel_task` | Feladat törlése |
| `mcp__update_task` | Ütemezett feladat módosítása |
| `mcp__register_group` | Új csoport regisztrálása (main group only) |

Az MCP toolok `mcp__` prefixszel jelennek meg a modell számára. Ha az MCP szerver nem elérhető, a runner ezek nélkül is fut (graceful degradation).

> **Jövőbiztos:** az MCP toolokat a runner `client.listTools()` hívással fedezi fel induláskor — ha az MCP szerverhez új tool kerül, az OpenRouter runner automatikusan megkapja, kódváltoztatás nélkül.

---

## Kétszintű memória

### 1. Rövid távú — fájlalapú session history

A runner minden turn után elmenti az üzeneteket `/workspace/group/.openrouter-session.json`-ba (max. 40 üzenet, FIFO). Container újraindításkor betölti és folytatja — a kontextus nem vész el.

### 2. Hosszú távú — mem0ai/oss (lokális, felhő nélkül)

A session lezárásakor (lásd: Session lezárás) a runner a `mem0ai/oss` könyvtárral kinyeri a fontos tényeket, preferenciákat és kontextust a beszélgetésből. Az extrakciót egy OpenRouter LLM végzi (konfigurálható modell). Az eredmény `/workspace/group/.mem0/memories.json`-ba íródik — a group mappa perzisztens, így container újraindítás után is megmarad.

A következő session elején az összes tárolt emlékezet bekerül a rendszer promptba:

```
## Memories from previous conversations
- A felhasználó Python-t preferál JavaScript helyett
- Szeret rövid, tömör válaszokat kapni
- Kedvenc IDE-je a Neovim
```

A vektoros keresést a `gemini-embedding-2-preview` modell végzi (768 dim, in-memory). Nincs szükség külső vektoros adatbázisra — kizárólag az `OPENROUTER_API_KEY` (LLM extrakció) és a `GOOGLE_API_KEY` (embedder) szükséges.

### Session lezárás

A mem0 extrakció két esetben fut le:

| Esemény | Mechanizmus |
|---------|-------------|
| `/new` Telegram parancs | A host `_close` sentinel fájlt ír az IPC input könyvtárba; a runner felismeri, futtatja az extrakciót, majd kilép |
| NanoClaw service újraindítás | Az induláskor detektált orphan containerek `_close` signalt kapnak; a service 12 másodpercet vár az extrakció befejezésére, utána állítja le a containereket |

A `/new` parancsra érkező válasz: `Session lezárva. A következő üzenet új sessiont indít.`

---

## System prompt

A runner a group `CLAUDE.md` fájlát tölti be system promptként, ha létezik. Így a per-group személyiség és utasítások nem-Claude modelleknél is érvényesek.

---

## IPC protokoll

Az output ugyanaz a sentinel-alapú protokoll mint a Claude runnernél:

```
---NANOCLAW_OUTPUT_START---
{"status":"success","result":"..."}
---NANOCLAW_OUTPUT_END---
```

A host `src/container-runner.ts` változatlanul kezeli mindkét runnert.

---

## Használati utasítás

### 1. OpenRouter API kulcs beszerzése

Regisztrálj az [openrouter.ai](https://openrouter.ai) oldalon, majd hozz létre egy API kulcsot a Dashboard → Keys oldalon.

### 2. Konfiguráció

Szerkeszd a `.env` fájlt:

```bash
OPENROUTER_API_KEY=sk-or-v1-xxxxxxxxxxxxxxxxxxxxxxxx
OPENROUTER_MODEL=openai/gpt-4o

# Provider rögzítése (opcionális) — ha meg van adva, csak az adott providertől kér
# OPENROUTER_PROVIDER=DeepSeek

# Mem0 lokális memória — Google API kulcs szükséges az embedder modellhez
GOOGLE_API_KEY=AIza...                         # Google AI Studio: aistudio.google.com/apikey
MEM0_LLM_MODEL=qwen/qwen3-235b-a22b-2507      # LLM az extrakciőhoz (alapból: OPENROUTER_MODEL)
MEM0_EMBEDDER_MODEL=gemini-embedding-2-preview # embedder modell
# MEM0_ENABLED=0                              # kikapcsoláshoz
```

> **Modell ID formátum:** az `OPENROUTER_MODEL`, `MEM0_LLM_MODEL` értékeket OpenRouter slug formátumban kell megadni (pl. `openai/gpt-4o`, `meta-llama/llama-3.3-70b-instruct`). Nem kell `openrouter/` prefix.

### Provider rögzítése (opcionális)

Ha `OPENROUTER_PROVIDER` be van állítva, minden kérés csak az adott providertől megy ki (`allow_fallbacks: false`). Ha a provider nem elérhető, a kérés hibával tér vissza — nincs fallback.

```bash
OPENROUTER_PROVIDER=DeepSeek   # csak DeepSeek-et használ
```

Provider slug-ok: `DeepSeek`, `Fireworks`, `Together`, `Lepton`, `Novita`, `Hyperbolic` stb. — az OpenRouter modell oldalán a „Providers" fül alatt láthatók. Ha nincs megadva, az OpenRouter automatikusan választ a legolcsóbb/leggyorsabb elérhető provider közül.

Szinkronizáld a container környezetbe:

```bash
cp .env data/env/env
```

### 3. Service újraindítás

```bash
systemctl restart nanoclaw
```

### 4. Tesztelés

Küldj üzenetet a Telegram botnak. A logokban látható mi fut:

```bash
tail -f logs/nanoclaw.log
# [openrouter-runner] Running query with model: openai/gpt-4o
# [openrouter-runner] MCP connected: send_message, schedule_task, list_tasks, ...
# [openrouter-runner] Injected 5 long-term memories into system prompt
```

---

## Ajánlott modellek

| Model ID | Leírás | Megjegyzés |
|----------|--------|------------|
| `openai/gpt-4o` | OpenAI GPT-4o | Erős általános teljesítmény |
| `openai/gpt-4o-mini` | GPT-4o Mini | Gyors, olcsó — jó `MEM0_LLM_MODEL`-nek |
| `meta-llama/llama-3.3-70b-instruct` | Llama 3.3 70B | Ingyenes tier elérhető |
| `google/gemini-2.0-flash-exp` | Gemini 2.0 Flash | Gyors, multimodális |
| `anthropic/claude-sonnet-4-5` | Claude Sonnet | OneCLI proxy helyett OpenRouteren át |
| `deepseek/deepseek-chat` | DeepSeek V3 | Olcsó, erős kódoláshoz |
| `xiaomi/mimo-v2-pro` | MiMo V2 Pro | Kisebb modell, gyors válasz |
| `qwen/qwen3-235b-a22b-2507` | Qwen3 235B | Nagy modell, erős mem0 extrakciőhoz |

Elérhető modellek teljes listája: [openrouter.ai/models](https://openrouter.ai/models)

---

## Visszaállítás Claude-ra

Kommenteld ki vagy töröld a `.env`-ből:

```bash
# OPENROUTER_API_KEY=...
# OPENROUTER_MODEL=...
```

Majd:

```bash
cp .env data/env/env && systemctl restart nanoclaw
```

---

## Korlátok

- **Nincs agent-browser** nem-Claude modelleknél: a Playwright-alapú böngészővezérlés csak Claude Code CLI-n keresztül érhető el.
- **Web search korlátozott**: a DuckDuckGo JSON API nem adja vissza a teljes keresési eredményt, csak az abstract és related topics mezőket.
- **Session history max. 8 üzenet**: ennél hosszabb beszélgetések régebbi részei törlődnek — a tények viszont megmaradnak a mem0 hosszú távú memóriában.
- **Service restart 12s delay**: ha vannak orphan containerek induláskor, a service 12 másodpercet vár a mem0 extrakció befejezésére. Ez csak ritkán (pl. crash után) fordul elő.
