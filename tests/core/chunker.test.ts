import { describe, expect, it } from "vitest";
import { chunk } from "../../core/data-processing/chunker.js";

describe("chunker", () => {
	it("returns a single chunk for short text", () => {
		const result = chunk("Hello world", 1000);
		expect(result).toHaveLength(1);
		expect(result[0].text).toBe("Hello world");
		expect(result[0].index).toBe(0);
		expect(result[0].startOffset).toBe(0);
		expect(result[0].endOffset).toBe(11);
	});

	it("chunks are deterministic", () => {
		const text = "A".repeat(10000);
		const result1 = chunk(text, 100);
		const result2 = chunk(text, 100);
		expect(result1).toEqual(result2);
	});

	it("concatenating chunks reproduces original text", () => {
		const text = "Hello world.\n\nThis is a test.\nAnother line.\n\nFinal paragraph.";
		const chunks = chunk(text, 5); // Very small chunks to force splitting
		const reconstructed = chunks.map((c) => c.text).join("");
		expect(reconstructed).toBe(text);
	});

	it("chunks are offset-safe", () => {
		const text = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".repeat(100);
		const chunks = chunk(text, 50);
		for (const c of chunks) {
			expect(c.text).toBe(text.slice(c.startOffset, c.endOffset));
		}
	});

	it("does not split placeholders", () => {
		// Create text where a placeholder would be at the split boundary
		const prefix = "A".repeat(3990); // Just under 1000 tokens * 4 chars
		const text = `${prefix}<EMAIL_1>rest of text`;
		const chunks = chunk(text, 1000);

		// No chunk should contain a partial placeholder
		for (const c of chunks) {
			const openCount = (c.text.match(/</g) ?? []).length;
			const closeCount = (c.text.match(/>/g) ?? []).length;
			expect(openCount).toBe(closeCount);
		}
	});

	it("handles empty text", () => {
		const result = chunk("", 1000);
		expect(result).toHaveLength(1);
		expect(result[0].text).toBe("");
	});

	it("token counts are positive for non-empty chunks", () => {
		const text = "Hello world. This is a test with some content.";
		const chunks = chunk(text, 5);
		for (const c of chunks) {
			if (c.text.length > 0) {
				expect(c.tokenCount).toBeGreaterThan(0);
			}
		}
	});
});
