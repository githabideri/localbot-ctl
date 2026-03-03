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
- `/lbs` marks stale room session state (>24h), clamps over-cap counters (`store>cap`) for readable ratios, and excludes stale rooms from aggregate in-context totals
- `/lbs` now starts with a `Quick ctx` operator summary (`used / effective-cap` + mini bar), then follows with grouped room details (`Active` vs `Stale`)
- `/lbs` model labels clarified to avoid false regressions: top line now shows `📦 Runtime model`, per-room rows explicitly show `session-tag ...`, and room section explains the difference

### Planned
- Restore `/lbm` model switching
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
