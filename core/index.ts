/**
 * @file core/index.ts
 *
 * Responsibility: Public API surface for the core library.
 * Re-exports everything that plugins and CLI need. This is the only
 * import path external code should use for core functionality.
 *
 * Invariants:
 * - Every public type and function is exported from here.
 * - No business logic in this file — only re-exports.
 * - Core never imports from plugins.
 */

// -- Config types and defaults --
export type {
	PiBrainConfig,
	PrivacyConfig,
	AnonymizeConfig,
	ReviewerConfig,
	ExportConfig,
	ExportFormat,
	UploadConfig,
	UploadTargetType,
	HuggingFaceUploadConfig,
	HttpUploadConfig,
	RedactionCategory,
} from "./configs/types.js";
export {
	resolveConfig,
	ALL_REDACTION_CATEGORIES,
	DEFAULT_ANONYMIZE_CONFIG,
} from "./configs/defaults.js";

// -- Data processing types --
export type {
	CanonicalSession,
	CanonicalMessage,
	CanonicalToolCall,
	MessageRole,
	TextChunk,
	ExportArtifact,
	ExportBundle,
} from "./data-processing/types.js";

// -- Data processing functions --
export { canonicalize } from "./data-processing/canonicalize.js";
export { chunk } from "./data-processing/chunker.js";
export { format } from "./data-processing/formatters.js";
export { createBundle, writeBundle } from "./data-processing/bundle.js";

// -- Privacy types --
export type {
	DetectedSpan,
	RedactionEntry,
	RedactionReport,
	SanitizedSession,
	SanitizedMessage,
	StructuredFinding,
} from "./privacy/types.js";

// -- Privacy functions --
export { detectAll } from "./privacy/detectors.js";
export { anonymize } from "./privacy/anonymizer.js";
export type { AnonymizeResult } from "./privacy/anonymizer.js";
export { sanitize } from "./privacy/redactor.js";
export { review } from "./privacy/reviewer.js";

// -- Upload types --
export type { UploadResult, UploadTarget } from "./uploads/types.js";

// -- Upload functions --
export { upload } from "./uploads/uploader.js";

/**
 * Source plugin contract.
 * Every source plugin must implement this interface.
 */
export interface SourcePlugin {
	/** Human-readable name of this source (e.g. "pi", "claude", "codex"). */
	readonly name: string;
	/** Load a session by reference (file path, session ID, "current", etc.). */
	loadSession(ref: string): Promise<import("./data-processing/types.js").CanonicalSession>;
	/** List available session references. */
	listSessions(): Promise<string[]>;
}

/** Error thrown when a source plugin does not yet support a feature. */
export class NotYetSupportedError extends Error {
	constructor(source: string, feature?: string) {
		super(
			`${source} adapter: ${feature ?? "this operation"} is not yet supported. It will be implemented when the storage format is documented.`,
		);
		this.name = "NotYetSupportedError";
	}
}
