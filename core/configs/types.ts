/**
 * @file core/configs/types.ts
 *
 * Responsibility: Central configuration types for the entire pi-brain pipeline.
 * Every configurable behavior — privacy, review, export format, upload target —
 * flows through a single PiBrainConfig object.
 *
 * Invariants:
 * - All optional fields have documented defaults in defaults.ts.
 * - Config is a plain serializable object (no class instances, no functions).
 * - Plugin-specific config extends PluginConfig; core never imports plugin types.
 */

/** Which secret/PII categories the deterministic redactor should detect. */
export type RedactionCategory =
	| "api-key"
	| "password"
	| "email"
	| "phone"
	| "jwt"
	| "auth-header"
	| "ip-address"
	| "filesystem-path"
	| "url-with-creds"
	| "labeled-personal"
	| "provider-token";

/** Configuration for the local-only deterministic privacy engine. */
export interface PrivacyConfig {
	/** Categories to detect. Defaults to all categories. */
	readonly categories?: ReadonlyArray<RedactionCategory>;
	/** Custom regex patterns to add on top of built-in detectors, keyed by a label. */
	readonly customPatterns?: Readonly<Record<string, string>>;
}

/** Configuration for the optional structured reviewer (OpenAI-compatible endpoint). */
export interface ReviewerConfig {
	/** Whether structured review is enabled. Defaults to false. */
	readonly enabled?: boolean;
	/** Base URL of the OpenAI-compatible endpoint. */
	readonly baseUrl?: string;
	/** Model identifier for the reviewer. */
	readonly model?: string;
	/** API key for the reviewer endpoint. Read from env PI_BRAIN_REVIEWER_API_KEY if unset. */
	readonly apiKey?: string;
	/** Max tokens per chunk sent for review. Defaults to 1000. */
	readonly chunkTokens?: number;
}

/** Supported export formats. */
export type ExportFormat = "sessions" | "sft-jsonl" | "chatml";

/** Configuration for data export. */
export interface ExportConfig {
	/** Formats to emit. Defaults to ["sessions"]. */
	readonly formats?: ReadonlyArray<ExportFormat>;
	/** Output directory. Defaults to .pi-private-data/exports/<timestamp>/. */
	readonly outputDir?: string;
}

/** Upload target type. */
export type UploadTargetType = "huggingface" | "http";

/** Configuration for Hugging Face upload. */
export interface HuggingFaceUploadConfig {
	readonly type: "huggingface";
	/** HF dataset repo (e.g. "user/dataset-name"). */
	readonly repo: string;
	/** HF token. Read from env HF_TOKEN if unset. */
	readonly token?: string;
	/** Visibility. Defaults to "private". Must explicitly set "public" to publish. */
	readonly visibility?: "private" | "public";
}

/** Configuration for generic HTTP upload. */
export interface HttpUploadConfig {
	readonly type: "http";
	/** Target URL for multipart upload. */
	readonly url: string;
	/** Additional headers (e.g. Authorization). */
	readonly headers?: Readonly<Record<string, string>>;
}

export type UploadConfig = HuggingFaceUploadConfig | HttpUploadConfig;

/** Top-level pi-brain configuration. */
export interface PiBrainConfig {
	readonly privacy?: PrivacyConfig;
	readonly reviewer?: ReviewerConfig;
	readonly export?: ExportConfig;
	readonly upload?: UploadConfig;
}
