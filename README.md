# localbot-ctl

OpenClaw plugin for controlling local LLM inference via `/lb*` chat commands.

## Commands

| Command | Description | Auth Required |
|---------|-------------|---------------|
| `/lbh` | Help — show available commands and backend info | Yes |
| `/a [filter]` | Alias quick list for `/model` usage | Yes |
| `/aliases [filter]` | Same as `/a` | Yes |
| `/lbm` | Models — list available models with specs | Yes |
| `/lbn <room>` | New session — reset LocalBot context | Per-room* |
| `/lbs` | Status — backend state, GPU/CPU slots, and per-room context usage | Yes |
| `/lbe` | Endpoints — show all inference backends | Yes |
| `/lbw <backend>` | Switch backend (llama-cpp\|vllm\|stop) | Yes |
| `/lbp` | Performance — benchmark active endpoint | Yes |

*See Security section below.

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
| `config/localbot-rooms.json` | Room mappings (room ID → agent, permissions) |

Copy `config/localbot-rooms.example.json` to your workspace and customize.

## Requirements

- llama-cpp server (or vLLM/Ollama) running
- LocalBot agents configured in OpenClaw
- Matrix rooms with LocalBot access

## Known Limitations

- **Room auto-detection not possible**: OpenClaw plugin commands don't receive `conversationId`, so `/lbn` requires the room argument. This is an upstream limitation.
- **Model switching not implemented**: `/lbm <alias>` is planned but requires llama-cpp server interaction.
- **Config path**: Room config path is currently hardcoded to workspace. Override via plugin config if needed.

## Matrix mention routing (tiered binding order)

LocalBot routing in Matrix relies on a "tiered" specificity order: room-level bindings (matching `peer.kind` + `peer.id`) are evaluated before account-scoped constraints, and the catch-all `{"channel": "matrix"}` binding only matches once everything else misses. Keep this order intact when editing `config/localbot-rooms.json` or adding new agents, because the binding hierarchy determines whether messages routed via `@clawdbot` will reach the intended room-specific LocalBot or fall through to Felix.

More background and the recent regression fix are documented without workspace secrets in `/var/lib/clawdbot/workspace/fundus/localbot-mentions.md`.

## Backend Switching (wechsler-llm)

`/lbw` integrates with [wechsler-llm](https://github.com/githabideri/wechsler-llm) for clean backend switching:

- Only one GPU backend runs at a time (llama-cpp OR vLLM)
- Switching automatically saves/restores KV cache state
- `/lbs` shows GPU memory, all slot states (GPU + local CPU), and room-level OpenClaw session context usage (`used/cap`)
- `/lbs` starts with an **operator-first quick line** (`Quick ctx`) for the most recently active room: `used / effective-cap` with a small usage bar

`/lbs` context semantics:
- **Runtime model** (`📦 Runtime model`) = model currently loaded by the active backend
- **Room model label** (`session-tag ...`) = model tag from OpenClaw session store for that room
  - this can differ from runtime model during transitions/sticky overrides and is now explicitly labeled
- **Quick ctx** = latest active room load shown as `used / effective-cap`
  - `effective-cap = min(runtime ctx cap, room session cap)`
- **Runtime ctx cap** = backend-reported slot/model capacity (from endpoint + slot status)
- **Room `used/cap`** = OpenClaw session-store prompt tokens versus session context limit per room
- Room groups:
  - `✅ Active (<24h)`
  - `💤 Stale (>=24h)` (excluded from aggregate `in-context` total)
- **`store>cap` marker** = stored counters exceeded cap; display is clamped to cap to avoid misleading >100% ratios

Configure by adding a `wechsler` block to `inference-endpoints.json`:
```json
{
  "wechsler": {
    "scriptPath": "/path/to/wechsler-llm/wechsler.sh",
    "managedEndpoints": ["llmlab-llama", "llmlab-vllm"]
  }
}
```

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
- [wechsler-llm](https://github.com/githabideri/wechsler-llm) — Backend switching ops toolkit
