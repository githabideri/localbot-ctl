# Changelog

All notable changes to localbot-ctl will be documented in this file.

## [Unreleased]

### Added
- SPEC.md — Authoritative command specification
- README.md — User documentation
- CHANGELOG.md — Version history
- Git repository initialized

### Changed
- Renamed from `localbot-commands` to `localbot-ctl`
- Version reset to 0.1.0 (pre-1.0 development)
- `/lbs` now reports runtime slot detail (GPU + local CPU) and room-level OpenClaw context usage (`used/cap`) per mapped room
- `/lbs` marks stale room session state (>24h), excludes stale rooms from aggregate in-context totals, and now distinguishes over-cap states as `counter-drift` (counter-based) vs `ctx>cap` (transcript-based)
- `/lbs` now starts with a `Quick ctx` operator summary (`used / effective-cap` + mini bar), then follows with grouped room details (`Active` vs `Stale`)
- `/lbs` model labels clarified to avoid false regressions: top line now shows `📦 Runtime model`, per-room rows explicitly show `session-tag ...`, and room section explains the difference
- Documented Matrix command interception guardrail: set `commands.native=true` and `commands.nativeSkills=true` so `/lb*` commands are always handled natively in rooms like `llmlab`
- `/lbm` now has explicit mode semantics: `--once` (default, non-persistent) vs `--default`/`--set-default` (persistent)
- `/lbm` backend/endpoint resolution responses are now actionable (backend hints, endpoint hints, and ambiguity breakdowns)
- `/lbm` now explains `/new` implications directly in command output: `--default` applies to new sessions and may still require runtime reload/restart in cached Matrix paths
- `/lbm` session touching is now scoped by default: `--scope active` only updates latest mapped Matrix room entries; `--scope all` is explicit for bulk cron/main/subagent rewrites
- `/lbh` help and README/SPEC now document model-switch modes, routing order, and persistence caveats
- `/lbs` context occupancy now prefers transcript prompt tokens, then `totalTokens`, and labels each room/quick summary with `source ...` for auditability
- wechsler now maintains a backend source-of-truth state file (`/tmp/wechsler-active-backend`) and lock file (`/tmp/wechsler-switch.lock`) to prevent concurrent switch/stop races
- `/lbs` now surfaces `🧭 Source-of-truth` backend and warns when it differs from live endpoint probe
- `/lbs` now defaults to a compact view (quick ctx first, condensed room summary) with ` /lbs full ` for complete slot/room dumps
- `/lbw status`/`/lbw current` now report live wechsler state, source-of-truth backend, and GPU summary without switching
- `/lbs` now treats zeroed provider usage counters as missing and falls back to an `estimate` source (recent transcript-char heuristic)
- `/lbs` can now add optional static baseline tokens via room config (`basePromptTokens`) when using `estimate`, so quick ctx bars stay meaningful on vLLM/Qwen paths with missing usage counters
- wechsler service names are now configurable via env (`LLAMA_SERVICE`, `VLLM_SERVICE`) instead of hardcoded unit names

### Planned
- Fix `/lbn` room auto-detection
- Move room mappings to config file

---

## [1.0.0] - 2026-02-08 (legacy, pre-git)

### Added
- Initial implementation
- Commands: /lbh, /lbs, /lbe, /lbp, /lbn
- Endpoint probing for llama-cpp, vLLM, Ollama
- Model metadata from localbot-models.json

### Removed
- /lbm command (was working, accidentally removed)

### Known Issues
- /lbn requires room argument (auto-detect broken)
- Room mappings hardcoded in TypeScript
- Documentation out of sync with code
