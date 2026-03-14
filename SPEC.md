# localbot-ctl Specification

**Version:** 0.1.0  
**Status:** Draft  
**Last Updated:** 2026-03-03

This is the authoritative specification for localbot-ctl behavior.
All implementations and documentation must match this spec.

---

## Overview

localbot-ctl provides chat commands (`/lb*`) for managing local LLM inference
endpoints from within Matrix rooms. Commands are handled by the primary agent
in each room, not by LocalBot itself.

Reasoning-budget and prompt-style tuning are out of scope for this plugin;
those are managed in backend service config and agent prompt policy.

---

## Commands

### `/lbh` — Help

Show available commands and brief descriptions.

**Arguments:** None  
**Auth:** Required (authorized users only)  
**Output:** Command list with descriptions

---

### `/a [filter]` / `/aliases [filter]` — Model Alias List

Show model aliases available for native `/model <alias>` usage.

**Arguments:** Optional filter string  
**Auth:** Required  
**Output:** Aliases grouped by provider

---

### `/lbs` — Status

Show current inference status across runtime + room sessions:
- operator-first quick context line (`Quick ctx`) for the most recently active room
- active backend + GPU memory
- loaded model and runtime ctx cap
- all visible slot states (GPU and local CPU)
- per-room OpenClaw session context usage (`used/cap`) grouped by active/stale

**Arguments:** None  
**Auth:** Required  
**Output (example):**
```
🤖 LocalBot Status

⚡ Quick ctx (llmlab)
   20,703 / 98,304 (21.1%) [███░░░░░░░░░]
   runtime cap 98,304 · session cap 131,072 · source transcript · 6m ago

🟢 Backend: llama-cpp
🖥️ GPU: GPU0: 96% | GPU1: 92%
📦 Runtime model: Qwen_Qwen3.5-35B-A3B-Q4_K_M
📐 Runtime ctx cap: 98,304 tokens (~96k)
🧠 GPU slots (1)
   #0 · ctx 98,304 · idle · task 4537

🟢 Local (CPU): running
   Slots: 3
   #0 · ctx 120,064 · idle
   #1 · ctx 120,064 · idle
   #2 · ctx 120,064 · busy · task 1943

📚 Room ctx (details)
   used / cap = estimated prompt tokens / session context cap
   source = transcript | totalTokens | inputTokens | input+output
   model shown per room = session-tag (may differ from runtime model)
   Active (<24h):
   ✅ llmlab         20,703 / 131,072 (15.8%) · 6m ago · source transcript · session-tag Qwen_Qwen3.5-35B-A3B-Q4_K_M.gguf
   Stale (>=24h):
   💤 llmlab-control 31,073 / 131,072 (23.7%) · 2d ago · source totalTokens · session-tag GLM-4.7-Flash-UD-Q4_K_XL.gguf
   Legend: 💤 stale >=24h, counter-drift = non-transcript counter exceeded cap, ctx>cap = transcript-derived usage exceeded cap

📊 Rooms: 6/6 resolved | active (<24h): 1 | in-context 20,703 tokens
```

**Markers / semantics:**
- `📦 Runtime model` = model currently loaded in active backend runtime
- `session-tag ...` = model tag stored per room session entry (can differ from runtime model)
- `Quick ctx` = most recently active room with `used / effective-cap`
- `effective-cap = min(runtime ctx cap, session cap)`
- `source ...` = token-source for occupancy estimate (`transcript` preferred, fallback to `totalTokens`, then legacy counters)
- `💤` = room not updated in the last 24h (excluded from aggregate in-context total)
- `counter-drift` = non-transcript counter exceeded cap
- `ctx>cap` = transcript-derived estimate exceeded cap

---

### `/lbm` — List Models

Show available models from the model registry with specs.

**Arguments:** None  
**Auth:** Required  
**Output:**
```
📦 LocalBot Models

▸ nemo30b — Nemotron-3-Nano-30B IQ4_NL
  131k ctx | gen 62→58 | pp 393→360

▸ q3cn40b — Qwen3-Coder-Next REAP 40B ⬅ active
  131k ctx | gen 24→12 | pp 60→20

▸ go20b — GPT-OSS 20B
  131k ctx | gen 60→20 | pp 145→45
```

---

### `/lbm <alias> [flags]` — Switch Target Model

Resolve alias to provider/backend, optionally switch backend, and apply model target updates.

**Auth:** Required  
**Flags:**
- `-bl` / `-bv` / `-bo` = backend shortcut (`llama-cpp` / `vllm` / `ollama`)
- `-b l|v|o` = backend selector
- `-e <endpoint-id>` = explicit endpoint
- `--once` = non-persistent mode (default when mode flag omitted)
- `--default` / `--set-default` = persist target model to configured default-update agents
- `--scope active|all` = runtime session-tag touch scope (`active` default)
- `--show-default` = show persisted defaults for target agents

**Usage:**
```text
/lbm
/lbm <alias> [--once] [--default|--set-default] [--scope active|all] [-bl|-bv|-bo|-b l|v|o] [-e <endpoint>]
/lbm --show-default
```

**Behavior:**
1. Resolve alias from OpenClaw model aliases
2. Resolve backend:
   - explicit backend flag (`-bl|-bv|-bo|-b`)
   - else infer from `-e <endpoint>` when endpoint id is known
   - else unresolved until alias disambiguation
3. Resolve endpoint using deterministic order:
   - alias override (`modelSwitch.routing.aliasOverrides`)
   - backend default (`modelSwitch.routing.backendDefaults`)
   - if exactly one endpoint exists for backend, use it
   - otherwise fail with actionable ambiguity error
4. Switch backend when needed (`llama-cpp`/`vllm` via wechsler)
5. Apply runtime session model tags across configured target agents, using `--scope`:
   - `active` (default): latest Matrix session key per mapped room only
   - `all`: all session keys for each target agent
6. If mode is `--default`/`--set-default`, update target agents' `model.primary` in gateway config with backup + atomic write

**Mode semantics:**
- `--once`:
  - writes runtime session model tags for configured target agents per selected scope
  - does **not** persist `model.primary`
  - `/new` continues to follow current persisted defaults
- `--default`:
  - persists `model.primary` in `openclaw.json` for target agents
  - applies to **new sessions only**
  - existing session context is not rewritten

**Runtime caveat:**
- persisted default changes may require gateway/channel restart before `/new` consistently reflects the new value in Matrix monitor paths that cache config in-memory.

**Actionable error behavior (examples):**
- unknown alias: `❌ Unknown alias '<alias>'. Try /a <alias>`
- unknown endpoint id: `❌ Endpoint '<id>' is unknown. Use /lbe to list valid endpoint ids.`
- alias/backend mismatch: includes available backends and command hints (`/lbm <alias> -bl`, `/lbm <alias> -bv`, ...)
- multi-backend ambiguity: lists each backend/model/endpoint path and suggests exact follow-up commands
- endpoint ambiguity: requests `-e <endpoint>` and suggests `/lbe`
- mode conflict: `❌ Choose one mode: --once or --default.`
- invalid scope: `❌ Invalid scope. Use --scope active|all.`

---

### `/lbn <room>` — New Session (Reset)

Reset the LocalBot session for a room, clearing conversation history.

**Arguments:** Room name (required) — e.g., `llmlab`, `planning`, `fraktalia`  
**Auth:** Per-room authorization (see Security section below)

**Behavior:**
1. Validate room argument
2. Check authorization for that room
3. Clear session tokens, reset to fresh state

**Output:**
```
✅ LocalBot session reset (llmlab)
   Cleared 45k tokens
```

**Error cases:**
- No argument: `Usage: /lbn <room>\n\nRooms: \`fraktalia\`` (shows only accessible rooms)
- Unknown room: `Usage: /lbn <room>\n\nRooms: ...`
- Unauthorized: `❌ Only authorized users can reset this room`

**Note:** Room auto-detection is not possible because OpenClaw plugin commands
don't receive `conversationId`. This is an upstream limitation.

---

## Security

### Authorization Model

Commands use two authorization levels:

1. **Authorized users** — On the OpenClaw `allowFrom` list (owner/admins)
2. **Guests** — Anyone else with room access

### Command Authorization

| Command | Authorization |
|---------|---------------|
| `/lbh` | Authorized users only |
| `/a`, `/aliases` | Authorized users only |
| `/lbm` | Authorized users only |
| `/lbn` | Per-room (see below) |
| `/lbs` | Authorized users only |
| `/lbe` | Authorized users only |
| `/lbp` | Authorized users only |

### Per-Room Reset Authorization

The `/lbn` command uses per-room authorization via the `publicReset` flag:

| `publicReset` | Who Can Reset |
|---------------|---------------|
| `true` | Anyone (guests included) |
| `false` | Authorized users only |

**Implementation:**
```typescript
if (!roomConfig.publicReset && !ctx.isAuthorizedSender) {
  return { text: `❌ Only authorized users can reset this room` };
}
```

**Room visibility:**
- Authorized users see all rooms in `/lbn` help
- Guests only see rooms where `publicReset: true`

### Design Rationale

In shared/public rooms, guests should be able to reset their conversation
without affecting private workspaces. The `publicReset` flag enables
granular control per room

---

### `/lbe` — Endpoints

Show all configured inference endpoints with status.

**Arguments:** None  
**Auth:** Required  
**Output:**
```
🔌 Inference Endpoints

✅ llama-cpp-local (llama-cpp)
   http://<llama-cpp-host>:8080
   📦 Nemotron-3-Nano-30B-A3B
   ⚡ gen 62→58 | pp 393→360 tok/s

❌ vllm-gpu (vllm)
   http://<vllm-host>:8000
   ❌ Connection refused

✅ ollama-quick (ollama)
   http://<ollama-host>:11434
   📦 3 available (none loaded)

2/3 endpoints online
```

---

### `/lbp` — Performance

Run a quick benchmark on the active endpoint.

**Arguments:** None  
**Auth:** Required  
**Behavior:** Send a short test prompt and measure timing

**Output:**
```
⚡ Benchmark: llama-cpp-local

📦 Model: Nemotron-3-Nano-30B-A3B
📝 Generation: 61.7 tok/s
📥 Prompt: 392.4 tok/s
⏱️ Roundtrip: 847ms
```

---

## Configuration

### Endpoints Registry (`inference-endpoints.json`)

```json
{
  "endpoints": [
    {
      "id": "llama-cpp-local",
      "name": "llama-cpp-local",
      "type": "llama-cpp",
      "url": "http://<llama-cpp-host>:8080",
      "priority": 1,
      "notes": "Primary inference server"
    }
  ]
}
```

### Models Registry (`localbot-models.json`)

```json
{
  "models": {
    "llama-cpp/Nemotron-3-Nano-30B-A3B-IQ4_NL.gguf": {
      "alias": "nemo30b",
      "name": "Nemotron-3-Nano-30B IQ4_NL",
      "context": 131072,
      "vramFit": "full",
      "speeds": {
        "genFresh": 62,
        "genFilled": 58,
        "promptFresh": 393,
        "promptFilled": 360
      }
    }
  }
}
```

### Room Mappings

Rooms are configured via `config/localbot-rooms.json` in your workspace.
See `config/localbot-rooms.example.json` in this repo for the format.

```json
{
  "rooms": {
    "!room-id:server.example": {
      "agentId": "localbot-main",
      "roomName": "main",
      "publicReset": false
    }
  }
}
```

| Field | Description |
|-------|-------------|
| `agentId` | The LocalBot agent ID for this room |
| `roomName` | Short name used in commands (`/lbn main`) |
| `publicReset` | `true` = guests can reset, `false` = auth required |

---

## Speed Notation

Speeds are shown as `fresh→filled`:
- **Fresh:** Speed with empty/minimal context
- **Filled:** Speed when context is near capacity

Example: `gen 60→20` = 60 tok/s fresh, 20 tok/s when context is full.

---

## Error Handling

All commands should:
1. Return clear error messages with ❌ prefix
2. Suggest fixes when possible
3. Never expose internal stack traces

---

## Future Enhancements

- [ ] Move room mappings to config file
- [ ] `/lbl` — show logs from inference server
- [ ] `/lbq` — queue status (pending requests)
