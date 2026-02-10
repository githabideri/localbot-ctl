# localbot-ctl

OpenClaw plugin for controlling local LLM inference via `/lb*` chat commands.

## Commands

| Command | Description | Auth Required |
|---------|-------------|---------------|
| `/lbh` | Help — show available commands | Yes |
| `/lbm` | Models — list available models with specs | Yes |
| `/lbn <room>` | New session — reset LocalBot context | Per-room* |
| `/lbs` | Status — active endpoint, model, session tokens | Yes |
| `/lbe` | Endpoints — show all inference backends | Yes |
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

## License

MIT

## Links

- [Specification](./SPEC.md) — Authoritative command behavior
- [Changelog](./CHANGELOG.md) — Version history
