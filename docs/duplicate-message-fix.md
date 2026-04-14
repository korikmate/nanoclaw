# Duplikált üzenetek — Diagnózis és javítás

## Tünet

Az asszisztens rendszeresen kétszer válaszolt ugyanarra az üzenetre, "majdnem ugyanolyan" tartalommal (kis szövegbeli eltérésekkel, de lényegében ugyanaz a válasz).

## Gyökérok

Két nanoclaw példány futott egyszerre. Mindkettő:
1. Látta az érkező üzenetet (DB-ből)
2. Indított egy Docker containert ugyanazzal a session ID-vel és history-val
3. Meghívta az LLM-et ugyanarra az inputra
4. Elküldte a választ

Mivel az LLM nemrandomisztikus (de nem is determinisztikus), a két válasz "majdnem ugyanolyan" — azonos tartalom, kis szövegbeli eltérések.

### Hogyan kerültek párhuzamos futásba a példányok?

**1. eset: `/restart` command timing gap**

A régi `/restart` implementáció:
```bash
sleep 2 && kill <pid> && nohup node dist/index.js &
```
2 másodpercig egyszerre futott a régi és az új példány. Mindkettő feldolgozta az érkező üzeneteket.

**2. eset: Manuális/service manager dupla indítás**

Ha a service manager (systemd, launchd) újraindítja a folyamatot miközben a régi még él, vagy manuálisan kétszer indítják el, ugyanaz az állapot áll elő.

### Bizonyíték a logokból

A 08:00-as container logok megmutatták a problémát — két container indult 16ms különbséggel, **ugyanazzal a session ID-vel**:

```
container-2026-04-08T06:00:31.782Z  session: cc8a3c46  → "☕ A kávéfőző bekapcsolva! Jó reggelt!"
container-2026-04-08T06:00:31.798Z  session: cc8a3c46  → "A kávéfőző konnektora be van kapcsolva! ☕️"
```

Azonos session ID = ugyanazon history alapján futott mindkét LLM-hívás.

---

## Javítások

### 1. `/restart` command — overlap megszüntetése

**Régi kód** (`src/index.ts`):
```typescript
const child = spawn('bash', [
  '-c', `sleep 2 && kill ${process.pid} && nohup node ${scriptPath} > /tmp/nanoclaw.log 2>&1 &`
], { detached: true, stdio: 'ignore' });
child.unref();
```

**Új kód**:
```typescript
process.once('exit', () => {
  spawn('node', [scriptPath], { detached: true, stdio: 'ignore' }).unref();
});
process.exit(0);
```

Az új példány csak azután indul, hogy a régi teljesen leállt (`process.exit` → `exit` event). Nulla átfedés.

---

### 2. PID lock file — egyidejű futás megakadályozása

A `main()` elején `acquireSingleInstanceLock()` fut:

```typescript
const LOCK_FILE = path.join(DATA_DIR, 'nanoclaw.lock');

function acquireSingleInstanceLock(): void {
  if (fs.existsSync(LOCK_FILE)) {
    const existingPid = parseInt(fs.readFileSync(LOCK_FILE, 'utf-8').trim(), 10);
    if (!isNaN(existingPid) && existingPid !== process.pid) {
      try {
        process.kill(existingPid, 0); // throws if not running
        process.kill(existingPid, 'SIGTERM'); // kill if alive
      } catch { /* stale lock */ }
    }
  }
  fs.writeFileSync(LOCK_FILE, String(process.pid));
  process.once('exit', () => fs.unlinkSync(LOCK_FILE));
}
```

- Indulásnál ellenőrzi a lock fájlt
- Ha a benne lévő PID él → SIGTERM-et küld neki
- Felülírja a lock fájlt a saját PID-jével
- Kilépéskor törli a lock fájlt (ne maradjon stale lock)

---

## Kapcsolódó javítás (ugyanabban a sessionben)

### Telegram duplikátum a `sendTelegramMessage` fallback-ből

A Telegram küldő függvény korábban minden kivételt (timeout, rate limit, hálózati hiba) ugyanúgy kezelt mint a Markdown parse hibát — újraküldte plain textként. Ha az első küldés sikeres volt de timeout-olt a válasz, az üzenet kétszer érkezett meg.

**Régi kód**:
```typescript
try {
  await api.sendMessage(chatId, text, { parse_mode: 'Markdown' });
} catch (err) {
  await api.sendMessage(chatId, text, {}); // minden hibára újraküld!
}
```

**Új kód**:
```typescript
} catch (err) {
  const isMarkdownError = err instanceof GrammyError
    && err.error_code === 400
    && err.description.toLowerCase().includes('parse');
  if (!isMarkdownError) throw err; // nem Markdown hiba → ne küldjük újra
  await api.sendMessage(chatId, text, {}); // csak parse hibára fallback
}
```
