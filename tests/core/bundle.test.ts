import { describe, expect, it } from "vitest";
import type { ExportFormat } from "../../core/configs/types.js";
import { createBundle } from "../../core/data-processing/bundle.js";
import type { SanitizedSession } from "../../core/privacy/types.js";

describe("bundle", () => {
	const sessions: SanitizedSession[] = [
		{
			id: "s1",
			source: "test",
			messages: [
				{ role: "user", content: "Hello" },
				{ role: "assistant", content: "Hi there" },
			],
		},
	];

	it("creates a bundle with manifest hash", () => {
		const bundle = createBundle(sessions, {
			formats: ["sessions"] as ReadonlyArray<ExportFormat>,
			outputDir: "",
		});
		expect(bundle.manifestHash).toMatch(/^[a-f0-9]{64}$/);
		expect(bundle.artifacts).toHaveLength(1);
		expect(bundle.metadata.sessionCount).toBe(1);
		expect(bundle.metadata.messageCount).toBe(2);
	});

	it("includes all requested formats", () => {
		const bundle = createBundle(sessions, {
			formats: ["sessions", "sft-jsonl", "chatml"] as ReadonlyArray<ExportFormat>,
			outputDir: "",
		});
		expect(bundle.artifacts).toHaveLength(3);
		const formats = bundle.artifacts.map((a) => a.format);
		expect(formats).toContain("sessions");
		expect(formats).toContain("sft-jsonl");
		expect(formats).toContain("chatml");
	});

	it("manifest hash is deterministic", () => {
		const config = {
			formats: ["sessions"] as ReadonlyArray<ExportFormat>,
			outputDir: "",
		};
		const bundle1 = createBundle(sessions, config);
		const bundle2 = createBundle(sessions, config);
		expect(bundle1.manifestHash).toBe(bundle2.manifestHash);
	});

	it("includes target metadata", () => {
		const bundle = createBundle(sessions, {
			formats: ["sessions"] as ReadonlyArray<ExportFormat>,
			outputDir: "",
		});
		expect(bundle.metadata.source).toBe("test");
		expect(bundle.metadata.formats).toContain("sessions");
		expect(bundle.createdAt).toBeTruthy();
	});
});
