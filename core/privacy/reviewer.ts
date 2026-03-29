/**
 * @file core/privacy/reviewer.ts
 *
 * Responsibility: Optional structured review via an OpenAI-compatible endpoint.
 * Sends already-sanitized text chunks and asks for residual entity detection.
 * Never sees raw secrets — only text that has already passed through the
 * deterministic redactor.
 *
 * Invariants:
 * - Input chunks must already be sanitized (no raw secrets).
 * - The reviewer returns strict JSON findings; free text is rejected.
 * - Review is off by default; must be explicitly enabled in config.
 * - Findings reference chunk indices and offsets for merge-back.
 */

import type { ReviewerConfig } from "../configs/types.js";
import type { TextChunk } from "../data-processing/types.js";
import type { StructuredFinding } from "./types.js";

/** System prompt instructing the reviewer to find residual entities. */
const REVIEW_SYSTEM_PROMPT = `You are a privacy review assistant. You receive text that has already been partially redacted. Your job is to find any residual personally identifiable information (PII) that the automated redactor missed.

Look for:
- Person names (first, last, full)
- Street addresses and physical locations
- Organization-specific identifiers
- Any other identifiable entities

Respond ONLY with a JSON array of findings. Each finding must have:
- "start": character offset where the entity starts in the chunk
- "end": character offset where the entity ends
- "entityType": what kind of entity (e.g. "person-name", "street-address", "org-id")
- "suggestedPlaceholder": a replacement like <NAME_1> or <ADDRESS_1>
- "confidence": a number between 0 and 1

If no residual entities are found, respond with an empty array: []`;

/**
 * Run structured review on already-sanitized chunks.
 *
 * @param chunks - Sanitized text chunks to review.
 * @param config - Reviewer configuration (must have enabled=true).
 * @returns Array of structured findings across all chunks.
 */
export async function review(
	chunks: ReadonlyArray<TextChunk>,
	config: Required<ReviewerConfig>,
): Promise<StructuredFinding[]> {
	if (!config.enabled) return [];

	const apiKey = config.apiKey || process.env.PI_BRAIN_REVIEWER_API_KEY;
	if (!apiKey) {
		throw new Error(
			"Structured review is enabled but no API key provided. " +
				"Set reviewer.apiKey in config or PI_BRAIN_REVIEWER_API_KEY env var.",
		);
	}

	const findings: StructuredFinding[] = [];

	for (const chunk of chunks) {
		const chunkFindings = await reviewSingleChunk(chunk, config, apiKey);
		findings.push(...chunkFindings);
	}

	return findings;
}

/** Send a single chunk for review and parse the JSON response. */
async function reviewSingleChunk(
	chunk: TextChunk,
	config: Required<ReviewerConfig>,
	apiKey: string,
): Promise<StructuredFinding[]> {
	const url = `${config.baseUrl.replace(/\/$/, "")}/chat/completions`;

	const body = {
		model: config.model,
		messages: [
			{ role: "system" as const, content: REVIEW_SYSTEM_PROMPT },
			{
				role: "user" as const,
				content: `Review this sanitized text chunk (index ${chunk.index}) for residual PII:\n\n${chunk.text}`,
			},
		],
		temperature: 0,
		response_format: { type: "json_object" as const },
	};

	const response = await fetch(url, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${apiKey}`,
		},
		body: JSON.stringify(body),
	});

	if (!response.ok) {
		const errorText = await response.text().catch(() => "unknown error");
		throw new Error(`Reviewer API error ${response.status}: ${errorText}`);
	}

	const data = (await response.json()) as {
		choices: Array<{ message: { content: string } }>;
	};
	const content = data.choices?.[0]?.message?.content;
	if (!content) return [];

	try {
		const parsed = JSON.parse(content);
		const rawFindings = Array.isArray(parsed) ? parsed : (parsed.findings ?? []);
		return rawFindings
			.filter(
				(f: any) =>
					typeof f.start === "number" &&
					typeof f.end === "number" &&
					typeof f.entityType === "string",
			)
			.map((f: any) => ({
				chunkIndex: chunk.index,
				start: f.start,
				end: f.end,
				entityType: f.entityType,
				suggestedPlaceholder: f.suggestedPlaceholder ?? `<${f.entityType.toUpperCase()}_1>`,
				confidence: typeof f.confidence === "number" ? f.confidence : 0.5,
			}));
	} catch {
		// Malformed JSON from reviewer — skip silently
		return [];
	}
}
