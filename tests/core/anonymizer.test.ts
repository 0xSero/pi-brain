import { hostname, userInfo } from "node:os";
import { describe, expect, it } from "vitest";
import { anonymize } from "../../core/privacy/anonymizer.js";
import type { SanitizedSession } from "../../core/privacy/types.js";

const systemUsername = (() => {
	try {
		return userInfo().username;
	} catch {
		return "local-user";
	}
})();

const systemHostname = (() => {
	try {
		return hostname();
	} catch {
		return "local-host";
	}
})();

const makeSession = (): SanitizedSession => ({
	id: "session-real-id-123",
	source: "claude",
	name: `Debugging on ${systemUsername}@${systemHostname}`,
	projectPath: "/Users/sero/project/src",
	createdAt: "2026-01-02T03:04:05.000Z",
	metadata: {
		source: "claude",
		projectId: "proj-123",
		host: "workstation",
		tokenCount: 42,
	},
	messages: [
		{
			role: "system",
			content: `System prepared on ${systemHostname} for ${systemUsername}.`,
			timestamp: "2026-01-02T03:05:00.000Z",
		},
		{
			role: "user",
			content: `Please inspect /Users/${systemUsername}/project/src on ${systemHostname} for ${systemUsername}.`,
			timestamp: "2026-01-02T03:06:00.000Z",
		},
		{
			role: "assistant",
			content: `I found an issue near /Users/${systemUsername}/project/src/index.ts for ${systemUsername}.`,
			timestamp: "2026-01-02T03:07:00.000Z",
			model: "gpt-test",
		},
	],
});

describe("anonymize", () => {
	it("anonymizes session IDs and keeps them deterministic within one call", () => {
		const session = makeSession();
		const duplicate = { ...makeSession(), name: "Duplicate entry" };

		const { sessions, stats } = anonymize([session, duplicate]);

		expect(sessions[0].id).not.toBe(session.id);
		expect(sessions[1].id).not.toBe(duplicate.id);
		expect(sessions[0].id).toBe(sessions[1].id);
		expect(stats.idsAnonymized).toBe(2);
	});

	it("strips project paths to a safe relative tail", () => {
		const session = makeSession();

		const { sessions, stats } = anonymize([session]);

		expect(sessions[0].projectPath).toBe("project/src");
		expect(sessions[0].projectPath).not.toContain("/Users/");
		expect(sessions[0].projectPath).not.toContain("sero");
		expect(stats.pathsStripped).toBe(1);
	});

	it("strips usernames and hostnames from message content and session name", () => {
		const session = makeSession();

		const { sessions, stats } = anonymize([session]);
		const [result] = sessions;

		expect(result.name).not.toContain(systemUsername);
		expect(result.name).not.toContain(systemHostname);
		for (const message of result.messages) {
			expect(message.content).not.toContain(systemUsername);
			expect(message.content).not.toContain(systemHostname);
			expect(message.content).toContain("<REDACTED>");
		}
		expect(stats.stringsStripped).toBeGreaterThanOrEqual(5);
	});

	it("fuzzes timestamps while keeping valid ISO strings", () => {
		const session = makeSession();

		const { sessions, stats } = anonymize([session], { timestampJitterMs: 60_000 });
		const [result] = sessions;

		expect(result.createdAt).not.toBe(session.createdAt);
		expect(new Date(result.createdAt ?? "").toISOString()).toBe(result.createdAt);
		for (const [index, message] of result.messages.entries()) {
			expect(message.timestamp).not.toBe(session.messages[index].timestamp);
			expect(new Date(message.timestamp ?? "").toISOString()).toBe(message.timestamp);
		}
		expect(stats.timestampsFuzzed).toBe(4);
	});

	it("preserves message ordering after timestamp fuzzing", () => {
		const session = makeSession();
		const originalRoles = session.messages.map((message) => message.role);

		const { sessions } = anonymize([session], { timestampJitterMs: 60_000 });

		expect(sessions[0].messages.map((message) => message.role)).toEqual(originalRoles);
	});

	it("strips metadata down to safe fields only", () => {
		const session = makeSession();

		const { sessions } = anonymize([session]);

		expect(sessions[0].metadata).toEqual({ source: "claude" });
	});

	it("supports additional strip strings", () => {
		const session = {
			...makeSession(),
			name: "Private org acme-internal",
			messages: [
				...makeSession().messages,
				{
					role: "user" as const,
					content: "Escalate this to acme-internal immediately.",
					timestamp: "2026-01-02T03:08:00.000Z",
				},
			],
		};

		const { sessions } = anonymize([session], {
			additionalStrips: ["acme-internal"],
		});

		expect(sessions[0].name).not.toContain("acme-internal");
		expect(sessions[0].messages[3].content).toBe("Escalate this to <REDACTED> immediately.");
	});

	it("respects config flags that disable anonymization behaviors", () => {
		const session = makeSession();

		const { sessions, stats } = anonymize([session], {
			anonymizeIds: false,
			fuzzTimestamps: false,
			stripPaths: false,
		});
		const [result] = sessions;

		expect(result.id).toBe(session.id);
		expect(result.createdAt).toBe(session.createdAt);
		expect(result.projectPath).toBe(session.projectPath);
		expect(result.messages.map((message) => message.timestamp)).toEqual(
			session.messages.map((message) => message.timestamp),
		);
		expect(stats.idsAnonymized).toBe(0);
		expect(stats.pathsStripped).toBe(0);
		expect(stats.timestampsFuzzed).toBe(0);
	});
});
