import { describe, expect, it } from "vitest";
import { canonicalize } from "../../core/data-processing/canonicalize.js";

describe("canonicalize", () => {
	it("accepts a valid session", () => {
		const result = canonicalize({
			id: "test-1",
			source: "test",
			messages: [{ role: "user", content: "Hello" }],
		});
		expect(result.id).toBe("test-1");
		expect(result.source).toBe("test");
		expect(result.messages).toHaveLength(1);
	});

	it("rejects null input", () => {
		expect(() => canonicalize(null)).toThrow("non-null object");
	});

	it("rejects missing id", () => {
		expect(() =>
			canonicalize({ source: "test", messages: [{ role: "user", content: "Hi" }] }),
		).toThrow("non-empty string id");
	});

	it("rejects empty messages", () => {
		expect(() => canonicalize({ id: "test", source: "test", messages: [] })).toThrow(
			"at least one message",
		);
	});

	it("rejects invalid role", () => {
		expect(() =>
			canonicalize({
				id: "test",
				source: "test",
				messages: [{ role: "invalid", content: "Hi" }],
			}),
		).toThrow('invalid role "invalid"');
	});

	it("sorts messages by timestamp", () => {
		const result = canonicalize({
			id: "test",
			source: "test",
			messages: [
				{ role: "assistant", content: "Hi", timestamp: "2024-12-01T10:00:02Z" },
				{ role: "user", content: "Hello", timestamp: "2024-12-01T10:00:01Z" },
			],
		});
		expect(result.messages[0].role).toBe("user");
		expect(result.messages[1].role).toBe("assistant");
	});

	it("preserves optional fields when present", () => {
		const result = canonicalize({
			id: "test",
			source: "test",
			messages: [{ role: "user", content: "Hi", model: "gpt-4" }],
			projectPath: "/tmp/project",
			name: "Test Session",
			createdAt: "2024-12-01T10:00:00Z",
			metadata: { custom: "data" },
		});
		expect(result.projectPath).toBe("/tmp/project");
		expect(result.name).toBe("Test Session");
		expect(result.createdAt).toBe("2024-12-01T10:00:00Z");
		expect(result.metadata?.custom).toBe("data");
		expect(result.messages[0].model).toBe("gpt-4");
	});
});
