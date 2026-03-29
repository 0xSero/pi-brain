/**
 * @file plugins/providers/openai-compatible/index.ts
 *
 * OpenAI-compatible provider plugin for the structured reviewer.
 * This isn't a source plugin — it's the backend for the optional
 * structured review pass that examines already-sanitized chunks.
 *
 * Uses the standard OpenAI chat completions API and expects
 * JSON-mode responses.
 */

import { DEFAULT_REVIEWER_CONFIG } from "../../../core/configs/defaults.js";
import type { ReviewerConfig } from "../../../core/configs/types.js";
import type { TextChunk } from "../../../core/data-processing/types.js";
import { review } from "../../../core/privacy/reviewer.js";
import type { StructuredFinding } from "../../../core/privacy/types.js";

/**
 * Convenience wrapper for running structured review with config overrides.
 * Resolves defaults and delegates to core reviewer.
 */
export async function runStructuredReview(
	chunks: ReadonlyArray<TextChunk>,
	config?: Partial<ReviewerConfig>,
): Promise<StructuredFinding[]> {
	const resolved: Required<ReviewerConfig> = {
		...DEFAULT_REVIEWER_CONFIG,
		...(config ?? {}),
	};

	if (!resolved.enabled) return [];

	return review(chunks, resolved);
}

export { review };
