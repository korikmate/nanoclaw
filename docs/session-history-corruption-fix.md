# Session History Corruption Fix

## Probléma

Az agent időnként (tipikusan reggel) teljesen leállt: nem válaszolt üzenetekre, az ütemezett reggeli összefoglalók sem mentek ki. A hiba modell-független volt — korábban más modellnél is előfordult.

**Tünetek:**
- `400 Provider returned error` minden container futásnál
- Container ~6 másodperc alatt kilépett, output nélkül
- Ütemezett task-ok `error` státusszal végeztek
- Retry logika (5s→10s→20s→40s→80s backoff) kimerült, üzenet elveszett

## Gyök ok

### 1. Sérült session history (fő ok)

A `saveSessionHistory()` két lépést tett:

1. Kiszűrte a null-tartalmú assistant üzeneteket (reasoning modelleknél pl. kimi-k2.5 `content: null`-t ad vissza)
2. Levágta az utolsó `MAX_HISTORY_MESSAGES` (8) üzenetre: `clean.slice(-8)`

**A bug:** ha a 8-as ablak olyan pozícióban kezdődött, ahol az assistant üzenet (amely tool_call-okat tartalmazott) már kívül esett, a hozzá tartozó `tool` válasz üzenetek "árván" maradtak a history elején. Az OpenRouter API érvénytelen üzenetsorrend miatt 400-as hibával utasította vissza ezeket.

Példa sérült history:
```
[0] tool    ← árva (az assistant aki hívta levágódott a slice által)
[1] assistant ← null content
[2] tool    ← árva
[3] assistant ← null content
[4] tool    ← admin.md tartalom
[5] assistant ← rendes tartalom ✓
[6] tool    ← LiveContext
[7] assistant ← rendes tartalom ✓
```

### 2. Session sosem évült el

A konténer 30 perc inaktivitás után bezárul (`IDLE_TIMEOUT`), de a `.openrouter-session.json` fájl **örökké megmaradt**. Másnap reggel az ütemezett task vagy az első üzenet betöltötte a tegnapi (potenciálisan sérült) sessiont.

## Javítás

### `saveSessionHistory()` — orphan trim

```ts
let trimmed = clean.slice(-MAX_HISTORY_MESSAGES);
// Ha a slice közepén vágta le az assistant+tool_call párt, a history
// "tool" üzenettel kezdődhet — ez 400-as hibát okoz. Levágjuk az elejét
// az első "user" üzenetig.
const firstUserIdx = trimmed.findIndex((m) => m.role === 'user');
if (firstUserIdx > 0) trimmed = trimmed.slice(firstUserIdx);
```

### `loadSessionHistory()` — session expiry

```ts
const SESSION_MAX_AGE_MS = 2 * 60 * 60 * 1000; // 2 óra

const ageMs = Date.now() - new Date(data.updatedAt).getTime();
if (ageMs > SESSION_MAX_AGE_MS) {
  log(`Session expired (age: ${Math.round(ageMs / 60000)}min) — starting fresh`);
  fs.unlinkSync(SESSION_FILE);
  return [];
}
```

**Miért 2 óra:** a konténer 30 perc után lezárul. 2 órán belüli új üzenetnél a kontextus folytatódik (természetes). 2 óra után (pl. reggel) fresh sessiont indít, nem cipeli a potenciálisan sérült tegnapi tool-hívásokat.

## Érintett fájl

`container/agent-runner/src/openrouter-runner.ts`

## Diagnosztika

Ha hasonló hiba gyanítható, ellenőrizd:

```bash
# Task futási logok
sqlite3 /root/nanoclaw/store/messages.db \
  "SELECT task_id, run_at, status, error FROM task_run_logs ORDER BY run_at DESC LIMIT 10;"

# Session fájl tartalma és kora
python3 -c "
import json, os
f = '/root/nanoclaw/groups/telegram_main/.openrouter-session.json'
if os.path.exists(f):
    d = json.load(open(f))
    print('updatedAt:', d['updatedAt'])
    for i,m in enumerate(d['messages']):
        print(f'[{i}] role={m[\"role\"]}: {str(m.get(\"content\",\"\"))[:80]}')
"

# Gyors megoldás sérült session esetén
rm /root/nanoclaw/groups/telegram_main/.openrouter-session.json
```
