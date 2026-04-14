# JIT Memory Injection — Refactoring Summary

## Probléma

A Mem0 memória-plugin korábban **statikusan** injektálta a visszakeresett emlékeket a `systemPrompt`-ba a session elején. Ez két kritikus hibát okozott:

1. **Kontextus-romlás**: ahogy a beszélgetés nőtt, az LLM egyre kevésbé vette figyelembe a session elején beágyazott emlékeket.
2. **Elavult relevancia**: a szemantikus keresés csak az *első* üzenet alapján futott — az összes rákövetkező üzenet más témájú lehetett, de ugyanazokat az emlékeket kapta.

## Megoldás: Message-Level JIT Injection

Az architektúra átváltott **"Static Session-Level Injection"**-ről **"Dynamic Message-Level Injection"**-re.

Az érintett fájl: `container/agent-runner/src/openrouter-runner.ts`

---

## Változások

### 1. Eltávolítva — statikus rendszer-prompt injektálás

```typescript
// RÉGI (eltávolítva)
const storedMemories = mem0Enabled
  ? await loadRelevantMemories(prompt, googleApiKey, embedderModel)
  : [];

const systemPrompt = storedMemories.length > 0
  ? `${basePrompt}\n\n## Memories from previous conversations\n${storedMemories.map((m) => `- ${m}`).join('\n')}`
  : basePrompt;
```

A `storedMemories` változó és a `systemPrompt`-ba való beágyazás teljes egészében megszűnt. A `systemPrompt` mostantól kizárólag a `CLAUDE.md` tartalmát (vagy az alapértelmezett személyiség-szöveget) tartalmazza.

---

### 2. Hozzáadva — 4 új segédfüggvény

#### `formatMemoryContext(memories: string[]): string`
Az emlékeket a meghatározott XML struktúrába csomagolja:

```
<context>
  <relevant_memories>
    - [Emlékezet 1]
    - [Emlékezet 2]
  </relevant_memories>
</context>
```

#### `stripMemoryContext(content: string): string`
Eltávolítja az összes `<context>…</context>` blokkot egy üzenet tartalmából.

#### `injectJitMemoryContext(messages, googleApiKey, embedderModel): Promise<void>`
- Megkeresi az **utolsó `user` szerepű** üzenetet a `messages` tömbben
- Ezt az üzenetet használja szemantikus lekérdezésként a `loadRelevantMemories`-ban
- A visszakapott XML kontextus-blokkot **az üzenet elejére fűzi** (in-place mutáció)

#### `stripAllMemoryContexts(messages): void`
- Végigmegy az összes üzeneten
- Minden `user` üzenetből kivágja a `<context>` blokkot a mentés előtt

---

### 3. Módosítva — a fő query loop

```typescript
while (true) {
  // 1. JIT injektálás az aktuális üzenet alapján
  if (mem0Enabled) {
    await injectJitMemoryContext(messages, googleApiKey, embedderModel);
  }

  const result = await runQuery(...);

  // 2. Kontextus-blokkok eltávolítása mentés előtt
  if (mem0Enabled) {
    stripAllMemoryContexts(messages);
  }

  saveSessionHistory(messages);
  writeOutput({ status: 'success', result });
  // ...
}
```

---

## Adatfolyam

```
User üzenet érkezik
        │
        ▼
loadRelevantMemories(user_message)   ← szemantikus keresés az AKTUÁLIS üzenet alapján
        │
        ▼
<context>...</context> blokk előre fűzve a user üzenethez
        │
        ▼
runQuery(messages)                   ← LLM megkapja a releváns kontextust
        │
        ▼
stripAllMemoryContexts(messages)     ← XML blokk eltávolítva
        │
        ▼
saveSessionHistory(messages)         ← tiszta, kontextus nélküli előzmény mentve
```

---

## Eredmény

| Tulajdonság | Régi | Új |
|---|---|---|
| Memória lekérdezés időpontja | Session indításakor (egyszer) | Minden üzenet előtt |
| Lekérdezési alap | Első üzenet | Aktuális üzenet |
| Injektálás helye | `systemPrompt` (statikus) | User üzenet tartalma (dinamikus) |
| Session history szennyezés | Nem (system promptban volt) | Nem (strip gondoskodik róla) |
| Token-növekedés kockázata | Közepes (hosszú session-ök) | Nincs (strip után mentés) |

---

## 2. Javítás — Query Bleed (Retrieval Szennyezés)

### Probléma

A `loadRelevantMemories` függvényben két "visszaesési" ág volt, amelyek szemantikus keresés helyett **az összes memóriát** visszaadták, ha valami feltétel nem teljesült:

1. **Count bypass**: Ha `entries.length <= topK` (≤8 memória), kihagyta a szemantikus keresést és visszaadta az összes bejegyzést — relevanciától függetlenül.
2. **Embedding hiba fallback**: Ha az embedding-számítás meghiúsult, szintén az összes memóriát adta vissza.

Ez okozta, hogy pl. a „Reggeli összefoglaló" témájú memória bekerült a „Kávégép státusz" lekérdezés kontextusába.

A lekérdezési alap maga (`lastUserMsg.content`) helyes volt — mindig a legutóbbi user üzenetet használta. A hiba a fallback logikában volt.

### Javítás

Mindkét fallback ág `[]`-t ad vissza `entries.map((e) => e.text)` helyett. Ha nem tudjuk pontosan megítélni, hogy egy memória releváns-e az aktuális kérdéshez, nem injektálunk semmit — a csend jobb, mint a zajos kontextus.

```typescript
// RÉGI — szennyezést okoz
if (!googleApiKey || entries.length <= topK) {
  return entries.map((e) => e.text);  // minden memóriát visszaad!
}
// ...
if (!queryEmbedding) {
  return entries.map((e) => e.text);  // ugyanígy
}

// ÚJ — üres lista a fallback
if (!googleApiKey) {
  log('No Google API key — skipping memory retrieval to avoid irrelevant context');
  return [];
}
// ...
if (!queryEmbedding) {
  log('Query embedding failed — skipping memory retrieval to avoid irrelevant context');
  return [];
}
```

A `score > 0.3` küszöb az eredeti szemantikus ágban már helyes volt — csak a bypass-olt ágak kerülték el.

### Adatfolyam (javított)

```
User üzenet érkezik ("Kávégép státusz?")
        │
        ▼
loadRelevantMemories(utolsó_user_üzenet)
        │
        ├─ Google API key nincs? → []  (nincs injektálás)
        │
        ├─ Embedding hiba? → []  (nincs injektálás)
        │
        └─ Minden memória pontszáma < 0.3? → []  (nincs injektálás)
                │
                ▼ (csak ha van releváns találat)
        <context>...</context> blokk előre fűzve
```
