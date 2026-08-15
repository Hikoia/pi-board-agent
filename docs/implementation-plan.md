# pi-board-agent — Implementation Plan (v0.2) — REV 2

> Revisione del design dopo le decisioni architetturali dell'utente.
> Documento di lavoro — nessuna modifica al codice prima dell'approvazione.

## Decisioni architetturali (utente)

| # | Decisione |
|---|---|
| 1 | **Dispatch via `pi-dynamic-workflows`** (non headless subprocess) |
| 2 | **Contesto builder basilare** (niente llm-wiki): solo un digest determinista del repo per l'implementazione |
| 3 | **Refine Q&A su GitHub Issue** (opzione A) + **colonne progettate** che coprono tutto il flow |
| 4 | Watchdog: **default 5 giri + cooldown**; "chiede aiuto" all'umano (spiegato sotto) |
| 5 | **Telegram: stesso bot + stesso canale** dei rilasci |
| 6 | **Chat corrente indipendente** dal board; board-agent in **Docker container separato** con pi sempre attiva |
| 7 | **Modello LLM parametrizzabile** (builder/refine/watchdog) |
| — | **Niente SpecKit per l'implementazione** (costa troppo); solo GitHub Projects + issue |

---

## 0. Come dispacciamo i builder (pi-dynamic-workflows)

**Scoperta chiave**: pi-dynamic-workflows espone una **API programmatica usabile dalle estensioni**
(non serve passare dal LLM). Dopo una import diretta:

```ts
import { runWorkflow, createWorktree, removeWorktree, resolveTierModel } from "@quintinshaw/pi-dynamic-workflows";

const script = renderWorkflowSource({ /* tasks, config */ });
const result = await runWorkflow(script, {
  cwd,                 // repo root
  maxAgents: cfg.max_workers,
  agentTimeoutMs: cfg.builder_timeout_ms,
  // model routing: per-phase model dalle meta.phases[] — parametrizzabile
});
```

- `runWorkflow` esegue lo script JS orchestrazione: fan-out `agent()` paralleli con
  **git-worktree isolation** (`createWorktree`), routing del modello per tier, cost accounting,
  resume. Ogni builder = un agente in un worktree dedicato (stessa semantica del v0.1, ora cablata).
- Sostituisce il placeholder `dxRun`/`dxResult` di v0.1.
- La generazione dello script resta in `workflow-prompt.ts` (già presente); va allineata alla
  API reale (firma `agent()`, `parallel()`, worktree).

**Rischio**: dipendiamo dall'API di una componente esterna. Mitigazione: stable export
documentata; `runWorkflow` è la via pubblica; la peer dep si fissa a `>=2.0.0` (già prevista).

---

## 1. Contesto builder — digest determinista basilare

Obiettivo: dare al builder il contesto del repo **senza fargli esplorare tutto**, senza LLM.

### Cosa fa (in dettaglio)

Un comando/script (`src/context.ts`, `/board-agent context`) genera `~/.pi/board-agent/context.md`:

1. **Albero del repo "potato"** — solo i percorsi rilevanti (esclude node_modules, .git, dist,
   build, coverage, .next, lockfile, assets binari). Per ogni file: path, righe, dimensione.
2. **Inventario simboli** (regex, zero LLM): per ogni file `ts/tsx` elenca i simboli esportati
   (`export function|const|default|class`, componenti, route handler, hooks) + le prime righe
   di commento/JSDoc se presenti.
3. **AGENTS.md + README** inclusi (già fonti di verità su architettura/pattern).
4. **package.json per app** — scripts + dipendenze principali.
5. **Git log recente** — ultimi ~30 commit conventional, raggruppati per tipo (feat/fix/ci…),
   per capire "cosa si sta costruendo di recente".
6. *(opzionale, disattivato di default)* riassunto architettura LLM monpassata, cache hash-invalidata.

Target: **< 5K token** (digest basilare). Rigenerato quando cambia l'hash del repo (o `--refresh`).

### Come usa il builder il contesto

La mission del builder (in `workflow-prompt.ts`) include:
- card body (title + acceptance criteria + n. issue)
- **il digest** come sezione fissa `<!-- CONTEXT -->`
- istruzioni: "fai riferimento al CONTEXT per struttura/pattern; leggi i file SOLO se devi".

Così il builder parte orientato, tocca solo i file necessari, e si risparmiano molti token/passaggi.

---

## 2. Colonne del board (flusso completo)

Una singola single-select field **`Status`** con queste 6 colonne (coperte entrambe storie e task):

| # | Colonna | Usata da | Significato / azione |
|---|---|---|---|
| 1 | **Backlog** | storie + task | Idee/non pronte. Non toccate dal loop. |
| 2 | **Ready** | storie | Storia che deve essere **raffinata** (in ingresso nel refine). |
|   | **Ready** | task | Task pronto per essere **implementato** (pick dal loop). |
| 3 | **In Progress** | storie | Refine in corso (modello economico). |
|   | **In Progress** | task | Builder attivo sul task. |
| 4 | **Needs Design** | storie | Refine ha trovato **domande/blocchi**: in attesa risposta umana |
|   | **Needs Design** | task | *(raro)* blocco emerso in implementazione che richiede la persona |
| 5 | **Review** | task | Task implementato con successo (PR del plan aperta o in review). |
| 6 | **Done** | storie + task | Completato: task merged; storia quando la sua PR è mergiata. |

**Riepilogo del flow:**
- **Storia**: Backlog → Ready → (refine) → In Progress → (blocchi?) Needs Design ⇄ In Progress →
  task creati → **Done quando la PR del plan viene mergiata**.
- **Task**: creati dal refine con `Status = Ready` (e `Plan = <slug storia>`) → In Progress → Review
  → Done.
- Il loop picka solo carte **Ready con Plan impostato** (comportamento attuale di v0.1, confermato).

*(Da validare sul project reale: le storie usano un badge/tipo per distinguerle dai task — es.
campo custom `Type` con valori `Story|Task`, oppure item di tipo draft→issue per le storie e
issue per i task. Vedi domande.)*

---

## 3. Refine phase (storia → task) — Q&A su GitHub Issue

- La storia **deve essere linkata/promossa a un'issue** (thread di commenti serve per le Q&A).
- Quando una storia in `Ready` è presa: `Status → In Progress`, parte il **refine** (1 passata,
  modello economico, input: body storia + context digest + AGENTS.md) → output JSON
  `{ goal, impactedAreas[], decisions[], risks[], openQuestions[] }`.
- **Se `openQuestions` non è vuoto** → posta un **commento sull'issue** della storia con le
  domande, `Status → Needs Design`. Il loop NON crea task finché non hanno risposta.
- **Risposta umana**: l'utente risponde **nel thread di commenti dell'issue** (GitHub).
  Il watchdog (o il tick) detecta i **commenti nuovi** dall'ultimo scan (file di stato) → se la
  storia è in `Needs Design`, ri-esegue il refine con le risposte nel contesto.
- **Se non ci sono domande** (o dopo risposta) → crea i **task**: per ogni task,
  - crea **issue** (submit/repo) oppure **sub-issue** della storia (a seconda della scelta),
  - `Status = Ready`, `Plan = <slug>`, body con **Acceptance Criteria**.
- **Idempotenza**: la storia non viene ri-raffinata se già ha task (count task del plan) o un
  marker (custom field `Refined`).

---

## 4. Watchdog (PR CI + mentions + risposta refine)

### Parametri (default richiesti)
```yaml
watchdog:
  enabled: true
  interval_seconds: 300
  fix_rounds_max: 5          # default richiesto (era 3)
  fix_cooldown_minutes: 5
  respond_to_mentions: true
  pr_label: "board-agent"
```

### Ciclo (per PR del bot, label `board-agent`)
1. Lista PR aperte del plan (label `board-agent`).
2. Query **check-runs** (branch-ci + pr-ci): se tutte verdi → niente da fare.
3. Se qualcosa **fallisce** → **fix agent** (worktree sulla branch della PR, legge il log del
   check fallito, commit di fix `fix(scope): ...`, push) → CI riparte.
4. **Cooldown** tra tentativi: non ritentare finché la CI del tentativo precedente non è finita
   (attesa 5 min + check stato).
5. Dopo **5 giri** senza successo → **chiede aiuto all'umano** (spiegato sotto).

### Come chiede aiuto all'umano
1. **Posta un commento sulla PR** con: quali check falliscono, cosa ha provato (lista giri),
   e tagga i reviewer (`@owner` / reviewers config).
2. Aggiunge/cambia **label** `needs-human` (lasciando `board-agent` per continuità).
3. **Notifica Telegram** (stesso bot/canale): "⚠️ PR #42 in attesa di intervento umano — CI
   rossa dopo 5 fix" + link.
4. Mette la/e carta/e del plan in **`Needs Design`** (o un marker) così il flusso è visibile
   sulla board.
5. Il loop **si ferma** su quella PR (non ritenta in automatico) finché non arriva un
   intervento: se l'umano commenta con un **@menzione**, il watchdog riprende (vedi sotto).

### Mentions
- Il watchdog scansiona i commenti nuovi sulle PR del bot. Se contengono `@botLogin`:
  - se è una richiesta generica → risponde (passata agent con context digest) postando una reply.
  - se contiene istruzioni/richiesta di fix → applica (fix agent).
- Serve file di stato `seen-comments.json` (id commenti già processati) per idempotenza.

---

## 5. Telegram (stesso bot + canale)

- Config:
```yaml
telegram:
  enabled: true
  bot_token_env: "TELEGRAM_BOT_TOKEN"
  chat_id_env: "TELEGRAM_CHAT_ID"
  on: ["needs_human", "pr_opened", "ci_fixed", "task_failed", "refine_questions"]
```
- **Stesso bot + stesso canale** già usati dal progetto principale. Solo `sendMessage` (Bot API)
  — nessun `getUpdates` → nessun conflitto di long-polling con la chat corrente (che resta
  indipendente).
- `src/notify.ts`: wrappper Bot API (HTML, truncate 4096), eventi come sopra.

---

## 6. Deployment: Docker container separato (pi sempre attiva)

Questa chat resta indipendente dal board. Il board-agent gira in un **container Docker** con una
istanza pi dedicata sempre attiva, "come questo processo".

- **Immagine**: base node + pi installato, docker-compose unità.
- **Avvio**: il container avvia pi in **headless** con l'estensione pi-board-agent caricata e la
  CI grep del loop che parte all'avvio (o `/board-agent run` come entrypoint con
  `setInterval` nel processo pi headless).
- **Persistenza/git**: monta il volume con il clone dei repo target (es `/repo/board-game-organizer`)
  + `.pi/` (config, inflight, context, stato).
- **Credenziali**: `gh` auth (bot GitHub App / PAT) + env Telegram nel container.
- **Controllo**: comandi via `docker exec` oppure via comandi GitHub (commenti `@board-bot`).
  La notifica resta sul canale condiviso.
- **Log**: → stdout del container (raccolti da docker), quindi nessun file da gestire.

*(Implicazione: il loop vive nel processo pi del container, non nella chat corrente. La chat
corrente non lancia comandi board. Conferma nelle domande — vedi sotto.)*

---

## 7. Modello LLM parametrizzabile

Config:
```yaml
models:
  builder: "anthropic/claude-sonnet-4"
  refine: ""          # default = modello economico (es. flash tier)
  watch: ""           # default = refine
```
Usati via `resolveTierModel` / meta `phases[].model` di pi-dynamic-workflows per il builder,
e come override per refine/watchdog. Un comando `/board-agent models` elenca i modelli
disponibili (via `listAvailableModels`).

---

## 8. Ordine di implementazione

1. **Fase A — cablare il dispatch** (runWorkflow + worktree isolation) + fix v0.1 placeholder.
2. **Fase B — contesto basilare** (`context.ts` → digest) + iniezione nella mission del builder.
3. **Fase C — refine** (storia → issue → task; colonne; Q&A su issue).
4. **Fase D — watchdog** (fix 5 giri + cooldown + needs-human + mentions).
5. **Fase E — Telegram** (notify + eventi).
6. **Fase F — Docker** (container pi headless + systemd/compose + docs Raspberry).
7. **Fase G — test/hardening/CI** (test offline, board mock, CI repo).

Ogni fase = branch `feat/v0.2-*` + PR su pi-board-agent (aperta a richiesta).

---

## 9. Rischi / decisioni da confermare

- **Storie vs task sulla stessa board**: come le distinguiamo (campo `Type`? tipo item)? → domanda.
- **Task come issue semplici o sub-issue della storia?** → domanda.
- **Modello builder di default** (quale provider/tier)?
- **Controllo board-agent nel container**: **B + a** — comandi via **commenti GitHub**
  (`@board-bot status/stop/refine …`, il watchdog li interpreta) come canale primario, e
  `docker exec` come fallback locale. (La chat Telegram corrente resta fuori dal board.)
- **pi headless nel container**: confermato — headless con loop auto-start (entrypoint).