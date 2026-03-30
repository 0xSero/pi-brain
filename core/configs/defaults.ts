/**
 * @file core/configs/defaults.ts
 *
 * Responsibility: Default configuration values for the entire pipeline.
 * Every optional field in PiBrainConfig has a documented default here.
 *
 * Invariants:
 * - resolveConfig always returns a fully populated config with no undefined fields
 *   for the subset of config that was provided.
 * - Defaults are pure values — no side effects, no I/O.
 */

import type {
	AnonymizeConfig,
	ExportConfig,
	ExportFormat,
	PiBrainConfig,
	PrivacyConfig,
	RedactionCategory,
	ReviewerConfig,
} from "./types.js";

/** All supported redaction categories in v1. */
export const ALL_REDACTION_CATEGORIES: ReadonlyArray<RedactionCategory> = [
	"api-key",
	"password",
	"email",
	"phone",
	"jwt",
	"auth-header",
	"ip-address",
	"filesystem-path",
	"url-with-creds",
	"labeled-personal",
	"provider-token",
];

/** Default privacy configuration. */
export const DEFAULT_PRIVACY_CONFIG: Required<PrivacyConfig> = {
	categories: ALL_REDACTION_CATEGORIES,
	customPatterns: {},
};

/** Default anonymization configuration. */
export const DEFAULT_ANONYMIZE_CONFIG: Required<AnonymizeConfig> = {
	timestampJitterMs: 30 * 60 * 1000,
	additionalStrips: [],
	anonymizeIds: true,
	fuzzTimestamps: true,
	stripPaths: true,
};

/** Default reviewer configuration (off by default). */
export const DEFAULT_REVIEWER_CONFIG: Required<ReviewerConfig> = {
	enabled: false,
	baseUrl: "https://api.openai.com/v1",
	model: "gpt-4o-mini",
	apiKey: "",
	chunkTokens: 1000,
};

/** Default export configuration. */
export const DEFAULT_EXPORT_CONFIG: Required<ExportConfig> = {
	formats: ["sessions"] as ReadonlyArray<ExportFormat>,
	outputDir: "",
};

/**
 * Resolve a partial PiBrainConfig into one with all defaults applied.
 * Does NOT fill in upload config — that must be explicitly provided.
 */
export function resolveConfig(partial?: PiBrainConfig): {
	privacy: Required<PrivacyConfig>;
	anonymize: Required<AnonymizeConfig>;
	reviewer: Required<ReviewerConfig>;
	export: Required<ExportConfig>;
	upload: PiBrainConfig["upload"];
} {
	return {
		privacy: {
			...DEFAULT_PRIVACY_CONFIG,
			...(partial?.privacy ?? {}),
		},
		anonymize: {
			...DEFAULT_ANONYMIZE_CONFIG,
			...(partial?.anonymize ?? {}),
		},
		reviewer: {
			...DEFAULT_REVIEWER_CONFIG,
			...(partial?.reviewer ?? {}),
		},
		export: {
			...DEFAULT_EXPORT_CONFIG,
			...(partial?.export ?? {}),
		},
		upload: partial?.upload,
	};
}
