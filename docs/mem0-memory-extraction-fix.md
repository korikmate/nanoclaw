# mem0 Memória-kinyerési Javítások

## Problémák

### 1. Irreleváns memória injektálás (túl alacsony küszöbérték)

A JIT memory injection 0.3-as cosine similarity küszöböt használt. Gemini embedding-eknél a Home Assistant parancsok (kapu, kávégép, stb.) mind közel esnek az embedding-térben, így irreleváns memóriák kerültek be a promptba.

**Javítás:** küszöbérték 0.3 → 0.75

```ts
// openrouter-runner.ts
const relevant = scored.slice(0, topK).filter((m) => m.score > 0.75);
```

### 2. Memória nem mentődik helyi modell használatakor

Ha `LOCAL_MODEL` aktív és `OPENROUTER_API_KEY` ki van kommentelve, a mem0 LLM hívás az `apiKey = "lm-studio"` kulccsal próbált az OpenRouter-en keresztül `qwen/qwen3-235b`-t hívni → auth hiba → memória elvész.

**Javítás:** helyi modell esetén a mem0 extraction a helyi LM Studio endpointot használja.

```ts
// Ha OPENROUTER_API_KEY elérhető → OpenRouter + MEM0_LLM_MODEL
// Ha nem → LOCAL_MODEL_URL + LOCAL_MODEL
const mem0ApiKey = process.env.OPENROUTER_API_KEY || apiKey;
const mem0BaseURL = process.env.OPENROUTER_API_KEY
  ? 'https://openrouter.ai/api/v1'
  : localModelUrl!;
const mem0LlmModel = process.env.MEM0_LLM_MODEL || (process.env.OPENROUTER_API_KEY ? model : localModel!) || model;
```

### 3. Orphan timeout 12s → 60s

Újraindításkor a konténereknek csak 12 másodpercük volt memóriát menteni, majd megölte őket a nanoclaw. Nagy modellekkel (pl. 235B) ez messze kevés.

**Javítás:** `src/index.ts`

```ts
// Give OpenRouter runners up to 60s to extract memories and exit cleanly.
await new Promise<void>((resolve) => setTimeout(resolve, 60000));
```

### 4. Memória kinyerés minden üzenet után (nem csak session zárásakor)

A korábbi logika csak session záráskor futtatott kinyerést — ha a konténer crashelt vagy megölték, az egész session memóriái elvesztek.

**Javítás:** minden válasz után lefut a kinyerés és mentés. Az `allStoredMemoryTexts` szinkronban marad, így a következő üzenet JIT injectionje már az újonnan kinyert memóriákat is látja.

```ts
// Minden turn végén, session zárástól függetlenül:
const updated = await extractMemories(messages, allStoredMemoryTexts, ...);
await saveStoredMemories(updated, googleApiKey, embedderModel);
allStoredMemoryTexts.length = 0;
allStoredMemoryTexts.push(...updated);
```

## Érintett fájlok

- `container/agent-runner/src/openrouter-runner.ts` — küszöbérték, mem0 API key/URL logika
- `src/index.ts` — orphan container timeout

## Diagnosztika

```bash
# Memória-kinyerés logja a konténerben
docker logs <container_name> 2>&1 | grep -E "extract|memor|semantic|score"

# Jelenlegi memóriák
cat /root/nanoclaw/groups/telegram_main/.mem0/memories.json | python3 -c "
import json,sys; [print(f'[{i}] {m[\"text\"]}') for i,m in enumerate(json.load(sys.stdin))]
"
```
