import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { hermesPlugin } from "../../plugins/hermes/index.js";

describe("hermesPlugin", () => {
	let tempHome: string;
	let previousHome: string | undefined;

	beforeEach(() => {
		previousHome = process.env.HOME;
		tempHome = mkdtempSync(join(tmpdir(), "pi-brain-hermes-"));
		process.env.HOME = tempHome;

		const hermesDir = join(tempHome, ".hermes");
		mkdirSync(hermesDir, { recursive: true });
		const dbPath = join(hermesDir, "state.db");

		execFileSync("sqlite3", [dbPath, SCHEMA_SQL], { encoding: "utf-8" });
		execFileSync("sqlite3", [dbPath, FIXTURE_SQL], { encoding: "utf-8" });
	});

	afterEach(() => {
		if (previousHome === undefined) {
			process.env.HOME = undefined;
		} else {
			process.env.HOME = previousHome;
		}
		rmSync(tempHome, { recursive: true, force: true });
	});

	it("lists Hermes sessions from the local sqlite database", async () => {
		const sessions = await hermesPlugin.listSessions();
		expect(sessions).toEqual(["sess-1"]);
	});

	it("loads Hermes sessions and maps tool results", async () => {
		const session = await hermesPlugin.loadSession("sess-1");

		expect(session.id).toBe("sess-1");
		expect(session.source).toBe("hermes");
		expect(session.name).toBe("Fixture Hermes Session");
		expect(session.createdAt).toBe("2026-03-03T12:13:11.000Z");
		expect(session.messages).toEqual([
			{
				role: "user",
				content: "Hello Hermes",
				timestamp: "2026-03-03T12:13:12.000Z",
			},
			{
				role: "assistant",
				content: "Let me check that for you.",
				timestamp: "2026-03-03T12:13:13.000Z",
				model: "glm-5",
			},
			{
				role: "tool-result",
				content: "tool output",
				timestamp: "2026-03-03T12:13:14.000Z",
				toolCallId: "call-1",
				toolName: "terminal",
			},
			{
				role: "assistant",
				content: "Done.",
				timestamp: "2026-03-03T12:13:15.000Z",
				model: "glm-5",
			},
		]);
	});
});

const SCHEMA_SQL = `
CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    user_id TEXT,
    model TEXT,
    model_config TEXT,
    system_prompt TEXT,
    parent_session_id TEXT,
    started_at REAL NOT NULL,
    ended_at REAL,
    end_reason TEXT,
    message_count INTEGER DEFAULT 0,
    tool_call_count INTEGER DEFAULT 0,
    input_tokens INTEGER DEFAULT 0,
    output_tokens INTEGER DEFAULT 0,
    title TEXT
);
CREATE TABLE messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    role TEXT NOT NULL,
    content TEXT,
    tool_call_id TEXT,
    tool_calls TEXT,
    tool_name TEXT,
    timestamp REAL NOT NULL,
    token_count INTEGER,
    finish_reason TEXT
);
`;

const FIXTURE_SQL = `
INSERT INTO sessions (
    id, source, user_id, model, started_at, message_count, tool_call_count,
    input_tokens, output_tokens, title
) VALUES (
    'sess-1', 'cli', 'user-1', 'glm-5', 1772539991, 4, 1, 10, 20, 'Fixture Hermes Session'
);

INSERT INTO messages (
    session_id, role, content, tool_call_id, tool_calls, tool_name, timestamp, token_count, finish_reason
) VALUES
    ('sess-1', 'user', 'Hello Hermes', NULL, NULL, NULL, 1772539992, NULL, NULL),
    (
        'sess-1',
        'assistant',
        'Let me check that for you.',
        NULL,
        '[{"id":"call-1","call_id":"call-1","type":"function","function":{"name":"terminal","arguments":"{\\"command\\":\\"pwd\\"}"}}]',
        NULL,
        1772539993,
        NULL,
        'tool_calls'
    ),
    ('sess-1', 'tool', '{"output":"tool output"}', 'call-1', NULL, NULL, 1772539994, NULL, NULL),
    ('sess-1', 'assistant', 'Done.', NULL, NULL, NULL, 1772539995, NULL, 'stop');
`;
