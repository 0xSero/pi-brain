/**
 * @file plugins/codex/index.ts
 *
 * Codex source plugin — reads JSONL rollout sessions from
 * ~/.codex/sessions/ (organized by date: YYYY/MM/DD/rollout-*.jsonl)
 *
 * Storage format: each line has a "type" field. "event_msg" entries
 * contain the actual messages with payload.type indicating the message kind.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { CanonicalMessage, CanonicalSession, SourcePlugin } from "../../core/index.js";
import {
	findExistingDirs,
	findFiles,
	home,
	parseJsonlString,
	sessionIdFromPath,
} from "../helpers.js";

function getCodexDirs(): string[] {
	const h = home();
	return findExistingDirs([join(h, ".codex"), join(h, ".codex-local")]);
}

export const codexPlugin: SourcePlugin = {
	name: "codex",

	async listSessions(): Promise<string[]> {
		const dirs = getCodexDirs();
		const files: string[] = [];
		for (const dir of dirs) {
			// Sessions organized by date or in projects dir
			files.push(...findFiles(join(dir, "sessions"), (name) => name.endsWith(".jsonl")));
			files.push(...findFiles(join(dir, "projects"), (name) => name.endsWith(".jsonl")));
		}
		return files;
	},

	async loadSession(ref: string): Promise<CanonicalSession> {
		const content = readFileSync(ref, "utf-8");
		const entries = parseJsonlString(content);
		return codexEntriesToCanonical(entries, ref);
	},
};

function codexEntriesToCanonical(entries: unknown[], filePath: string): CanonicalSession {
	const messages: CanonicalMessage[] = [];
	let sessionId: string | undefined;
	let cwd: string | undefined;

	for (const entry of entries) {
		const e = entry as Record<string, any>;

		if (e.type === "session_meta") {
			const payload = e.payload ?? {};
			sessionId = payload.id;
			cwd = payload.cwd;
			continue;
		}

		if (e.type !== "event_msg") continue;

		const payload = e.payload ?? {};
		const payloadType = payload.type;

		if (payloadType === "user_message") {
			const text = (payload.message ?? "").trim();
			if (text) {
				messages.push({
					role: "user",
					content: text,
					timestamp: e.timestamp,
				});
			}
		} else if (payloadType === "agent_message") {
			const text = (payload.message ?? "").trim();
			if (text) {
				messages.push({
					role: "assistant",
					content: text,
					timestamp: e.timestamp,
					model: payload.model,
				});
			}
		} else if (payloadType === "tool_result") {
			messages.push({
				role: "tool-result",
				content:
					typeof payload.output === "string"
						? payload.output
						: JSON.stringify(payload.output ?? ""),
				timestamp: e.timestamp,
				toolName: payload.tool,
			});
		}
	}

	if (messages.length === 0) {
		throw new Error(`No messages found in Codex session: ${filePath}`);
	}

	return {
		id: sessionId ?? sessionIdFromPath(filePath),
		source: "codex",
		messages,
		projectPath: cwd,
		metadata: { sessionFile: filePath },
	};
}

export default codexPlugin;
