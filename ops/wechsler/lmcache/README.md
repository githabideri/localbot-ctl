# LMCache Setup (vLLM)

Persistent KV cache for vLLM using [LMCache](https://github.com/LMCache/LMCache).

## Status
**WORKING** (verified 2026-02-10)

## How It Works

LMCache intercepts vLLM's KV cache and persists it to CPU RAM and/or disk.
Repeated prompt prefixes skip GPU recomputation entirely.

**Cache tiers:** GPU → CPU RAM → Disk (LRU eviction)

## Config

`/etc/lmcache.yaml` on the vLLM host:

```yaml
chunk_size: 256
local_cpu: true
max_local_cpu_size: 4      # GB
reserve_local_cpu_size: 0
local_disk: /var/lib/lmcache
max_local_disk_size: 50    # GB
use_layerwise: false
save_decode_cache: false
```

## vLLM Integration

Add to vLLM service environment:
```
Environment=LMCACHE_CONFIG_FILE=/etc/lmcache.yaml
```

Add to vLLM command line:
```
--kv-transfer-config '{"kv_connector":"LMCacheConnectorV1","kv_role":"kv_both"}'
```

## Test Results

Same prompt sent twice:
- **Cold:** 3.24s
- **Warm (cached):** 0.08s (~40x speedup)

## Health Check

```bash
curl -s http://localhost:8000/v1/models
# Returns 200 when ready
```

Note: `/health` endpoint may not respond in all vLLM builds; use `/v1/models` instead.

## Troubleshooting

- **GPU memory stuck (no processes but VRAM used):** Kill all vllm processes and restart, or reboot the GPU host
- **max_model_len too high:** Lower it if KV cache allocation fails — error will say how much is available
