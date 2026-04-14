# Memory MCP Tools

## Probléma

A mem0 auto-extraction gyenge minőségű memóriákat termelt:
- Tranziens HA állapotokat mentett el (`"A kávéfőző használata ideiglenesen szünetel"`)
- Triviális viselkedési mintákat tárolt (`"A kávéfőzőt ki- és bekapcsolni kérik"`)
- Az agent nem tudta saját maga kezelni a memóriáját

## Megoldás

Az OpenClaw mem0 plugin mintájára (`docs.mem0.ai/integrations/openclaw`) egy MCP szerver (`memory-mcp-stdio.ts`) ami 4 explicit tool-t ad az agentnek.

## Új fájlok

- `container/agent-runner/src/memory-mcp-stdio.ts` — az MCP szerver

## Tools

| Tool | Leírás |
|------|--------|
| `memory_store(text)` | Tart fenn egy tartós tényt vagy preferenciát |
| `memory_list()` | Listázza az összes tárolt memóriát ID-vel |
| `memory_search(query)` | Kulcsszavas keresés a memóriák között |
| `memory_forget(id_or_text)` | Töröl ID vagy szövegegyezés alapján |

## Adatformátum

A `memories.json` most ID-vel és dátummal is tárolja a bejegyzéseket:

```json
[
  {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "text": "kv gep Socket = kávéfőző smart plug a konyhában",
    "createdAt": "2026-04-08T10:00:00.000Z",
    "embedding": [...]
  }
]
```

Visszafelé kompatibilis: a régi `{text, embedding}` formátumú bejegyzések is betöltődnek.

## Architektúra

```
Session indul
    │
    ▼
memory-mcp-stdio.ts elindul (stdio MCP folyamat)
    │
    ▼
Agent megkapja: memory_store / memory_list / memory_search / memory_forget toolokat
    │
    ├─ Agent explicit hívja: memory_store("kv gep Socket = kávéfőző")
    │      → azonnal bekerül memories.json-ba UUID-val
    │
    └─ Session végén: extractMemories() auto-extraction fut
           → saveStoredMemories() merge-eli:
               • meglévő (agent-tárolt) bejegyzések megtartva
               • auto-extracted új tények hozzáadva
               • embedding számítás csak az újokra fut
```

## Mikor használja az agent a memory_store-t

Az agent dönt, nem automatizmus. A tool leírása instruálja:

**Igen (tartós, hasznos):**
- Entitás-név mappingek: `"kv gep Socket = kávéfőző dugó"`
- Preferenciák: `"Reggel 7-kor kéri a napfelkeltés riasztást"`
- Visszatérő minták: `"Hétvégén lazább munkarendet preferál"`

**Nem (tranziens, felesleges):**
- HA device állapot: `"A kávéfőző most be van kapcsolva"`
- Ideiglenes helyzetek: `"Ideiglenesen nem issza a kávét"`
- Amit az LLM már tud a session history-ból

## Kapcsolódó változások az `openrouter-runner.ts`-ben

### `StoredMemoryEntry` — ID mező hozzáadva
```typescript
interface StoredMemoryEntry {
  id?: string;       // UUID (ha memory_store hívta)
  text: string;
  createdAt?: string;
  embedding?: number[];
}
```

### `saveStoredMemories` — merge logika
Az auto-extraction többé nem írja felül az agent által tárolt memóriákat — merge-eli:
```
final = current_file ∪ auto_extracted_texts
```
Meglévő bejegyzések ID-je és embedding-je megmarad.

### `customPrompt` a mem0 extractorhoz
Az auto-extraction is jobb instrukciókat kapott — ne tárolja a tranziens állapotokat.

## `memory_forget` használati példa

Ha a user azt mondja "felejtsük el a kávéfőző szüneteltetését":
```
memory_forget("kávéfőző használata ideiglenesen")
→ Deleted 1 memory/memories.
```
