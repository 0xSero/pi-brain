/**
 * @file core/privacy/detectors.ts
 *
 * Responsibility: Deterministic pattern-based detection of secrets and PII.
 * Each detector is a pure function: text in, DetectedSpan[] out.
 * No network calls, no LLM, no side effects.
 *
 * Invariants:
 * - Detectors never modify the input text.
 * - Returned spans are non-overlapping and sorted by start offset.
 * - Every match maps to exactly one RedactionCategory.
 * - Adding a custom pattern never removes built-in detectors.
 */

import type { RedactionCategory } from "../configs/types.js";
import type { DetectedSpan } from "./types.js";

/** A single detector definition: a category and a pattern to match. */
interface DetectorDef {
	readonly category: RedactionCategory;
	readonly pattern: RegExp;
}

/**
 * Built-in detector patterns.
 * Order matters: more specific patterns should come first to avoid
 * partial matches by broader patterns.
 */
const BUILT_IN_DETECTORS: ReadonlyArray<DetectorDef> = [
	// JWTs — three base64url segments separated by dots
	{
		category: "jwt",
		pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
	},
	// Authorization headers (Bearer, Basic, Token)
	{
		category: "auth-header",
		pattern:
			/(?:Authorization|authorization)\s*[:=]\s*(?:Bearer|Basic|Token)\s+[A-Za-z0-9_\-.+/=]{8,}/g,
	},
	// URLs with embedded credentials
	{
		category: "url-with-creds",
		pattern: /https?:\/\/[^:@\s]+:[^@\s]+@[^\s"']+/g,
	},
	// Common provider API keys (OpenAI, Anthropic, AWS, GitHub, etc.)
	{
		category: "provider-token",
		pattern:
			/\b(?:sk-(?:ant-)?[a-zA-Z0-9]{10,}|ghp_[a-zA-Z0-9]{36}|gho_[a-zA-Z0-9]{36}|github_pat_[a-zA-Z0-9_]{60,}|AKIA[A-Z0-9]{16}|xox[bpsar]-[a-zA-Z0-9\-]{10,}|hf_[a-zA-Z0-9]{20,})\b/g,
	},
	// Generic API keys/tokens (KEY=..., TOKEN=..., SECRET=...)
	{
		category: "api-key",
		pattern:
			/(?:API_?KEY|SECRET_?KEY|ACCESS_?KEY|PRIVATE_?KEY|TOKEN|SECRET|CREDENTIALS?)\s*[=:]\s*["']?([A-Za-z0-9_\-./+]{16,})["']?/gi,
	},
	// Password fields
	{
		category: "password",
		pattern: /(?:password|passwd|pwd)\s*[=:]\s*["']?([^\s"']{4,})["']?/gi,
	},
	// Email addresses
	{
		category: "email",
		pattern: /\b[a-zA-Z0-9._%+\-]{1,64}@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}\b/g,
	},
	// Phone numbers (international and US formats)
	{
		category: "phone",
		pattern:
			/(?<![A-Za-z0-9])(?:\+1[-.\s]+)?(?:\(\d{3}\)[-.\s]*\d{3}[-.\s]+\d{4}|\d{3}[-.\s]+\d{3}[-.\s]+\d{4})(?![A-Za-z0-9])/g,
	},
	// IPv4 addresses (excluding common non-sensitive ones like 127.0.0.1, 0.0.0.0)
	{
		category: "ip-address",
		pattern:
			/\b(?!127\.0\.0\.1\b)(?!0\.0\.0\.0\b)(?!255\.255\.255\.\d+\b)(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\b/g,
	},
	// Filesystem paths (home directories and absolute paths with usernames)
	{
		category: "filesystem-path",
		pattern: /(?:\/(?:home|Users)\/[a-zA-Z0-9._-]+)(?:\/[^\s"']*)?/g,
	},
	// Labeled personal fields (name: "...", address: "...", etc.)
	{
		category: "labeled-personal",
		pattern:
			/(?:(?:first|last|full)_?name|address|street|city|zip_?code|ssn|social_?security)\s*[=:]\s*["']([^"']{2,})["']/gi,
	},
];

/**
 * Run all detectors for the given categories against a text.
 * Returns non-overlapping spans sorted by start offset.
 */
export function detectAll(
	text: string,
	categories: ReadonlyArray<RedactionCategory>,
	customPatterns?: Readonly<Record<string, string>>,
): DetectedSpan[] {
	const categorySet = new Set(categories);
	const spans: DetectedSpan[] = [];

	// Run built-in detectors
	for (const detector of BUILT_IN_DETECTORS) {
		if (!categorySet.has(detector.category)) continue;
		runDetector(text, detector.category, detector.pattern, spans);
	}

	// Run custom patterns (all map to "api-key" category unless they match a known label)
	if (customPatterns) {
		for (const [_label, patternStr] of Object.entries(customPatterns)) {
			try {
				const pattern = new RegExp(patternStr, "g");
				runDetector(text, "api-key", pattern, spans);
			} catch {
				// Skip invalid regex patterns silently
			}
		}
	}

	return deduplicateAndSort(spans);
}

/** Execute a single regex detector and collect all matches. */
function runDetector(
	text: string,
	category: RedactionCategory,
	pattern: RegExp,
	out: DetectedSpan[],
): void {
	// Reset lastIndex for global regex
	pattern.lastIndex = 0;
	for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
		// Use group 1 if present (for patterns that capture the secret part),
		// otherwise use the full match.
		const captured = match[1] ?? match[0];
		const start = match[1] ? match.index + match[0].indexOf(captured) : match.index;
		out.push({
			start,
			end: start + captured.length,
			category,
			rawValue: captured,
		});
	}
}

/**
 * Remove overlapping spans (keep the earlier/longer one) and sort by start.
 */
function deduplicateAndSort(spans: DetectedSpan[]): DetectedSpan[] {
	if (spans.length === 0) return spans;

	// Sort by start ascending, then by length descending (longer first)
	spans.sort((a, b) => a.start - b.start || b.end - a.end);

	const result: DetectedSpan[] = [spans[0]];
	for (let i = 1; i < spans.length; i++) {
		const prev = result[result.length - 1];
		const curr = spans[i];
		// Skip if current span overlaps with or is contained within previous
		if (curr.start < prev.end) continue;
		result.push(curr);
	}

	return result;
}
