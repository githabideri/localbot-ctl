# localbot-ctl

An [OpenClaw](https://github.com/openclaw/openclaw) plugin for managing local LLM inference servers from chat. Control GPU power, switch backends, monitor performance, and manage models — all through `/lb*` commands in Matrix, Discord, or any supported channel.

Built for the setup documented in [llmlab](https://github.com/githabideri/llmlab) (consumer GPUs serving agentic workloads), but designed to work with any local inference setup: bare metal, Docker, LXC containers, or mixed environments.

## What it does

- **Power management** — Wake, shutdown, and monitor GPU servers. Supports Wake-on-LAN, Home Assistant webhooks (for smart socket control), or both. Tracks power consumption and session energy via optional HA integration.
- **Backend switching** — Seamlessly switch between llama.cpp and vLLM (or stop both). Automatic KV cache save/restore during transitions. Only one GPU backend runs at a time.
- **Model management** — List available models, switch at runtime, persist defaults across sessions. Supports per-backend endpoint routing and alias shortcuts.
- **Status & monitoring** — Live GPU memory, slot utilisation, per-room context usage estimates, idle auto-shutdown with configurable timeout.
- **Session control** — Reset LocalBot context per room, with granular public/private authorization.

## Commands

| Command | Description |
|---------|-------------|
| `/lbh` | Help — show commands and backend info |
| `/lbs [full]` | Status — GPU memory, slots, context usage |
| `/lbm [alias]` | Models — list, switch, or persist defaults |
| `/lbe` | Endpoints — show all inference backends |
| `/lbw <backend>` | Switch backend (llama-cpp\|vllm\|stop) |
| `/lbn <room>` | Reset — clear LocalBot session context |
| `/lbp` | Performance — benchmark active endpoint |
| `/lbstart` | Wake GPU server (webhook/WoL + boot + warmup) |
| `/lboff` | Shutdown GPU server |
| `/lbstay [on\|off]` | Toggle stay-online (prevent auto-shutdown) |
| `/lbidle [set <min>]` | Show idle status / set auto-shutdown timeout |
| `/lbpower [reset]` | Power consumption stats / reset session baseline |
| `/a [filter]` | Quick alias list for model switching |

## Installation

### Prerequisites

- [OpenClaw](https://github.com/openclaw/openclaw) running with plugin support
- At least one local inference server (llama.cpp, vLLM, or Ollama)
- Node.js 18+ (comes with OpenClaw)

### Setup

1. **Clone the plugin:**
   ```bash
   cd /path/to/your/workspace/plugins
   git clone https://github.com/githabideri/localbot-ctl.git
   ```

2. **Register in OpenClaw config** (`openclaw.json`):
   ```json
   {
     "plugins": {
       "load": {
         "paths": ["workspace/plugins/localbot-ctl"]
       },
       "entries": {
         "localbot-ctl": { "enabled": true }
       }
     }
   }
   ```

3. **Create configuration files** in your workspace `config/` directory (see [Configuration](#configuration)).

4. **Restart OpenClaw:**
   ```bash
   openclaw gateway restart
   ```

## Configuration

The plugin reads from your workspace `config/` directory. No config files are included in the repo — you create them for your setup.

### Required

| File | Purpose |
|------|---------|
| `config/inference-endpoints.json` | Endpoint definitions, backend switching, power management |
| `config/localbot-rooms.json` | Room-to-agent mappings and permissions |

### Optional

| File | Purpose |
|------|---------|
| `config/localbot-models.json` | Model metadata (speeds, context limits, aliases) |
| `config/secrets/ha_token` | Home Assistant long-lived access token (for power monitoring) |

### Example: `inference-endpoints.json`

```json
{
  "endpoints": [
    {
      "id": "gpu-llama",
      "name": "GPU Server (llama.cpp)",
      "type": "llama-cpp",
      "url": "http://your-gpu-server:8080",
      "priority": 1
    },
    {
      "id": "gpu-vllm",
      "name": "GPU Server (vLLM)",
      "type": "vllm",
      "url": "http://your-gpu-server:8000",
      "priority": 2
    },
    {
      "id": "cpu-fallback",
      "name": "CPU Fallback",
      "type": "llama-cpp",
      "url": "http://your-cpu-server:8080",
      "priority": 5
    }
  ],
  "wechsler": {
    "scriptPath": "workspace/plugins/localbot-ctl/ops/wechsler/wechsler.sh",
    "managedEndpoints": ["gpu-llama", "gpu-vllm"]
  },
  "power": {
    "enabled": true,
    "wakeMethod": "wol",
    "macAddress": "aa:bb:cc:dd:ee:ff",
    "sshHost": "your-gpu-host",
    "healthUrl": "http://your-gpu-server:8080",
    "idleTimeoutMinutes": 30,
    "checkIntervalMinutes": 5,
    "warmupModel": "your-model-name"
  }
}
```

### Power Management Options

The `power` block supports three wake methods:

| `wakeMethod` | How it works | Best for |
|--------------|-------------|----------|
| `"wol"` | Sends Wake-on-LAN magic packet | Servers with reliable WoL support |
| `"webhook"` | POSTs to an HTTP webhook | Home Assistant, smart sockets, custom APIs |
| `"both"` | Sends WoL + calls webhook | Belt and suspenders |

#### Home Assistant Integration (optional)

For power monitoring via a smart socket, add these fields to the `power` block:

```json
{
  "power": {
    "wakeMethod": "webhook",
    "webhookUrl": "http://your-ha:8123/api/webhook/YOUR_SECRET_ID",
    "haUrl": "http://your-ha:8123",
    "haTokenFile": "/path/to/secrets/ha_token",
    "haPowerEntity": "sensor.your_socket_power",
    "haEnergyEntity": "sensor.your_socket_energy",
    "haBaselineEntity": "input_number.your_baseline_helper",
    "haSocketEntity": "switch.your_socket"
  }
}
```

This enables `/lbpower` to show real-time power consumption and per-session energy tracking.

## Architecture

localbot-ctl is designed to manage inference servers regardless of how they're deployed:

```
┌──────────────────────────────┐
│  OpenClaw + localbot-ctl     │  Any machine running OpenClaw
│  (chat commands)             │
└──────────┬───────────────────┘
           │ SSH / HTTP
           ▼
┌──────────────────────────────┐
│  Inference Server(s)         │  Bare metal, Docker, LXC, VM, ...
│  llama.cpp / vLLM / Ollama   │
│  + GPU(s)                    │
└──────────────────────────────┘
```

**Deployment examples:**
- **LXC containers on Proxmox** (our setup) — separate containers for llama.cpp and vLLM sharing passthrough GPUs
- **Docker on same host** — containers with `--gpus` flag, OpenClaw on the host or in another container
- **Bare metal** — inference server and OpenClaw on the same machine
- **Remote server** — GPU box on the network, OpenClaw elsewhere (SSH access needed for `/lboff` and backend switching)

The plugin communicates with inference servers via their **HTTP APIs** (OpenAI-compatible) for health checks, model info, and inference. **SSH** is used only for server management (shutdown, backend switching). Both are configured per-endpoint.

## Backend Switching

The vendored [wechsler](./ops/wechsler/) toolkit handles clean transitions between llama.cpp and vLLM:

- Only one GPU backend runs at a time
- KV cache state is saved before switching and restored after
- A lock file prevents concurrent switches
- `/lbs` detects mismatches between expected and actual backends

Configure by adding a `wechsler` block to your endpoints config (see example above).

## Model Switching (`/lbm`)

- `/lbm` — List available models with aliases
- `/lbm <alias>` — Switch model for current session (non-persistent)
- `/lbm <alias> --default` — Persist as default for new sessions
- `/lbm --show-default` — Show current persisted defaults

Backend shortcuts: `-bl` (llama-cpp), `-bv` (vllm), `-bo` (ollama).

## Security Model

- **Authorized users** (OpenClaw `allowFrom` list) can run all commands
- **Guests** see a restricted command set
- `/lbn` (session reset) uses per-room `publicReset` flags for granular control
- Power commands (`/lboff`, `/lbstay`) require authorization

## Status Display (`/lbs`)

`/lbs` provides a compact operator view:

- **Quick ctx** — current room's context usage at a glance
- **GPU memory** — per-GPU VRAM usage
- **Slot states** — active slots with model, context, and cache info
- **Room context** — per-room estimated token usage vs. capacity
- **Source labels** — shows where usage estimates come from (`transcript`, `totalTokens`, `estimate`)

Use `/lbs full` for detailed slot and room breakdowns.

## Related Projects

- **[llmlab](https://github.com/githabideri/llmlab)** — Model evaluations, benchmarks, and operational knowledge for running local LLMs on consumer GPUs. The testing ground where localbot-ctl was born.
- **[OpenClaw](https://github.com/openclaw/openclaw)** — The AI agent framework this plugin runs on.

## Known Limitations

- `/lbn` requires the room name as argument (OpenClaw plugin commands don't receive conversation context)
- Model switching updates session tags; it doesn't rewrite active prompt history
- Persisted defaults (`--default`) may need a gateway restart before `/new` picks them up
- In Matrix group rooms, set `commands.native: true` in OpenClaw config for reliable command interception

## License

MIT

## Links

- [Specification](./SPEC.md) — Authoritative command behavior
- [Changelog](./CHANGELOG.md) — Version history
- [ops/wechsler/](./ops/wechsler/) — Backend switching toolkit
