# localbot-ctl

OpenClaw plugin for controlling local LLM inference via `/lb*` chat commands.

## Commands

| Command | Description | Auth Required |
|---------|-------------|---------------|
| `/lbh` | Help — show available commands and backend info | Yes |
| `/a [filter]` | Alias quick list for `/model` usage | Yes |
| `/aliases [filter]` | Same as `/a` | Yes |
| `/lbm [alias]` | Models — list, switch once, or persist default | Yes |
| `/lbn <room>` | New session — reset LocalBot context | Per-room* |
| `/lbs [full]` | Status — compact view by default; `full` shows detailed slots + all room context lines | Yes |
| `/lbe` | Endpoints — show all inference backends | Yes |
| `/lbw <arg>` | Switch/status (llama-cpp\|vllm\|stop\|status) | Yes |
| `/lbp` | Performance — benchmark active endpoint | Yes |

*See Security section below.

## Model Switching Semantics (`/lbm`)

- `/lbm <alias> --once ...` (default mode if omitted): non-persistent runtime target update.
- `/lbm <alias> --default ...` (or `--set-default`): persists target agents' `model.primary` in `openclaw.json`.
- `/lbm --show-default`: shows persisted `model.primary` for configured LocalBot+ht target agents.
- `--scope active` (default): update only latest Matrix session entry per mapped room.
- `--scope all`: update all stored session entries for target agents (includes cron/main/subagent).
- Backend shortcuts: `-bl` (llama-cpp), `-bv` (vllm), `-bo` (ollama).
- Endpoint override: `-e <endpoint-id>`.

Resolution order when endpoint is omitted:
- alias override (`modelSwitch.routing.aliasOverrides`)
- backend default (`modelSwitch.routing.backendDefaults`)
- single endpoint for backend
- error if still ambiguous

Important scope/caveat:
- `--default` applies to new sessions only; it does not rewrite existing chat context.
- Matrix monitor/runtime may still need a gateway restart before `/new` consistently picks updated persisted defaults.

## Security Model

### Authorization Levels

The plugin distinguishes between:
- **Authorized users** — Users on the OpenClaw `allowFrom` list (owner/admins)
- **Guests** — Anyone else with access to a room

### Command Authorization

Most commands require authorization (`requireAuth: true`). Unauthorized users get:
```
⚠️ This command requires authorization.
```

### Per-Room Reset Authorization (`/lbn`)

Session resets use a per-room security model via the `publicReset` flag:

| `publicReset` | Who Can Reset |
|---------------|---------------|
| `true` | Anyone (guests included) |
| `false` | Authorized users only |

**Behavior:**
- Guests can only reset rooms where `publicReset: true`
- Guests cannot reset private rooms, even if they know the room name
- Authorized users can reset any room

**Error for unauthorized reset attempt:**
```
❌ Only authorized users can reset this room
```

**Room list shown to users:**
- Authorized users see all rooms in `/lbn` help
- Guests only see rooms where `publicReset: true`

### Why This Design

In shared/public rooms, guests should be able to reset their conversation without affecting private workspaces. The `publicReset` flag enables granular control per room.

## Installation

1. Clone to your workspace plugins directory
2. Add to OpenClaw config:

```json
{
  "plugins": {
    "load": {
      "paths": ["/path/to/localbot-ctl"]
    },
    "entries": {
      "localbot-ctl": { "enabled": true }
    }
  }
}
```

3. Restart gateway

## Configuration

The plugin reads from your workspace `config/` directory:

| File | Purpose |
|------|---------|
| `config/inference-endpoints.json` | Endpoint definitions |
| `config/localbot-models.json` | Model metadata (speeds, context, aliases) |
| `config/localbot-rooms.json` | Room mappings (room ID → agent, permissions, optional `basePromptTokens` baseline) |

Copy `config/localbot-rooms.example.json` to your workspace and customize.

## Requirements

- llama-cpp server (or vLLM/Ollama) running
- LocalBot agents configured in OpenClaw
- Matrix rooms with LocalBot access

## Known Limitations

- **Room auto-detection not possible**: OpenClaw plugin commands don't receive `conversationId`, so `/lbn` requires the room argument. This is an upstream limitation.
- **Model switch scope**: `/lbm` updates session model tags for configured target agents; this does not hard-replace current prompt history in active runs.
- **Session update scope default**: `/lbm` defaults to `--scope active`, so rooms without an existing Matrix session entry are intentionally untouched until first activity.
- **Bulk scope is explicit**: use `--scope all` only when you intentionally want to retag cron/subagent/main entries as well.
- **Persisted defaults are not guaranteed hot-reloaded**: after `--default`, `/new` can still use prior defaults until runtime/channel reload.
- **Config path**: Room config path is currently hardcoded to workspace. Override via plugin config if needed.
- **Native command mode required**: in Matrix group rooms (for example `llmlab`), `/lb*` command interception is reliable only when OpenClaw command mode is explicit, not heuristic auto mode.

## Command Interception Guardrail

Set this in active OpenClaw config:

```json
"commands": {
  "native": true,
  "nativeSkills": true
}
```

Why: with `native: "auto"`, some Matrix deliveries can be normalized into wrapped room text before command matching, and `/lb*` can be passed through to the model as plain chat.  
Symptom: `/lbm --show-default` gets answered by the LLM persona instead of returning plugin output.

## Matrix mention routing (tiered binding order)

LocalBot routing in Matrix relies on a "tiered" specificity order: room-level bindings (matching `peer.kind` + `peer.id`) are evaluated before account-scoped constraints, and the catch-all `{"channel": "matrix"}` binding only matches once everything else misses. Keep this order intact when editing `config/localbot-rooms.json` or adding new agents, because the binding hierarchy determines whether messages routed via `@clawdbot` will reach the intended room-specific LocalBot or fall through to Felix.

More background and the recent regression fix are documented without workspace secrets in `/var/lib/clawdbot/workspace/fundus/localbot-mentions.md`.

## Backend Switching (ops/wechsler)

`/lbw` integrates with the vendored wechsler toolkit at `ops/wechsler/` for clean backend switching:

- Only one GPU backend runs at a time (llama-cpp OR vLLM)
- Switching automatically saves/restores KV cache state
- Switch/stop operations use a lock file to prevent concurrent backend flips (`/tmp/wechsler-switch.lock` by default)
- wechsler writes a source-of-truth state file (`/tmp/wechsler-active-backend` by default)
- `/lbs` shows GPU memory, all slot states (GPU + local CPU), and room-level OpenClaw session context usage (`used/cap`)
- `/lbs` starts with an **operator-first quick line** (`Quick ctx`) for the most recently active room: `used / effective-cap` with a small usage bar

`/lbs` context semantics:
- **Source-of-truth backend** (`🧭 Source-of-truth`) = backend last written by wechsler switch/stop flow
  - if this differs from live endpoint probe, `/lbs` warns and suggests reconciliation
- **Runtime model** (`📦 Runtime model`) = model currently loaded by the active backend
- **Room model label** (`session-tag ...`) = model tag from OpenClaw session store for that room
  - this can differ from runtime model during transitions/sticky overrides and is now explicitly labeled
- **Quick ctx** = latest active room load shown as `used / effective-cap`
  - `effective-cap = min(runtime ctx cap, room session cap)`
  - if provider counters are missing/zeroed, `/lbs` falls back to `estimate` source and can apply optional static room baseline (`basePromptTokens`) from `localbot-rooms.json`
- **Runtime ctx cap** = backend-reported slot/model capacity (from endpoint + slot status)
- **Room `used/cap`** = estimated prompt context usage versus session context limit per room
- **Source label** (`source ...`) indicates the metric origin in priority order:
  - `transcript` (preferred)
  - `totalTokens`
  - `inputTokens`
  - `input+output`
  - `estimate` (recent transcript char heuristic /4, optionally with `basePromptTokens`)
- Room groups:
  - `✅ Active (<24h)`
  - `💤 Stale (>=24h)` (excluded from aggregate `in-context` total)
- **`counter-drift` marker** = non-transcript counter exceeded cap
- **`ctx>cap` marker** = transcript-derived context estimate exceeded cap

Configure by adding a `wechsler` block to `inference-endpoints.json`:
```json
{
  "wechsler": {
    "scriptPath": "/var/lib/clawdbot/workspace/plugins/localbot-ctl/ops/wechsler/wechsler.sh",
    "managedEndpoints": ["llmlab-llama", "llmlab-vllm"]
  }
}
```

If `scriptPath` is omitted, localbot-ctl defaults to:
`/var/lib/clawdbot/workspace/plugins/localbot-ctl/ops/wechsler/wechsler.sh`

### Reasoning profile ownership

`localbot-ctl` does **not** set model reasoning budgets or prompt reasoning style.
Those are owned by backend service config + agent prompt policy (e.g. in wechsler/openclaw setup).

Current recommended Nemotron profile used in llmlab:
- server: `--reasoning-format deepseek --reasoning-budget -1`
- prompt style: brief constrained reasoning

## License

MIT

## Links

- [Specification](./SPEC.md) — Authoritative command behavior
- [Changelog](./CHANGELOG.md) — Version history
- [ops/wechsler/README.md](./ops/wechsler/README.md) — Backend switching ops toolkit (vendored)
