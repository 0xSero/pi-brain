import { describe, expect, it } from "vitest";
import { format } from "../../core/data-processing/formatters.js";
import type { SanitizedSession } from "../../core/privacy/types.js";

const makeSessions = (): SanitizedSession[] => [
	{
		id: "test-1",
		source: "test",
		messages: [
			{ role: "user", content: "Hello, how do I fix this?" },
			{
				role: "assistant",
				content: "The issue is in your type definition.",
				model: "test-model",
			},
		],
	},
	{
		id: "test-2",
		source: "test",
		messages: [
			{ role: "user", content: "Can you explain generics?" },
			{ role: "assistant", content: "Generics allow you to write reusable code." },
			{ role: "user", content: "Thanks, can you show an example?" },
			{
				role: "assistant",
				content: "Here is a generic function: function id<T>(x: T): T { return x; }",
			},
		],
	},
];

describe("formatters", () => {
	describe("sessions format", () => {
		it("produces valid JSONL with one session per line", () => {
			const sessions = makeSessions();
			const artifact = format(sessions, "sessions");
			expect(artifact.format).toBe("sessions");
			expect(artifact.fileName).toBe("sessions.jsonl");

			const lines = artifact.content.trim().split("\n");
			expect(lines).toHaveLength(2);

			const parsed0 = JSON.parse(lines[0]);
			expect(parsed0.id).toBe("test-1");
			expect(parsed0.messages).toHaveLength(2);

			const parsed1 = JSON.parse(lines[1]);
			expect(parsed1.id).toBe("test-2");
			expect(parsed1.messages).toHaveLength(4);
		});
	});

	describe("sft-jsonl format", () => {
		it("produces valid JSONL with user/assistant messages only", () => {
			const sessions = makeSessions();
			const artifact = format(sessions, "sft-jsonl");
			expect(artifact.format).toBe("sft-jsonl");
			expect(artifact.fileName).toBe("sft.jsonl");

			const lines = artifact.content.trim().split("\n");
			expect(lines).toHaveLength(2);

			const parsed = JSON.parse(lines[0]);
			expect(parsed.messages).toHaveLength(2);
			expect(parsed.messages[0].role).toBe("user");
			expect(parsed.messages[1].role).toBe("assistant");
			expect(parsed.source).toBe("test");
		});
	});

	describe("chatml format", () => {
		it("produces valid ChatML with im_start/im_end tags", () => {
			const sessions = makeSessions();
			const artifact = format(sessions, "chatml");
			expect(artifact.format).toBe("chatml");
			expect(artifact.fileName).toBe("chatml.jsonl");

			const lines = artifact.content.trim().split("\n");
			expect(lines).toHaveLength(2);

			const parsed = JSON.parse(lines[0]);
			expect(parsed.text).toContain("<|im_start|>user");
			expect(parsed.text).toContain("<|im_end|>");
			expect(parsed.text).toContain("<|im_start|>assistant");
		});
	});
});
