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
