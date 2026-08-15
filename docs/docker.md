# Docker deployment (Raspberry Pi)

The board-agent runs in a container with its own pi instance, always on —
independent from any chat session. It watches the GitHub Project (v2), refines
stories, implements tasks in worktrees, opens PRs, fixes failing CI and posts
Telegram notifications to the same bot/channel used by the releases.

## How it works

```
docker-compose.yml
 └─ board-agent container (linux/arm64)
     ├─ gh CLI authenticated with GH_TOKEN (git credential helper too)
     ├─ pi headless (--print) with pi-board-agent + pi-dynamic-workflows
     │    └─ extension auto_start: true → BoardLoop starts at session start
     │         └─ the loop's setInterval keeps the pi process alive forever
     ├─ /workspace  ← the target repo (e.g. board-game-organizer), mounted
     └─ /root/.pi/agent ← named volume: sessions, context, inflight, state
```

The pi `--print` mode does **not** force-exit on completion (it only sets the
exit code), so an active timer (the loop's `setInterval`) keeps the process
running. `restart: unless-stopped` is a safety net.

## Setup

1. Prepare the target repo with its board config:

```bash
# in the board-game-organizer clone that will be mounted at /workspace
mkdir -p .pi
# write .pi/board-agent.yml (see config-template.yml): project.number,
# columns, models, and `auto_start: true`
```

2. Configure the container env — copy `.env.example` to `.env` and fill in:

| Variable | Purpose |
|---|---|
| `GH_TOKEN` | Fine-grained PAT: Issues/PRs/Contents write on the target repo + org Projects read/write (git push uses gh's credential helper) |
| `TELEGRAM_BOT_TOKEN` | Bot token (same bot as the release channel) |
| `TELEGRAM_CHAT_ID` | Channel id (same channel) |
| `ANTHROPIC_API_KEY` (or your provider key) | API key for the pi models (builder/refine/watch — default `deepseek-v4-flash-0731`) |

3. Build and start:

```bash
docker compose up -d --build
docker compose logs -f board-agent        # watch the loop
docker compose exec board-agent gh api user --jq .login
```

## Control

- **GitHub comments** (primary): `@<bot-login> status|stop|refine <plan>` on any
  issue/PR — the watchdog parses them.
- **docker exec** (fallback): `docker compose exec board-agent pi --print "..."`.

## Persistence & safety

- The board is the source of truth: if the container dies mid-task, the next
  start re-reads cards; inflight lockfiles + the assignee mutex prevent
  double-dispatch.
- `watchdog-state.json` / `refine-state.json` live under `.pi/board-agent/` in
  the target repo; the pi home volume keeps sessions/context.
- Stop gracefully: `docker compose stop` (SIGTERM → extension stops the loop
  and releases claims).
