# pi-brain

Privacy-first dataset extraction from AI coding sessions.

A Pi package with a thin Pi extension on top of a source-agnostic TypeScript core. Extract sessions from Pi, Claude Code, Codex, OpenCode, and Cursor, sanitize them locally, optionally run structured review, export to training formats, and upload to Hugging Face or custom HTTP targets.

## Quick Start

```bash
npm install -g @0xsero/pi-brain

# Or install as a Pi package
pi install npm:@0xsero/pi-brain
```

### CLI Usage

```bash
# List available sessions across all sources
pi-brain list

# Export Pi sessions (sanitized, with privacy redaction)
pi-brain export pi

# Export Claude Code sessions
pi-brain export claude

# Export from all available sources
pi-brain export codex
pi-brain export opencode
pi-brain export cursor
```

### Pi Extension Commands

When installed as a Pi package, these commands are available inside Pi:

- `/export-local` — Export sanitized Pi sessions to disk
- `/export-public` — Export sanitized Pi sessions and publish to Hugging Face
- `/export` — TUI alias that asks local vs public, then current vs all

Both commands open a TUI picker when you omit the scope. You can also skip the picker with `--current` or `--all`.

`/export-public` reads defaults from `~/.pi/agent/pi-brain.json` when present:

```json
{
  "huggingface": {
    "repo": "0xSero/pi-brain-private-publish-test",
    "visibility": "private"
  },
  "export": {
    "formats": ["sessions"]
  }
}
```

You can still override these per command, for example:

```text
/export-local --format=sessions,chatml
/export-local --all
/export-public --repo 0xSero/my-dataset --public
/export-public --all
```

## Architecture

```
Source plugin (pi, claude, codex, ...) → CanonicalSession
    → Static privacy engine (local only)
    → [Optional] Structured review (OpenAI-compatible, sanitized chunks only)
    → Training formatters (sessions, sft-jsonl, chatml)
    → Upload targets (HF dataset or custom HTTP)
```

See [docs/design.md](docs/design.md) for the full architecture.

## Core File Budget (15 files)

| File | Purpose |
|------|---------|
| `core/index.ts` | Public API surface |
| `core/configs/types.ts` | Configuration types |
| `core/configs/defaults.ts` | Default values |
| `core/privacy/types.ts` | Privacy/redaction types |
| `core/privacy/detectors.ts` | Pattern-based secret detection |
| `core/privacy/redactor.ts` | Placeholder replacement engine |
| `core/privacy/reviewer.ts` | Optional AI-powered review |
| `core/data-processing/types.ts` | Canonical data types |
| `core/data-processing/canonicalize.ts` | Session validation/normalization |
| `core/data-processing/chunker.ts` | Deterministic text chunking |
| `core/data-processing/formatters.ts` | Training format converters |
| `core/data-processing/bundle.ts` | Export bundle assembly |
| `core/uploads/types.ts` | Upload target types |
| `core/uploads/http-client.ts` | HTTP upload utilities |
| `core/uploads/uploader.ts` | Upload routing |

## Source Plugins

| Plugin | Status | Storage Location |
|--------|--------|-----------------|
| Pi | Complete | `~/.pi/agent/sessions/` |
| Claude Code | Complete | `~/.claude/projects/` |
| Codex | Complete | `~/.codex/sessions/` |
| OpenCode | Complete | `~/.local/share/opencode/` or `~/Library/Application Support/opencode/` (`opencode.db` and legacy `storage/` layouts) |
| Cursor | Complete | Reads pre-extracted JSONL from `~/extracted_data/` |
| Factory | Stub | Not yet supported (awaiting format documentation) |

## Privacy Guarantees

- **Local-first**: Raw session text never leaves your machine in v1.
- **Deterministic redaction**: API keys, passwords, emails, phones, JWTs, auth headers, IPs, filesystem paths, labeled personal fields, and provider tokens are all replaced with stable placeholders.
- **Placeholder stability**: The same secret always gets the same placeholder within a session (e.g. `<EMAIL_1>`).
- **Optional structured review**: Off by default. When enabled, only already-sanitized text is sent to an OpenAI-compatible endpoint for residual entity detection.

## Development

```bash
npm install
npm run typecheck    # Type checking
npm run check        # Lint with Biome
npm test             # Run tests with Vitest
npm run build        # Build to dist/
```

## License

MIT
