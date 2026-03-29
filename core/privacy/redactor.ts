/**
 * @file core/privacy/redactor.ts
 *
 * Responsibility: Apply detected spans as stable placeholder replacements.
 * The redactor is the only component that transforms text; detectors only find.
 *
 * Invariants:
 * - Text outside replaced spans is byte-for-byte identical to the original.
 * - Repeated secrets within the same session reuse the same placeholder ID
 *   (e.g. the same email appearing 5 times always becomes <EMAIL_1>).
 * - Placeholder format is <CATEGORY_N> where N is a 1-based counter per category.
 * - The RedactionReport is a complete audit trail of every replacement.
 */

import { ALL_REDACTION_CATEGORIES } from "../configs/defaults.js";
import type { RedactionCategory } from "../configs/types.js";
import type { PrivacyConfig } from "../configs/types.js";
import type { CanonicalSession } from "../data-processing/types.js";
import { detectAll } from "./detectors.js";
import type {
	DetectedSpan,
	RedactionEntry,
	RedactionReport,
	SanitizedMessage,
	SanitizedSession,
} from "./types.js";

/** Category label used in placeholder strings (uppercased, underscored). */
const CATEGORY_LABELS: Record<RedactionCategory, string> = {
	"api-key": "API_KEY",
	password: "PASSWORD",
	email: "EMAIL",
	phone: "PHONE",
	jwt: "JWT",
	"auth-header": "AUTH_HEADER",
	"ip-address": "IP_ADDRESS",
	"filesystem-path": "PATH",
	"url-with-creds": "CRED_URL",
	"labeled-personal": "PERSONAL",
	"provider-token": "PROVIDER_TOKEN",
};

/**
 * Sanitize an entire session by detecting and replacing secrets/PII.
 *
 * @param session - The canonical session to sanitize.
 * @param config - Privacy configuration controlling which categories to detect.
 * @returns The sanitized session and a full redaction report.
 */
export function sanitize(
	session: CanonicalSession,
	config?: PrivacyConfig,
): { session: SanitizedSession; report: RedactionReport } {
	const categories = config?.categories ?? ALL_REDACTION_CATEGORIES;
	const customPatterns = config?.customPatterns;

	// Track raw value -> placeholder across the whole session for consistency
	const valueToPlaceholder = new Map<string, string>();
	const categoryCounts: Record<string, number> = {};
	const allEntries: RedactionEntry[] = [];

	const sanitizedMessages: SanitizedMessage[] = [];

	for (const message of session.messages) {
		const spans = detectAll(message.content, categories, customPatterns);
		const { text, entries } = replaceSpans(
			message.content,
			spans,
			valueToPlaceholder,
			categoryCounts,
		);
		allEntries.push(...entries);
		sanitizedMessages.push({
			...message,
			content: text,
		});
	}

	const report: RedactionReport = {
		totalRedactions: allEntries.length,
		categoryCounts: { ...categoryCounts },
		entries: allEntries,
	};

	const sanitized: SanitizedSession = {
		...session,
		messages: sanitizedMessages,
	};

	return { session: sanitized, report };
}

/**
 * Replace detected spans in text with stable placeholders.
 * Builds replacements right-to-left to preserve offsets.
 */
function replaceSpans(
	text: string,
	spans: ReadonlyArray<DetectedSpan>,
	valueToPlaceholder: Map<string, string>,
	categoryCounts: Record<string, number>,
): { text: string; entries: RedactionEntry[] } {
	if (spans.length === 0) return { text, entries: [] };

	const entries: RedactionEntry[] = [];
	let result = text;

	// Process right-to-left so earlier offsets remain valid
	for (let i = spans.length - 1; i >= 0; i--) {
		const span = spans[i];
		const placeholder = getOrCreatePlaceholder(
			span.rawValue,
			span.category,
			valueToPlaceholder,
			categoryCounts,
		);

		result = result.slice(0, span.start) + placeholder + result.slice(span.end);

		entries.unshift({
			placeholder,
			category: span.category,
			start: span.start,
			end: span.end,
		});
	}

	return { text: result, entries };
}

/**
 * Get an existing placeholder for a repeated value, or create a new one.
 * This ensures the same raw value always maps to the same placeholder
 * within a session.
 */
function getOrCreatePlaceholder(
	rawValue: string,
	category: RedactionCategory,
	valueToPlaceholder: Map<string, string>,
	categoryCounts: Record<string, number>,
): string {
	const existing = valueToPlaceholder.get(rawValue);
	if (existing) return existing;

	const label = CATEGORY_LABELS[category];
	const count = (categoryCounts[category] ?? 0) + 1;
	categoryCounts[category] = count;

	const placeholder = `<${label}_${count}>`;
	valueToPlaceholder.set(rawValue, placeholder);
	return placeholder;
}
