/**
 * @file core/data-processing/formatters.ts
 *
 * Responsibility: Convert sanitized sessions into training-ready formats.
 * Three formats in v1:
 *   - "sessions": raw JSONL (one session per line, our canonical format)
 *   - "sft-jsonl": Supervised Fine-Tuning format (one conversation per line)
 *   - "chatml": ChatML-tagged format for chat model training
 *
 * Invariants:
 * - Formatters are pure functions: sanitized session in, ExportArtifact out.
 * - Output is always valid for its declared format.
 * - No information is added or inferred — only reformatted.
 */

import type { ExportFormat } from "../configs/types.js";
import type { SanitizedSession } from "../privacy/types.js";
import type { ExportArtifact } from "./types.js";

/**
 * Format one or more sanitized sessions into the specified export format.
 *
 * @param sessions - Sanitized sessions to format.
 * @param format - Target format.
 * @returns An ExportArtifact ready to write to disk.
 */
export function format(
	sessions: ReadonlyArray<SanitizedSession>,
	formatType: ExportFormat,
): ExportArtifact {
	switch (formatType) {
		case "sessions":
			return formatSessions(sessions);
		case "sft-jsonl":
			return formatSftJsonl(sessions);
		case "chatml":
			return formatChatMl(sessions);
		default:
			throw new Error(`Unknown format: ${formatType}`);
	}
}

/** Sessions format: one full session object per JSONL line. */
function formatSessions(sessions: ReadonlyArray<SanitizedSession>): ExportArtifact {
	const lines = sessions.map((s) => JSON.stringify(s));
	return {
		format: "sessions",
		fileName: "sessions.jsonl",
		content: `${lines.join("\n")}\n`,
	};
}

/**
 * SFT-JSONL format: one conversation per line with a flat messages array.
 * Compatible with most fine-tuning frameworks (Unsloth, Axolotl, etc.)
 */
function formatSftJsonl(sessions: ReadonlyArray<SanitizedSession>): ExportArtifact {
	const lines = sessions.map((session) => {
		const messages = session.messages
			.filter((m) => m.role === "user" || m.role === "assistant")
			.map((m) => ({
				role: m.role,
				content: m.content,
			}));
		return JSON.stringify({
			messages,
			source: session.source,
			id: session.id,
		});
	});
	return {
		format: "sft-jsonl",
		fileName: "sft.jsonl",
		content: `${lines.join("\n")}\n`,
	};
}

/**
 * ChatML format: tagged messages in a single text block per conversation.
 * Output is JSONL where each line has a "text" field with ChatML markup.
 */
function formatChatMl(sessions: ReadonlyArray<SanitizedSession>): ExportArtifact {
	const lines = sessions.map((session) => {
		const chatMl = session.messages
			.filter((m) => m.role === "user" || m.role === "assistant")
			.map((m) => `<|im_start|>${m.role}\n${m.content}<|im_end|>`)
			.join("\n");
		return JSON.stringify({ text: chatMl, source: session.source, id: session.id });
	});
	return {
		format: "chatml",
		fileName: "chatml.jsonl",
		content: `${lines.join("\n")}\n`,
	};
}
