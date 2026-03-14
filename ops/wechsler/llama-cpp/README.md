# llama-cpp Slot Persistence

Persistent KV cache slots for llama.cpp server.

## Status
**WORKING** (verified 2026-02-10)

## How It Works

llama-cpp server supports multiple parallel "slots" — independent context windows.
Each slot's KV cache can be saved to disk and restored later, surviving restarts and backend switches.

In-memory, llama-cpp also auto-matches incoming prompts to existing slots via `--slot-prompt-similarity` (default 0.10 = 90% prefix match reuses cached KV).

## Service Config

Key flags for the llama-server systemd unit:

```
--slot-save-path /mnt/models/cache/llama-cpp/slots   # enables save/restore API
--parallel 1                                           # number of slots (1 = full context per slot)
--ctx-size 196608                                      # 192k context profile
--reasoning-format deepseek                            # extract <think> into reasoning_content
--reasoning-budget -1                                  # keep reasoning on (recommended balance mode)
```

**Reasoning format:** Models that use `<think>...</think>` tags (Nemotron, Qwen3, DeepSeek) need `--reasoning-format deepseek` to separate thinking from visible output. The server extracts thinking into `reasoning_content` and keeps clean output in `content`. Using `none` leaves thinking mixed into the response or strips it, breaking CoT.

**Budget policy:** `--reasoning-budget -1` is the default "balanced" profile. `--reasoning-budget 0` is faster but currently more prone to malformed output artifacts in chat workflows.

With `--parallel 1`, the single slot gets the full context window.
With `--parallel N`, context is split evenly (196k/N per slot).

## Slot Save/Restore API

**List slots:**
```bash
curl http://localhost:8080/slots
```

**Save slot to disk:**
```bash
curl -X POST "http://localhost:8080/slots/0?action=save" \
  -H "Content-Type: application/json" \
  -d '{"filename": "localbot-main"}'
```

**Restore slot from disk:**
```bash
curl -X POST "http://localhost:8080/slots/0?action=restore" \
  -H "Content-Type: application/json" \
  -d '{"filename": "localbot-main"}'
```

## Test Results

- **Prompt processing:** ~153 tok/s
- **Generation:** ~98 tok/s
- **Save (33 tokens):** 34ms, 48MB file
- **Restore:** <1ms

File size scales with token count and model's KV dimensions.

## Health Check

```bash
curl -s http://localhost:8080/health
# Returns {"status":"ok"}
```

## Architecture Notes

- Only one GPU-heavy backend should run at a time (llama-cpp OR vLLM)
- Before switching backends: save active slots → stop → start other backend
- After switching back: restore saved slots
- Slot files persist on shared storage alongside model files
