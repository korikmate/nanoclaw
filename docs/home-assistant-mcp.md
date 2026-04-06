# Home Assistant MCP Integration

## Áttekintés

A NanoClaw agent képes közvetlenül vezérelni a Home Assistant-ot MCP (Model Context Protocol) eszközökön keresztül. Két runner esetén eltérő a megvalósítás.

---

## Konfiguráció

### 1. `.env` (host)

```env
HA_MCP_URL=https://<nabu-casa-id>.ui.nabu.casa/mcp_server/sse
HA_MCP_TOKEN=<long-lived-access-token>
```

A tokent a HA webes felületén hozd létre: *Profil → Hosszú élettartamú hozzáférési tokenek*.

### 2. `.mcp.json` (project root)

```json
{
  "mcpServers": {
    "home-assistant": {
      "type": "sse",
      "url": "https://<nabu-casa-id>.ui.nabu.casa/mcp_server/sse",
      "headers": {
        "Authorization": "Bearer <token>"
      }
    }
  }
}
```

Ez a fájl a `container-runner.ts` által automatikusan bekerül az új group session `settings.json`-jába.

### 3. `.claude/settings.json` (project root)

```json
{
  "mcpServers": {
    "home-assistant": {
      "type": "sse",
      "url": "https://<nabu-casa-id>.ui.nabu.casa/mcp_server/sse",
      "headers": {
        "Authorization": "Bearer <token>"
      }
    }
  }
}
```

A Claude Agent SDK `settingSources: ['project', 'user']` alapján olvassa be.

---

## Hogyan kerül be a containerbe

### Claude SDK runner (`index.ts`)

Az `HA_MCP_URL` és `HA_MCP_TOKEN` env varokat a `container-runner.ts` adja át a containernek (`-e` flag). A `runQuery()` hívásban a `mcpServers` opcióba kerül:

```typescript
...(process.env.HA_MCP_URL && process.env.HA_MCP_TOKEN
  ? {
      'home-assistant': {
        type: 'sse',
        url: process.env.HA_MCP_URL,
        headers: { Authorization: `Bearer ${process.env.HA_MCP_TOKEN}` },
      },
    }
  : {}),
```

Az `allowedTools` listában: `mcp__home-assistant__*` (ha `HA_MCP_URL` be van állítva).

### OpenRouter runner (`openrouter-runner.ts`)

Az SSE kliens direktben csatlakozik a HA MCP szerverhez és a tool-okat az OpenAI function calling formátumba konvertálja. **Fontos:** a tool nevekben aláhúzás van, nem kötőjel:

```
mcp__home_assistant__HassTurnOn    (OpenRouter runner)
mcp__home-assistant__HassTurnOn    (Claude SDK runner)
```

---

## Elérhető tool-ok

| Tool | Funkció |
|------|---------|
| `HassTurnOn` | Entitás bekapcsolása |
| `HassTurnOff` | Entitás kikapcsolása |
| `HassLightSet` | Lámpa fényerő/szín beállítása |
| `HassClimateSetTemperature` | Termosztát hőmérséklet |
| `HassListAddItem` | Todo/bevásárlólista elem hozzáadása |
| `HassListCompleteItem` | Lista elem megjelölése késznek |
| `HassListRemoveItem` | Lista elem törlése |
| `HassCancelAllTimers` | Összes HA időzítő törlése |
| `GetLiveContext` | Entitások/területek aktuális állapota |
| `GetDateTime` | Aktuális dátum/idő HA-ból |
| `todo_get_items` | Todo/bevásárlólista lekérdezése |

---

## CLAUDE.md — group szintű dokumentálás

Az OpenRouter runner esetén a modell a system promptból (CLAUDE.md) tanulja meg a tool neveket. A group `CLAUDE.md`-be be kell írni a tool-okat a pontos névvel (aláhúzással):

```markdown
## Home Assistant

| Tool | Purpose |
|------|---------|
| `mcp__home_assistant__HassTurnOn` | Turn on any entity |
| `mcp__home_assistant__HassTurnOff` | Turn off any entity |
...
```

Ha ez hiányzik, a modell nem fogja használni az MCP tool-okat még akkor sem, ha csatlakoznak.

---

## Hibaelhárítás

### "HA MCP connected" látszik a logban, de a modell nem használja

Az OpenRouter modell a session history-ból "emlékszik" hogy nincs HA tool-ja. Megoldás:

```bash
rm /root/nanoclaw/groups/<group>/.openrouter-session.json
```

### Tool-ok nem jelennek meg az agent tool listájában (OpenRouter)

A modell `mcp__home-assistant__*` (kötőjel) neveket keres, de az OpenRouter runner `mcp__home_assistant__*` (aláhúzás) nevekkel regisztrálja. A CLAUDE.md-ben az aláhúzásos verziót kell dokumentálni.

### Settings.json nem frissül új MCP config esetén

A `container-runner.ts` csak egyszer hozza létre a settings.json-t (ha nem létezik). Ha már létező group esetén adunk hozzá MCP-t, manuálisan kell frissíteni:

```bash
cat /root/nanoclaw/data/sessions/<group>/.claude/settings.json
# Ha hiányzik a mcpServers blokk, töröld a fájlt — újraindításkor újragenerálja
rm /root/nanoclaw/data/sessions/<group>/.claude/settings.json
```
