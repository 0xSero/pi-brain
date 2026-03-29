/**
 * @file core/privacy/types.ts
 *
 * Responsibility: Type definitions for the privacy/redaction subsystem.
 * Describes what a detector finds, how redactions are tracked, and the
 * shape of a fully sanitized session.
 *
 * Invariants:
 * - A RedactionSpan always references exact byte offsets in the original text.
 * - Placeholder IDs are deterministic: the same secret in the same session
 *   always produces the same placeholder (e.g. <API_KEY_1>).
 * - SanitizedSession is structurally identical to CanonicalSession except
 *   that every text field has been redacted.
 */

import type { RedactionCategory } from "../configs/types.js";
import type { CanonicalMessage, CanonicalSession } from "../data-processing/types.js";

/** A single detected span in a text. */
export interface DetectedSpan {
	/** Start offset (inclusive) in the source text. */
	readonly start: number;
	/** End offset (exclusive) in the source text. */
	readonly end: number;
	/** The category this span belongs to. */
	readonly category: RedactionCategory;
	/** The raw matched text. Never leaves the machine. */
	readonly rawValue: string;
}

/** A replacement applied during redaction. */
export interface RedactionEntry {
	/** The stable placeholder that replaced this span (e.g. <EMAIL_1>). */
	readonly placeholder: string;
	/** The category of the redacted content. */
	readonly category: RedactionCategory;
	/** Start offset in original text. */
	readonly start: number;
	/** End offset in original text. */
	readonly end: number;
}

/** Full report of all redactions applied to a session. */
export interface RedactionReport {
	/** Total number of replacements made across all messages. */
	readonly totalRedactions: number;
	/** Counts per category. */
	readonly categoryCounts: Readonly<Record<string, number>>;
	/** Ordered list of every redaction entry. */
	readonly entries: ReadonlyArray<RedactionEntry>;
}

/** A session with all text fields redacted. */
export interface SanitizedSession extends Omit<CanonicalSession, "messages"> {
	readonly messages: ReadonlyArray<SanitizedMessage>;
}

/** A message with redacted content. */
export interface SanitizedMessage extends Omit<CanonicalMessage, "content"> {
	/** The redacted text content. */
	readonly content: string;
}

/** A structured finding from the optional AI reviewer. */
export interface StructuredFinding {
	/** The chunk index this finding refers to. */
	readonly chunkIndex: number;
	/** Offset within the chunk where the residual entity starts. */
	readonly start: number;
	/** Offset within the chunk where the residual entity ends. */
	readonly end: number;
	/** What kind of entity was found (e.g. "person-name", "street-address"). */
	readonly entityType: string;
	/** Suggested placeholder. */
	readonly suggestedPlaceholder: string;
	/** Confidence 0-1. */
	readonly confidence: number;
}
