# Helyi modell (LM Studio) integráció

Lehetővé teszi hogy a NanoClaw agent helyi, LM Studio-ban futó modellt használjon az OpenRouter helyett. Bármely OpenAI-kompatibilis szerver működik (Ollama, llama.cpp, stb.).

## Aktiválás

A `.env` fájlban vedd le a `#` jelet a három sorról:

```env
LOCAL_MODEL_URL=http://100.110.58.27:1234/v1
LOCAL_MODEL=qwen2.5-7b-instruct
# LOCAL_MODEL_API_KEY=lm-studio   ← elhagyható
```

A modell nevét az LM Studio **Developer** fülén találod a betöltött modell neve alatt.

## Visszakapcsolás OpenRouterre

Tedd vissza a `#` jelet a `LOCAL_MODEL_URL` és `LOCAL_MODEL` sorok elé:

```env
# LOCAL_MODEL_URL=http://100.110.58.27:1234/v1
# LOCAL_MODEL=qwen2.5-7b-instruct
```

## Prioritási sorrend

```
LOCAL_MODEL_URL + LOCAL_MODEL beállítva  →  helyi modell (LM Studio)
egyéb esetben                            →  OpenRouter (OPENROUTER_MODEL)
```

Az OpenRouter API key megmarad a háttérben, bármikor visszakapcsolható.

## Érintett fájl

`container/agent-runner/src/openrouter-runner.ts` — `runOpenRouterAgent()` entry point

## Megjegyzések

- `LOCAL_MODEL_API_KEY` opcionális — LM Studio nem igényel valódi kulcsot, alapértelmezett: `lm-studio`
- Az `OPENROUTER_PROVIDER` helyi modellnél automatikusan ki van kapcsolva (nem értelmes)
- A session history, mem0 memória, MCP eszközök, Home Assistant integráció mind ugyanúgy működik helyi modellel is
- A helyi modell neve pontosan egyezzen az LM Studio-ban betöltött modell azonosítójával
