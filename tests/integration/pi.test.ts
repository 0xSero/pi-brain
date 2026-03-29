import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ExportFormat } from "../../core/configs/types.js";
import { createBundle } from "../../core/data-processing/bundle.js";
import type { CanonicalSession } from "../../core/data-processing/types.js";
import { sanitize } from "../../core/privacy/redactor.js";

/**
 * Manually parse the Pi fixture since we can't import the plugin in tests
 * without the full module resolution chain.
 */
function loadFixtureSession(): CanonicalSession {
	const fixturePath = join(import.meta.dirname, "..", "fixtures", "pi-session.jsonl");
	const content = readFileSync(fixturePath, "utf-8");
	const entries: any[] = [];
	for (const line of content.split("\n")) {
		if (line.trim()) entries.push(JSON.parse(line));
	}

	const messages = entries
		.filter((e) => e.type === "message")
		.map((e) => {
			const msg = e.message;
			const content = Array.isArray(msg.content)
				? msg.content
						.filter((c: any) => c.type === "text")
						.map((c: any) => c.text)
						.join("\n")
				: msg.content;
			return {
				role:
					msg.role === "toolResult" ? ("tool-result" as const) : (msg.role as "user" | "assistant"),
				content,
				timestamp: e.timestamp,
				model: msg.model,
				toolName: msg.toolName,
				toolCallId: msg.toolCallId,
			};
		});

	const header = entries.find((e) => e.type === "session");
	return {
		id: header?.id ?? "fixture-session",
		source: "pi",
		messages,
		projectPath: header?.cwd,
		createdAt: header?.timestamp,
	};
}

describe("integration: Pi fixture -> sanitize -> bundle", () => {
	it("loads and sanitizes the Pi fixture end-to-end", () => {
		const session = loadFixtureSession();
		expect(session.messages.length).toBeGreaterThan(0);
		expect(session.source).toBe("pi");

		const { session: sanitized, report } = sanitize(session);

		// Secrets should be redacted
		const allText = sanitized.messages.map((m) => m.content).join(" ");
		expect(allText).not.toContain("abcdef1234567890");
		expect(allText).not.toContain("john@example.com");
		expect(allText).not.toContain("supersecret123");
		expect(allText).not.toContain("192.168.1.100");

		// Placeholders should be present
		expect(allText).toContain("<");
		expect(allText).toContain(">");

		// Report should have entries
		expect(report.totalRedactions).toBeGreaterThan(0);
	});

	it("repeated emails in fixture reuse the same placeholder", () => {
		const session = loadFixtureSession();
		const { session: sanitized } = sanitize(session);

		const allText = sanitized.messages.map((m) => m.content).join(" ");
		// john@example.com appears in messages 1 and 6 of the fixture
		// Should both become <EMAIL_1>
		const emailPlaceholderCount = (allText.match(/<EMAIL_1>/g) ?? []).length;
		expect(emailPlaceholderCount).toBeGreaterThanOrEqual(2);
	});

	it("produces a valid export bundle from the sanitized fixture", () => {
		const session = loadFixtureSession();
		const { session: sanitized } = sanitize(session);

		const bundle = createBundle([sanitized], {
			formats: ["sessions", "sft-jsonl", "chatml"] as ReadonlyArray<ExportFormat>,
			outputDir: "",
		});

		expect(bundle.artifacts).toHaveLength(3);
		expect(bundle.manifestHash).toMatch(/^[a-f0-9]{64}$/);
		expect(bundle.metadata.sessionCount).toBe(1);
		expect(bundle.metadata.messageCount).toBeGreaterThan(0);

		// Validate each artifact is parseable
		for (const artifact of bundle.artifacts) {
			const lines = artifact.content.trim().split("\n");
			for (const line of lines) {
				expect(() => JSON.parse(line)).not.toThrow();
			}
		}
	});
});
