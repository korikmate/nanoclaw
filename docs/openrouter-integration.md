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
| `container/agent-runner/src/openrouter-runner.ts` | **Új.** Teljes OpenAI SDK-alapú agent runner. |
| `container/agent-runner/src/index.ts` | Import + routing logika a `main()` elejére. |
| `container/agent-runner/package.json` | `openai` csomag hozzáadva. |
| `src/container-runner.ts` | `OPENROUTER_MODEL` és `OPENROUTER_API_KEY` env var átadása a containernek. |
| `.env` | Kommentezett konfiguráció példák. |

---

## OpenRouter runner (`openrouter-runner.ts`)

### Tool-készlet

A runner OpenAI function calling protokollon keresztül biztosít eszközöket:

| Tool | Leírás |
|------|--------|
| `bash` | Bash parancs futtatása a container sandboxban (`/workspace/group` cwd, 30s timeout) |
| `read_file` | Fájl tartalmának olvasása |
| `write_file` | Fájl írása (könyvtárakat is létrehozza) |
| `edit_file` | String csere fájlban (első előfordulás) |
| `web_search` | DuckDuckGo keresés (JSON API) |
| `web_fetch` | URL lekérése, HTML strip, 8000 karakter limit |
| `send_message` | Azonnali üzenet küldése Telegramra (IPC message fájlon át, ugyanaz a protokoll mint a Claude MCP szerver) |

### Session kezelés

Az OpenAI-kompatibilis modellek nem rendelkeznek Claude Code-hoz hasonló session-persistenciával. A runner a folyamat életciklusa alatt memóriában tartja a conversation history-t (`messages[]`), de container újraindítás után a kontextus elvész. Ez a legtöbb nem-Claude modell természetes korlátja.

### System prompt

A runner a group `CLAUDE.md` fájlát tölti be system promptként, ha létezik. Így a per-group személyiség és utasítások nem-Claude modelleknél is érvényesek.

### Max tool calls

Végtelen loop ellen 30 tool call limitet tartalmaz (`MAX_TOOL_CALLS`).

### IPC protokoll

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
```

Szinkronizáld a container környezetbe:

```bash
cp .env data/env/env
```

### 3. Service újraindítás

```bash
systemctl restart nanoclaw
```

### 4. Tesztelés

Küldj üzenetet a Telegram botnak. A logokban látható melyik runner fut:

```bash
tail -f logs/nanoclaw.log
# [openrouter-runner] Running query with model: openai/gpt-4o
```

---

## Ajánlott modellek

| Model ID | Leírás | Megjegyzés |
|----------|--------|------------|
| `openai/gpt-4o` | OpenAI GPT-4o | Erős általános teljesítmény |
| `openai/gpt-4o-mini` | GPT-4o Mini | Gyors, olcsó |
| `meta-llama/llama-3.3-70b-instruct` | Llama 3.3 70B | Ingyenes tier elérhető |
| `google/gemini-2.0-flash-exp` | Gemini 2.0 Flash | Gyors, multimodális |
| `anthropic/claude-sonnet-4-5` | Claude Sonnet | OneCLI proxy helyett OpenRouteren át |
| `deepseek/deepseek-chat` | DeepSeek V3 | Olcsó, erős kódoláshoz |

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

- **Nincs session-persistencia** nem-Claude modelleknél: container újraindítás után a kontextus elvész (ellentétben a Claude Agent SDK session ID alapú folytatásával).
- **Nincs agent-browser** nem-Claude modelleknél: a Playwright-alapú böngészővezérlés csak Claude Code CLI-n keresztül érhető el.
- **Nincs MCP**: az MCP szerver (feladatütemezés, csoportkezelés) csak a Claude runnerben aktív. A `send_message` tool azonban közvetlen IPC-n keresztül működik.
- **Web search korlátozott**: a DuckDuckGo JSON API nem adja vissza a teljes keresési eredményt, csak az abstract és related topics mezőket.
