/**
 * @file core/data-processing/chunker.ts
 *
 * Responsibility: Split text into deterministic, offset-safe chunks
 * suitable for structured review or any token-limited consumer.
 *
 * Invariants:
 * - Chunking is deterministic: same input always produces same chunks.
 * - Chunk boundaries never split a placeholder (e.g. <EMAIL_1>).
 * - Concatenating all chunk texts reproduces the original text exactly.
 * - Token count is approximate (based on whitespace splitting, ~4 chars/token).
 */

import type { TextChunk } from "./types.js";

/** Approximate tokens per character ratio (conservative estimate). */
const CHARS_PER_TOKEN = 4;

/**
 * Split text into chunks of approximately `maxTokens` tokens each.
 * Splits on paragraph/line boundaries when possible, never inside a placeholder.
 *
 * @param text - The full text to chunk.
 * @param maxTokens - Maximum approximate tokens per chunk. Defaults to 1000.
 * @returns Ordered array of text chunks with offset tracking.
 */
export function chunk(text: string, maxTokens = 1000): TextChunk[] {
	if (text.length === 0) {
		return [{ index: 0, text: "", startOffset: 0, endOffset: 0, tokenCount: 0 }];
	}

	const maxChars = maxTokens * CHARS_PER_TOKEN;
	const chunks: TextChunk[] = [];
	let offset = 0;

	while (offset < text.length) {
		let end = Math.min(offset + maxChars, text.length);

		// If we're not at the end of the text, find a good split point
		if (end < text.length) {
			end = findSplitPoint(text, offset, end);
		}

		const chunkText = text.slice(offset, end);
		chunks.push({
			index: chunks.length,
			text: chunkText,
			startOffset: offset,
			endOffset: end,
			tokenCount: estimateTokens(chunkText),
		});

		offset = end;
	}

	return chunks;
}

/**
 * Find a good split point near `target` that doesn't break placeholders
 * or words when possible. Prefers paragraph > line > word boundaries.
 */
function findSplitPoint(text: string, start: number, target: number): number {
	let splitTarget = target;

	// Don't split inside a placeholder like <EMAIL_1>
	const openBracket = text.lastIndexOf("<", splitTarget);
	const closeBracket = text.indexOf(">", openBracket);
	if (openBracket > start && closeBracket >= splitTarget) {
		splitTarget = openBracket;
	}

	// Look for paragraph break (double newline) near splitTarget
	const searchStart = Math.max(start, splitTarget - 200);
	const searchRegion = text.slice(searchStart, splitTarget);

	const paragraphBreak = searchRegion.lastIndexOf("\n\n");
	if (paragraphBreak !== -1) {
		return searchStart + paragraphBreak + 2;
	}

	// Look for line break
	const lineBreak = searchRegion.lastIndexOf("\n");
	if (lineBreak !== -1) {
		return searchStart + lineBreak + 1;
	}

	// Look for word boundary (space)
	const space = searchRegion.lastIndexOf(" ");
	if (space !== -1) {
		return searchStart + space + 1;
	}

	return splitTarget;
}

/** Estimate token count for a text (whitespace-split heuristic). */
function estimateTokens(text: string): number {
	if (text.length === 0) return 0;
	return Math.max(1, Math.ceil(text.length / CHARS_PER_TOKEN));
}
