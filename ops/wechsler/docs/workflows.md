# Wechsler-LLM Workflows

## Overview

Wechsler manages inference backends across two servers:

### GPU Server (shared, switchable)
- **llama-cpp** — GGUF models, slot persistence, fast startup (~8s)
- **vLLM** — HF/AWQ models, LMCache persistence, slow startup (~80s)
- Only one GPU backend at a time. May be powered off.

### Local CPU Server (always-on)
- **llama-local** — CPU inference on Mini PC (i5-8400T, 32GB RAM)
- Nemotron-3-Nano-30B-A3B @ ~10 tok/s, 200K context class
- Slot persistence on 2TB NVMe
- Independent of GPU server — always available as fallback

### Reasoning profile (current)
- `llama-cpp` and `llama-local` run with:
  - `--reasoning-format deepseek`
  - `--reasoning-budget -1`
  - prompt-side brief constrained reasoning policy
- Fast mode (`--reasoning-budget 0`) is available, but used only for latency-critical runs.

## State Model

```
GPU Server: off | on
Backend:    none | llama-cpp | vllm
Slots:      empty | cached (llama-cpp only, saved on shared storage)
```

Wechsler tracks this via health probes — no state file needed.

### Status Detection

```bash
wechsler.sh status
```

1. **Ping GPU server** — is the host reachable at all?
2. **Check llama-cpp health** — `GET /health` → 200?
3. **Check vLLM health** — `GET /v1/models` → 200?
4. **List saved slots** — what's on disk?

Possible states:

| GPU Server | llama-cpp | vLLM | State |
|------------|-----------|------|-------|
| off | — | — | `gpu-offline` |
| on | stopped | stopped | `gpu-idle` |
| on | running | stopped | `llama-cpp` |
| on | stopped | running | `vllm` |
| on | loading | stopped | `llama-cpp-starting` |
| on | stopped | loading | `vllm-starting` |

## Typical Workflows

### 1. Cold Start (GPU server was off)

**Trigger:** User sends `/lbs` or a LocalBot message, GPU server is offline.

```
1. Wake GPU server (WoL packet)
2. Wait for SSH to become reachable (30-60s typical)
3. Start desired backend (default: llama-cpp for LocalBot)
4. Wait for health check
5. Restore saved slot if available
6. Ready
```

Total time: ~90s (WoL) + ~8s (llama-cpp) = ~100s

### 2. Switch Backend (llama-cpp → vLLM)

**Trigger:** User needs a vLLM model (e.g., vision model via Qwen3-VL).

```
1. Save active llama-cpp slot to disk
2. Stop llama-cpp
3. Start vLLM
4. Wait for health (~80s)
5. Ready
```

### 3. Switch Backend (vLLM → llama-cpp)

**Trigger:** User switches back to GGUF model.

```
1. Stop vLLM (LMCache persists automatically)
2. Start llama-cpp
3. Wait for health (~8s)
4. Restore saved slot from disk (19ms)
5. Ready — conversation context is restored
```

### 4. Shutdown (idle timeout or manual)

**Trigger:** No requests for N minutes, or user command.

```
1. If llama-cpp active: save slot to disk
2. Stop active backend
3. (Optional) Shut down GPU server to save power
```

### 5. Quick Restart (same backend)

**Trigger:** Backend crashed or needs config change.

```
1. If llama-cpp: save slot (if still responsive)
2. Restart service
3. Wait for health
4. If llama-cpp: restore slot
```

### 6. GPU Server Unexpected Reboot

**What happens:**
- systemd services are `enabled` → backend auto-starts on boot
- llama-cpp: slot must be restored from disk (last save)
- vLLM: LMCache restores from disk automatically

**What wechsler does:**
- Next status check detects backend is running
- For llama-cpp: offers to restore last saved slot

## Status for /lb* Commands

Wechsler exposes status in a machine-readable format for LocalBot integration:

```bash
wechsler.sh status --json
```

```json
{
  "gpu_server": "on",
  "active_backend": "llama-cpp",
  "health": "ok",
  "uptime_seconds": 3600,
  "slots": [
    {
      "id": 0,
      "n_ctx": 196608,
      "is_processing": false
    }
  ],
  "saved_slots": ["localbot"],
  "gpu_memory": {
    "gpu0": {"used_mib": 11573, "total_mib": 12288},
    "gpu1": {"used_mib": 11099, "total_mib": 12288}
  }
}
```

This lets `/lbs` show:
```
Backend: llama-cpp ✓
Model: Nemotron-3-Nano-30B (192k ctx)
GPU: 94% + 90% VRAM used
Slot: cached (localbot, 48MB)
Uptime: 1h
```

And `/lbe` show:
```
llama-cpp: http://llama-cpp:8080/v1 ✓ (active)
vllm:      http://vllm:8000/v1 ● (stopped, ~80s to start)
```

## Error Handling

| Scenario | Behavior |
|----------|----------|
| Save fails before switch | Log warning, proceed (fresh start > no start) |
| Restore fails after start | Log warning, start with empty context |
| Health timeout (120s) | Abort, report error |
| GPU server unreachable | Report `gpu-offline`, suggest WoL |
| Both backends report healthy | Shouldn't happen — report conflict |
| Backend crashes mid-request | systemd auto-restarts, slot lost until next restore |

## Local CPU Workflows

### 7. Always-On Fallback

**Scenario:** GPU server is off, user sends a message to LocalBot.

```
1. Agent routes to llama-local (priority 5, always healthy)
2. Restore pre-warmed slot if available (10ms)
3. Generate at ~10 tok/s
4. Save slot on completion
```

No boot delay. No GPU needed.

### 8. Pre-Warmed Specialized Agents

**Scenario:** Specialized agents (research, routing) with large system prompts.

```
1. First run: process 5-10K system prompt tokens (~200-500s on CPU)
2. Save slot: wechsler.sh local-save research-agent
3. Subsequent runs: restore in 10ms, skip prompt eval entirely
4. Generate at ~10 tok/s immediately
```

Slot files are ~50MB each. 2TB NVMe = room for thousands of cached agents.

### 9. Smart Escalation (future)

**Scenario:** Local model decides task needs more compute.

```
1. Local model receives complex request
2. Determines it needs GPU-class inference
3. Triggers GPU server wake (WoL)
4. Hands off to GPU backend when ready
```

## Local Server Commands

```bash
wechsler.sh local-status           # Check local server
wechsler.sh local-save [name]      # Save CPU slot (default: localbot-cpu)
wechsler.sh local-restore [name]   # Restore CPU slot
```

## Design Principles

1. **One GPU backend at a time** — full GPU resources, no memory contention
2. **Local CPU always available** — independent of GPU server state
3. **Health-based detection** — no state files to get stale
4. **Graceful degradation** — save/restore failures don't block switching
5. **Dual persistence** — GPU slots on `/mnt/models/cache/`, CPU slots on `/models/cache/slots/`
6. **SSH-based remote control** — script runs on management host, reaches backends via SSH hostnames
7. **Machine-agnostic config** — hosts/ports via env vars, no hardcoded IPs
