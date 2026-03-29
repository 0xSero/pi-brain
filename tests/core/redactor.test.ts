import { describe, expect, it } from "vitest";
import type { CanonicalSession } from "../../core/data-processing/types.js";
import { detectAll } from "../../core/privacy/detectors.js";
import { sanitize } from "../../core/privacy/redactor.js";

describe("detectors", () => {
	it("detects API keys", () => {
		const text = "SECRET_KEY=abcdef1234567890abcdef";
		const spans = detectAll(text, ["api-key"]);
		expect(spans.length).toBeGreaterThanOrEqual(1);
		expect(spans[0].category).toBe("api-key");
	});

	it("detects email addresses", () => {
		const text = "Contact me at john.doe@example.com for details";
		const spans = detectAll(text, ["email"]);
		expect(spans.length).toBe(1);
		expect(spans[0].rawValue).toBe("john.doe@example.com");
		expect(spans[0].category).toBe("email");
	});

	it("detects common phone number formats", () => {
		const text = "Call 555-123-4567, (555) 987-6543, or +1 555 123 4567";
		const spans = detectAll(text, ["phone"]);
		expect(spans.map((span) => span.rawValue)).toEqual([
			"555-123-4567",
			"(555) 987-6543",
			"+1 555 123 4567",
		]);
	});

	it("does not detect timestamps as phone numbers", () => {
		const text = "2026-02-22 09:50:10.123456";
		const spans = detectAll(text, ["phone"]);
		expect(spans).toEqual([]);
	});

	it("does not detect comma-delimited numeric handles as phone numbers", () => {
		const text = "field-trial-handle=123,456,789,000";
		const spans = detectAll(text, ["phone"]);
		expect(spans).toEqual([]);
	});

	it("detects JWTs", () => {
		// Build a fake JWT dynamically so static scanners don't flag it
		const header = "eyJhbGciOiJIUzI1NiJ9";
		const payload = "eyJzdWIiOiIxMjM0NTY3ODkwIn0";
		const sig = "XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";
		const fakeJwt = `${header}.${payload}.${sig}`;
		const text = `Token: ${fakeJwt}`;
		const spans = detectAll(text, ["jwt"]);
		expect(spans.length).toBe(1);
		expect(spans[0].category).toBe("jwt");
	});

	it("detects password fields", () => {
		const text = "PASSWORD=changeme123 and password: changeme456";
		const spans = detectAll(text, ["password"]);
		expect(spans.length).toBeGreaterThanOrEqual(1);
	});

	it("detects IP addresses but excludes 127.0.0.1", () => {
		const text = "Server at 192.168.1.100 and localhost 127.0.0.1";
		const spans = detectAll(text, ["ip-address"]);
		expect(spans.length).toBe(1);
		expect(spans[0].rawValue).toBe("192.168.1.100");
	});

	it("detects filesystem paths with home directories", () => {
		const text = "File at /home/user/my-project/src/index.ts";
		const spans = detectAll(text, ["filesystem-path"]);
		expect(spans.length).toBe(1);
	});

	it("returns non-overlapping spans sorted by start", () => {
		const text = "Email john@example.com has key API_KEY=abc123longkeyhere";
		const spans = detectAll(text, ["email", "api-key"]);
		for (let i = 1; i < spans.length; i++) {
			expect(spans[i].start).toBeGreaterThanOrEqual(spans[i - 1].end);
		}
	});

	it("respects category filtering", () => {
		const text = "Email john@example.com and phone 555-123-4567";
		const emailOnly = detectAll(text, ["email"]);
		expect(emailOnly.every((s) => s.category === "email")).toBe(true);
	});

	it("supports custom patterns", () => {
		const text = "Internal ref: PROJ-12345-INTERNAL";
		const spans = detectAll(text, ["api-key"], {
			"project-ref": "PROJ-\\d+-INTERNAL",
		});
		expect(spans.length).toBeGreaterThanOrEqual(1);
	});
});

describe("redactor", () => {
	const makeSession = (messages: Array<{ role: string; content: string }>): CanonicalSession => ({
		id: "test-session",
		source: "test",
		messages: messages.map((m) => ({
			role: m.role as "user" | "assistant",
			content: m.content,
		})),
	});

	it("preserves text outside replaced spans byte-for-byte", () => {
		const session = makeSession([
			{
				role: "user",
				content: "Hello world, email me at test@example.com please",
			},
		]);
		const { session: sanitized } = sanitize(session);
		expect(sanitized.messages[0].content).toContain("Hello world, email me at ");
		expect(sanitized.messages[0].content).toContain(" please");
		expect(sanitized.messages[0].content).not.toContain("test@example.com");
	});

	it("replaces secrets with stable placeholders", () => {
		const session = makeSession([
			{ role: "user", content: "My email is test@example.com" },
			{
				role: "assistant",
				content: "I see your email test@example.com in the message",
			},
		]);
		const { session: sanitized, report } = sanitize(session);
		const placeholder = "<EMAIL_1>";
		expect(sanitized.messages[0].content).toContain(placeholder);
		expect(sanitized.messages[1].content).toContain(placeholder);
		expect(report.totalRedactions).toBe(2);
	});

	it("repeated secrets reuse the same placeholder ID", () => {
		const session = makeSession([
			{ role: "user", content: "Email test@example.com here" },
			{
				role: "assistant",
				content: "I see test@example.com and other@example.com",
			},
		]);
		const { session: sanitized } = sanitize(session);
		const text0 = sanitized.messages[0].content;
		const text1 = sanitized.messages[1].content;

		expect(text0).toContain("<EMAIL_1>");
		expect(text1).toContain("<EMAIL_1>");
		expect(text1).toContain("<EMAIL_2>");
		expect(text0).not.toContain("<EMAIL_2>");
	});

	it("supported secret classes never survive the deterministic pass", () => {
		// Build fake JWT dynamically
		const fakeJwt = [
			"eyJhbGciOiJIUzI1NiJ9",
			"eyJzdWIiOiIxMjM0NTY3ODkwIn0",
			"XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
		].join(".");
		const session = makeSession([
			{
				role: "user",
				content: [
					"SECRET_KEY=abcdef1234567890abcdef",
					"PASSWORD=changeme",
					"test@example.com",
					"555-123-4567",
					fakeJwt,
					"192.168.1.100",
					"/home/user/private/path",
				].join(" | "),
			},
		]);
		const { session: sanitized } = sanitize(session);
		const text = sanitized.messages[0].content;

		expect(text).not.toContain("abcdef1234567890");
		expect(text).not.toContain("changeme");
		expect(text).not.toContain("test@example.com");
		expect(text).not.toContain("555-123-4567");
		expect(text).not.toContain("eyJhbGciOi");
		expect(text).not.toContain("192.168.1.100");
		expect(text).not.toContain("/home/user");
	});

	it("produces accurate category counts in the report", () => {
		const session = makeSession([
			{
				role: "user",
				content: "Email a@b.com and phone 555-111-2222",
			},
		]);
		const { report } = sanitize(session);
		expect(report.categoryCounts.email).toBe(1);
		expect(report.categoryCounts.phone).toBe(1);
	});
});
