# Token Optimalizáció

## Áttekintés

Az OpenRouter runner minden API kérésnél elküldi a rendszer promptot, a tool definíciókat és a session history-t. Ezek csökkentése közvetlen token (és költség) megtakarítást jelent.

---

## Fő token-fogyasztók

| Forrás | Becsült méret | Módosítható? |
|--------|--------------|--------------|
| Session history (40 üzenet) | ~20–30k token | ✅ igen |
| System prompt (CLAUDE.md) | ~3–6k token | ✅ igen |
| Tool definíciók (~20 tool) | ~2–3k token | részben |
| Aktuális user üzenet | változó | — |

---

## Elvégzett optimalizációk

### 1. Session history csökkentése: 40 → 8 üzenet

**Fájl:** `container/agent-runner/src/openrouter-runner.ts`

```typescript
const MAX_HISTORY_MESSAGES = 8;  // volt: 40
```

**Miért biztonságos?** A mem0 integráció kimenti a fontos tényeket hosszú távú memóriába (`.mem0/memories.json`), amelyet minden session elején visszatölt a system promptba. A rövid session history csak a folyó beszélgetés közvetlen kontextusát tartja fenn.

**Megtakarítás:** ~80% csökkentés a history tokenekben, kb. 15–25k token per kérés.

### 2. CLAUDE.md trimmelése (admin szekciók kiszervezése)

**Fájl:** `groups/telegram_main/CLAUDE.md`

Az alábbi szekciók átkerültek a `groups/telegram_main/admin.md` fájlba:
- Container Mounts
- Managing Groups (finding, adding, removing, allowlist)
- Global Memory
- Scheduling for Other Groups
- Task Scripts

A CLAUDE.md-ben csak egy hivatkozás maradt:
```markdown
## Admin Context
For detailed admin info, read `/workspace/group/admin.md`.
```

**Megtakarítás:** ~65% kisebb system prompt (~310 sor → ~110 sor). Az agent csak akkor olvassa az admin.md-t, ha tényleg szüksége van rá.

---

## Mem0 és a session history kapcsolata

A mem0 (`MEM0_ENABLED=1`) minden session végén kinyeri a fontos tényeket és elmenti a group mappájában:

```
groups/<group>/.mem0/memories.json
```

Ezek a memóriák a következő session system promptjába kerülnek be. Így rövidebb history mellett sem vész el a hosszú távú kontextus.

**Konfiguráció (.env):**
```env
MEM0_ENABLED=1
MEM0_LLM_MODEL=qwen/qwen3-235b-a22b-2507
MEM0_EMBEDDER_MODEL=gemini-embedding-2-preview
GOOGLE_API_KEY=<key>
```

---

## Egyéb lehetőségek (nem elvégezve)

### Tool leírások rövidítése

Az MCP tool-ok description mezői rövidíthetők. Az `openrouter-runner.ts`-ben a `mcpToolsToOpenAI()` függvénynél a description csonkítható:

```typescript
description: t.description?.slice(0, 100),
```

### Kondicionális tool betöltés

Ha az HA MCP tool-ok csak bizonyos kérésekre kellenek, a `haClient` inicializálása elhalasztható az első HA-vonatkozású kérésig. Implementálása bonyolultabb, mert a tool listát a session elején kell meghatározni.

### Prompt caching

Az Anthropic API támogatja a prompt caching-et, amely a system prompt és a tool definíciók tokeneit cache-eli. Az OpenRouter-en keresztül ez modellfüggő.

---

## Hogyan ellenőrizd a hatást

A container logokban látszik a betöltött history mérete:

```
[openrouter-runner] Loaded 8 messages from session history (...)
[openrouter-runner] Injected 7 long-term memories into system prompt
```

OpenRouter dashboard-on a token usage per request is nyomon követhető.
