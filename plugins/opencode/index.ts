/**
 * @file plugins/opencode/index.ts
 *
 * OpenCode source plugin — reads JSON session/message/part files from
 * ~/.local/share/opencode/storage/ (Linux) or
 * ~/Library/Application Support/opencode/ (macOS)
 *
 * Structure: storage/session/global/<ses_id>.json for metadata,
 * storage/message/<ses_id>/msg_*.json for messages,
 * storage/part/<msg_id>/prt_*.json for message parts.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { CanonicalMessage, CanonicalSession, SourcePlugin } from "../../core/index.js";
import { dirExists, findExistingDirs, home } from "../helpers.js";

function getOpencodeDirs(): string[] {
	const h = home();
	return findExistingDirs([
		join(h, "Library", "Application Support", "opencode"),
		join(h, ".local", "share", "opencode"),
	]);
}

export const opencodePlugin: SourcePlugin = {
	name: "opencode",

	async listSessions(): Promise<string[]> {
		const refs: string[] = [];
		for (const dir of getOpencodeDirs()) {
			const msgDir = join(dir, "storage", "message");
			if (!dirExists(msgDir)) continue;
			try {
				const sessionDirs = readdirSync(msgDir, { withFileTypes: true });
				for (const d of sessionDirs) {
					if (d.isDirectory() && d.name.startsWith("ses_")) {
						refs.push(`${dir}:${d.name}`);
					}
				}
			} catch {
				// skip
			}
		}
		return refs;
	},

	async loadSession(ref: string): Promise<CanonicalSession> {
		// ref format: "<install_dir>:<ses_id>"
		const [installDir, sessionId] = ref.split(":");
		return loadOpencodeSession(installDir, sessionId);
	},
};

function loadOpencodeSession(installDir: string, sessionId: string): CanonicalSession {
	const msgDir = join(installDir, "storage", "message", sessionId);
	const partDir = join(installDir, "storage", "part");

	// Try to load session metadata
	let sessionMeta: any = {};
	const sessionFile = join(installDir, "storage", "session", "global", `${sessionId}.json`);
	if (existsSync(sessionFile)) {
		try {
			sessionMeta = JSON.parse(readFileSync(sessionFile, "utf-8"));
		} catch {
			// skip
		}
	}

	// Load messages
	const messages: CanonicalMessage[] = [];
	if (!dirExists(msgDir)) {
		throw new Error(`No message directory for OpenCode session: ${sessionId}`);
	}

	const msgFiles = readdirSync(msgDir)
		.filter((f) => f.startsWith("msg_") && f.endsWith(".json"))
		.sort();

	for (const msgFile of msgFiles) {
		try {
			const msgData = JSON.parse(readFileSync(join(msgDir, msgFile), "utf-8"));
			const messageId = msgData.id;
			const role = msgData.role === "user" ? "user" : "assistant";

			// Load parts for this message
			const parts: string[] = [];
			const msgPartDir = join(partDir, messageId);
			if (dirExists(msgPartDir)) {
				const partFiles = readdirSync(msgPartDir)
					.filter((f) => f.startsWith("prt_") && f.endsWith(".json"))
					.sort();
				for (const partFile of partFiles) {
					try {
						const partData = JSON.parse(readFileSync(join(msgPartDir, partFile), "utf-8"));
						if (partData.type === "text" && partData.text) {
							parts.push(partData.text);
						} else if (partData.type === "code" && partData.text) {
							const lang = partData.language ?? "";
							parts.push(`\`\`\`${lang}\n${partData.text}\n\`\`\``);
						}
					} catch {
						// skip malformed part
					}
				}
			}

			const content = parts.join("\n");
			if (content) {
				messages.push({
					role: role as CanonicalMessage["role"],
					content,
					timestamp: msgData.time?.created,
					model: msgData.modelID,
				});
			}
		} catch {
			// skip malformed message
		}
	}

	if (messages.length === 0) {
		throw new Error(`No messages found in OpenCode session: ${sessionId}`);
	}

	return {
		id: sessionId,
		source: "opencode",
		messages,
		projectPath: sessionMeta.directory,
		name: sessionMeta.title,
		createdAt: sessionMeta.time?.created,
		metadata: { installDir },
	};
}

export default opencodePlugin;
