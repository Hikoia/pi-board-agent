# pi-board-agent — Implementation Plan (v0.2)

> Design documento per estendere pi-board-agent al workflow completo:
> board → refine → task → implementazione → PR → watchdog → Telegram.
> Documento di lavoro — nessuna modifica al codice prima dell'approvazione.

## 0. Audit dello stato attuale (v0.1.1)

| Area | Stato | Note |
|---|---|---|
| Loop di polling (tick, claim, safety) | ✅ completo | `loop.ts` — mutex assignee, inflight lockfile, orphan scan, stuck-building cap |
| Raggruppamento per Plan + PR | ✅ completo | `plan.ts` — una PR per plan quando tutte le carte sono Done |
| Dispatch dei builder | ❌ **placeholder** | `index.ts` `dxRun` ritorna un runId finto; `dxResult` ritorna `[]` — **i worker non vengono mai lanciati** ("deferred to v0.2") |
| Skill builder | ✅ completa | `skills/board-agent/SKILL.md` — worktree → task branch → implement → commit → squash merge in `plan/<slug>` → outcome JSON |
| GitHub access | ✅ via `gh` CLI GraphQL | `gh.ts` — listCards, setStatus, tryClaim/release, openPr, findPr, ensureLabels |
| Refine (storia → task) | ❌ assente | Le carte SONO i task; nessuna gestione storie |
| llm-wiki (contesto repo) | ❌ assente | I builder devono esplorare il repo da soli (costo token alto) |
| Watchdog (pr-ci fallito / mentions) | ❌ assente | Solo retry a livello carta |
| Telegram | ❌ assente | |
| Daemon Raspberry | ❌ assente | v0.1 gira in foreground TUI |

**Conseguenza chiave**: la Fase 1 è il cablaggio del dispatch reale — senza, tutto il resto è teoria.

---

## 1. Fase 1 — Dispatch reale dei builder (fondamenta)

Obiettivo: il loop deve davvero implementare i task in worktree isolati.

### Opzione A (consigliata): subprocess `pi` headless
Il loop, per ogni carta claimata:
1. crea il worktree (`git worktree add` su `plan/<slug>` o `main`)
2. lancia `pi` in **headless** (nuova sessione, cwd = worktree) con:
   - mission prompt: "Implementa il task T001 per il plan 001-auth (vedi card body). Segui la skill board-agent."
   - skill caricata: `board-agent` + nuova skill `board-agent-context` (wiki)
   - modello configurato (`builder_tier` → modello specifico)
   - timeout (`builder_timeout_ms`), output JSON su stdout
3. attende l'exit code, parsifica l'outcome JSON, aggiorna la board
4. pulisce il worktree

Pro: self-contained, testabile offline con `pi --headless` finto, nessuna dipendenza
dagli interni di pi-dynamic-workflows, facile daemonizzare. Contro: un processo pi
per task (overhead moderato, ok su Pi).

### Opzione B: cablare pi-dynamic-workflows
Usare `dx.workflow.run()` (CMD surface) o esporre un tool custom. Pro: riusa
worktree-isolation già testata. Contro: dipende da API di terze parti che l'autore
di v0.1 non è riuscito a cablare in modo pulito (commenti in index.ts).

**Scelta**: A, con B come fallback documentato.

### Criteri di done
- `/board-agent run` con una carta Ready → builder reale lancia, implementa, committa
  (squash merge in plan/<slug>), carta → Review.
- Test offline con un builder finto (script che ritorna JSON predefinito).

---

## 2. Fase 2 — llm-wiki (contesto repo per LLM, token-efficiente)

Obiettivo: dare al LLM (builder + refine) il contesto del codice esistente
**senza fargli esplorare il repo**, risparmiando token.

### Design
- **Comando**: `/board-agent wiki` (rigenera) + generazione automatica quando il
  hash del repo cambia (file `.pi/board-agent/wiki.md`).
- **Estrattore deterministico (zero token LLM)** — `src/wiki.ts`:
  - albero del repo **potato** (esclude node_modules, .git, lockfile, dist, coverage, .next, build)
  - inventario file: path + righe + dimensione
  - simboli esportati per file (regex su `export`, `export default`, `function`,
    `const X =`, componenti, route handler) — per ts/tsx/md/yml/json
  - commenti chiave: JSDoc/block comment di testa per file, sezioni `##` dei markdown
  - AGENTS.md + README inclusi (già fonti di verità)
  - `package.json` scripts + dipendenze principali per app
  - **git log recente** (ultimi ~30 commit conventional, raggruppati per tipo)
- **Passata LLM opzionale (1 sola, modello economico)**: "riassunto architettura"
  (~1-2KB) generato una volta per versione del repo (cache hash-invalidata).
- **Output**: un unico markdown, target **< 10K token**.
- **Iniezione**: la mission del builder e la fase refine ricevono il wiki come
  contesto fisso, invece di "esplora il repo".

### Config
```yaml
wiki:
  enabled: true
  target: ".pi/board-agent/wiki.md"
  max_chars: 40000        # ~10K token
  llm_summary: true       # passata architettura (modello economico)
  model: ""               # default = modello economico configurato
  exclude: []             # extra glob da escludere
```

### Criteri di done
- Il wiki generato su board-game-organizer è leggibile e copre le aree chiave
  (auth Clerk, API relationships, app shell, packages).
- Il builder riceve il wiki e implementa un task senza "esplorare" il repo.

---

## 3. Fase 3 — Refine phase (storia → task)

Obiettivo: quando una **storia** entra in Ready, l'agent la raffina (contesto wiki)
e la spezza in **task** (carte sulla board, campo Plan = slug storia).

### Flusso
```
Storia (card) in "Ready"
  → refine (1 passata, modello economico, input: body storia + wiki + AGENTS.md)
  → output JSON: goal · aree impattate · decisioni · rischi · domande aperte
  → se domande/blocchi → commento sulla storia + stato "Needs Design" (colonna config)
      → l'umano risponde nel commento → refine riparte
  → altrimenti → crea N task:
      - via GraphQL addItem (carte sul project, Plan=<slug>, Status=Ready, body con
        acceptance criteria) — oppure sub-issue GitHub collegate alla storia
  → marca la storia "refined" (custom field o marker nel body) per idempotenza
```

### Comandi
- `/board-agent refine <plan>` — raffina/ri-raffina un plan
- Integrazione nel loop: se esistono carte-storia Ready non ancora refine → auto.

### Config
```yaml
refine:
  enabled: true
  story_column: "Ready"      # colonna delle storie (se distinta da quella dei task)
  needs_design_column: "Needs Design"
  model: ""                  # modello economico (default)
  create_as: "cards"         # "cards" | "subissues"
  task_prefix: "T"
  auto: true                 # refine automatico nel loop
```

### Note
- Idempotenza: marker `refined: <ts>` nel body o custom field; il loop non
  ri-raffina.
- I task creati hanno già il Plan → il loop esistente li picka senza modifiche.

### Criteri di done
- Storia Ready → task creati sulla board con acceptance criteria.
- Storia con blocchi → commento + colonna Needs Design, nessun task creato.

---

## 4. Fase 4 — Watchdog (PR CI + mentions)

Obiettivo: dopo l'apertura della PR, l'agent corregge i fallimenti di CI e
risponde alle @menzioni, finché tutto è verde e nessuno lo menziona.

### Design (`src/watchdog.ts`, comando `/board-agent watchdog`, integrato nel loop)
- **Ciclo PR**: lista PR aperte con label `board-agent` → per ognuna:
  - query check-runs (branch-ci + pr-ci) via `gh api`
  - se fallita → **fix agent**: worktree sulla branch della PR → legge il log dei
    check falliti → fix commit (conventional, `fix(scope): ...`) → push → CI riparte
  - cooldown tra i giri (es. 5 min) + tetto di fix (es. 3) → poi commento "serve aiuto"
  - se verde → nessuna azione
- **Mentions**: commenti recenti sulle PR del bot (stato "seen" in un file sotto
  `.pi/board-agent/`) → se contengono `@botLogin` → passata agent per rispondere/
  applicare (con wiki) → reply via `gh api`.
- Idempotenza: lockfile per PR (`inflight` riusato) + file state dei commenti visti.

### Config
```yaml
watchdog:
  enabled: true
  interval_seconds: 300
  fix_max_rounds: 3
  fix_cooldown_minutes: 5
  respond_to_mentions: true
  pr_label: "board-agent"
```

### Criteri di done
- PR con pr-ci rosso → commit di fix automatico → verde.
- Commento con @bot → risposta/revisione applicata.

---

## 5. Fase 5 — Telegram

Obiettivo: notifiche sul canale (stessi secret/format di board-game-organizer).

- `src/notify.ts`: wrapper Bot API (HTML, truncate 4096), token da **env**
  (`TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`), mai nel yml.
- Eventi: task fallito dopo retry, storia in Needs Design, PR aperta, CI verde
  dopo fix, "serve intervento umano".
- Riusa il formato già collaudato (title + changelog/riepilogo + link).

### Config
```yaml
telegram:
  enabled: true
  chat_id_env: "TELEGRAM_CHAT_ID"     # o valore diretto
  on: ["pr_opened", "ci_fixed", "needs_human", "task_failed"]
```

### Criteri di done
- PR aperta dal loop → messaggio sul canale con link e riepilogo task.

---

## 6. Fase 6 — Daemon mode (Raspberry Pi)

Obiettivo: il loop gira 24/7 senza TUI foreground.

- `/board-agent run --daemon` (o comando `daemon`): distacco dal TUI, log su file
  (`.pi/board-agent/daemon.log`), pidfile single-instance, gestione SIGTERM =
  graceful stop (come `/board-agent stop`).
- Stato condiviso: loopState su file (`.pi/board-agent/state.json`) così
  `/board-agent status` funziona anche daemonizzato.
- `docs/raspberry.md`: unit systemd di esempio (`Restart=always`, utente dedicato,
  `gh` auth con bot GitHub App token, env Telegram).

### Criteri di done
- `systemctl start pi-board-agent` → loop attivo; riavvio automatico su crash;
  `/board-agent stop` graceful; status leggibile da fuori.

---

## 7. Fase 7 — Test, hardening, docs

- Test offline per ogni modulo (`config`, `wiki`, `refine`, `watchdog`, `notify`)
  nello stile `tests/run-offline.sh` (stub `gh` e `pi`).
- Test integrazione con **board mock** (GraphQL fake) per loop + watchdog.
- CI del repo pi-board-agent: job test + lint (release.yml esiste già per npm).
- README + architecture.md aggiornati; CHANGELOG.
- Sicurezza: GitHub App (produzione) vs PAT (dev); nessun secret nei file;
  rate-limit GraphQL (tick ≥ 90s, budget condiviso refine/watchdog).

---

## 8. Ordine di implementazione consigliato

1. **Fase 1** (dispatch reale) — senza, nulla funziona
2. **Fase 2** (llm-wiki) — prerequisito per refine e builder economici
3. **Fase 3** (refine) — sblocca il flusso storia→task
4. **Fase 4** (watchdog) — chiude il loop PR
5. **Fase 5** (Telegram) — osservabilità
6. **Fase 6** (daemon) — deploy su Raspberry
7. **Fase 7** (test/docs)

Ogni fase è un commit/PR separato sul repo pi-board-agent (branch `feat/v0.2-*`).

## 9. Rischi

- **pi-dynamic-workflows non cablato**: mitigato dalla scelta subprocess `pi` headless.
- **Rate limit GraphQL**: tick conservativo + budget condiviso.
- **Modelli** (quale modello per builder/refine): parametrizzare via config.
- **Board model**: storie vs task sulla stessa board richiede colonne/field chiari
  (config per colonna storie) — da validare sul project reale.
- **Bot GitHub App**: serve setup (permessi issues/projects/PR) prima della Fase 6.
