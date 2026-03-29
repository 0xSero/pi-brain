# Testing Strategy

## Test-First Rule

No plugin implementation before core business-logic tests exist.

## Fixture Strategy

- **Checked-in fixtures**: `tests/fixtures/` — deterministic test data committed to the repo.
- **Generated proof**: `test-output/` — gitignored, created during test runs for manual inspection.
- **Runtime exports**: `.pi-private-data/` — gitignored, created by actual export operations.

## Test Categories

### Business Logic Tests (39 tests)

#### Redactor Tests (`tests/core/redactor.test.ts`)
- Untouched text remains byte-for-byte identical outside replaced spans
- Repeated secrets reuse the same placeholder ID across messages
- Supported secret classes never survive the deterministic pass
- All 11 detector categories work independently
- Custom patterns extend (don't replace) built-in detectors
- Non-overlapping spans sorted by start offset
- Category filtering respected

#### Chunker Tests (`tests/core/chunker.test.ts`)
- Single chunk for short text
- Chunking is deterministic (same input = same output)
- Concatenating chunks reproduces original text exactly
- Chunks are offset-safe (text matches slice of original)
- Placeholders are never split across chunk boundaries
- Token counts are positive for non-empty chunks
- Empty text handled gracefully

#### Formatter Tests (`tests/core/formatters.test.ts`)
- Sessions format: valid JSONL, one session per line
- SFT-JSONL format: user/assistant messages only, flat structure
- ChatML format: proper `<|im_start|>` / `<|im_end|>` tags

#### Bundle Tests (`tests/core/bundle.test.ts`)
- Manifest hash is SHA-256 hex
- All requested formats included as artifacts
- Hash is deterministic (same input = same hash)
- Metadata includes session/message counts and source

#### Canonicalize Tests (`tests/core/canonicalize.test.ts`)
- Valid session accepted
- Null/missing fields rejected with clear errors
- Invalid roles rejected
- Messages sorted by timestamp
- Optional fields preserved when present

### Integration Tests

#### Pi Fixture End-to-End (`tests/integration/pi.test.ts`)
- Load real Pi JSONL fixture -> sanitize -> verify no raw secrets survive
- Repeated emails across messages reuse same placeholder
- Full export bundle with all 3 formats validates as parseable JSONL

## Acceptance Criteria

1. `npm run typecheck` — zero errors
2. `npm run check` — zero lint errors
3. `npm test` — all tests pass
4. No raw secrets survive the deterministic redaction pass for any supported category
5. Chunking is deterministic and reconstructable
6. All three export formats produce valid JSONL

## Running Tests

```bash
npm test                              # Run all tests
npx vitest run tests/core/            # Core tests only
npx vitest run tests/integration/     # Integration tests only
npx vitest --watch                    # Watch mode
```
