# Telegram Control Commands

Beépített parancsok, amelyeket a csoportban közvetlenül beírva, trigger szó nélkül lehet használni.

## Parancsok

| Parancs | Leírás |
|---------|--------|
| `/new` | Graceful container close. Mem0 memory extraction lefut, a következő üzenet új sessiont indít. |
| `/kill` | Force-kill az aktív Docker container (azonnali, mem0 extraction nem fut le). |
| `/restart` | Teljes nanoclaw process újraindítása (2 mp delay, új process indul, log: `/tmp/nanoclaw.log`). |
| `/status` | Aktuális modell, provider, container állapot, group neve. |

## Implementáció

A parancsokat `src/index.ts` `processGroupMessages()` funkciója kezeli, a container indítása előtt, a `/new` parancs mintájára.

- `/kill` → `queue.killContainer(chatJid)` → `stopContainer(containerName)` (`docker stop -t 1`)
- `/restart` → detached `bash` subprocess: `sleep 2 && kill <pid> && nohup node <path> > /tmp/nanoclaw.log 2>&1 &`
- `/status` → `OPENROUTER_MODEL`, `OPENROUTER_PROVIDER` (config.ts), `queue.isActive(chatJid)`

Érintett fájlok:
- `src/index.ts` — parancs dispatch
- `src/group-queue.ts` — `isActive()`, `killContainer()` metódusok
