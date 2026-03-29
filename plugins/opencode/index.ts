/**
 * @file plugins/opencode/index.ts
 *
 * OpenCode source plugin — reads either the newer SQLite-backed
 * ~/.local/share/opencode/opencode.db layout or the legacy JSON
 * storage tree under ~/.local/share/opencode/storage/ (Linux) or
 * ~/Library/Application Support/opencode/ (macOS).
 *
 * Legacy JSON structure:
 *   - storage/session/global/<ses_id>.json for metadata
 *   - storage/message/<ses_id>/msg_*.json for messages
 *   - storage/part/<msg_id>/prt_*.json for message parts
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import type { SqlJsDatabase, SqlJsStatic } from "sql.js";
import type { CanonicalMessage, CanonicalSession, SourcePlugin } from "../../core/index.js";
import { dirExists, fileExists, findExistingDirs, home } from "../helpers.js";

type OpencodeStorageKind = "db" | "json";

interface OpencodeRef {
	readonly installDir: string;
	readonly sessionId: string;
	readonly storage: OpencodeStorageKind;
}

interface DbSessionRow {
	readonly id: string;
	readonly title?: string;
	readonly directory?: string;
	readonly time_created?: number;
}

interface DbMessageRow {
	readonly id: string;
	readonly time_created?: number;
	readonly data?: string;
}

const require = createRequire(import.meta.url);
let sqlJsPromise: Promise<SqlJsStatic> | undefined;

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
			refs.push(...(await getOpencodeSessionRefs(dir)));
		}
		return refs;
	},

	async loadSession(ref: string): Promise<CanonicalSession> {
		const parsed = parseRef(ref);
		return loadOpencodeSession(parsed.installDir, parsed.sessionId, parsed.storage);
	},
};

async function getOpencodeSessionRefs(installDir: string): Promise<string[]> {
	const refsBySessionId = new Map<string, string>();
	const dbPath = join(installDir, "opencode.db");
	if (fileExists(dbPath)) {
		try {
			const db = await openDatabase(dbPath);
			try {
				const rows = queryAll<DbSessionRow>(
					db,
					"SELECT id FROM session ORDER BY time_created ASC, id ASC",
				);
				for (const row of rows) {
					refsBySessionId.set(row.id, encodeRef(installDir, row.id, "db"));
				}
			} finally {
				db.close();
			}
		} catch {
			// Continue with legacy JSON layout below.
		}
	}

	const messageRoot = join(installDir, "storage", "message");
	if (!dirExists(messageRoot)) {
		return [...refsBySessionId.values()];
	}

	try {
		const sessionDirs = readdirSync(messageRoot, { withFileTypes: true });
		for (const entry of sessionDirs) {
			if (
				entry.isDirectory() &&
				entry.name.startsWith("ses_") &&
				!refsBySessionId.has(entry.name)
			) {
				refsBySessionId.set(entry.name, encodeRef(installDir, entry.name, "json"));
			}
		}
	} catch {
		// Skip unreadable directories.
	}

	return [...refsBySessionId.values()];
}

async function loadOpencodeSession(
	installDir: string,
	sessionId: string,
	storage: OpencodeStorageKind,
): Promise<CanonicalSession> {
	return storage === "db"
		? loadOpencodeDbSession(installDir, sessionId)
		: loadOpencodeJsonSession(installDir, sessionId);
}

async function loadOpencodeDbSession(
	installDir: string,
	sessionId: string,
): Promise<CanonicalSession> {
	const databasePath = join(installDir, "opencode.db");
	if (!fileExists(databasePath)) {
		throw new Error(`No OpenCode database found at ${databasePath}`);
	}

	const db = await openDatabase(databasePath);
	try {
		const session = queryOne<DbSessionRow>(
			db,
			["SELECT id, directory, title, time_created", "FROM session WHERE id = ?"].join(" "),
			[sessionId],
		);
		if (!session) {
			throw new Error(`OpenCode session not found in database: ${sessionId}`);
		}

		const messageRows = queryAll<DbMessageRow>(
			db,
			[
				"SELECT id, time_created, data FROM message",
				"WHERE session_id = ? ORDER BY time_created ASC, id ASC",
			].join(" "),
			[sessionId],
		);

		const messages: CanonicalMessage[] = [];
		let projectPath = session.directory;

		for (const messageRow of messageRows) {
			const messageData = parseJson<Record<string, any>>(messageRow.data);
			if (!messageData) continue;

			const role = normalizeRole(messageData.role);
			if (!role) continue;

			const partRows = queryAll<{ data?: string }>(
				db,
				[
					"SELECT data FROM part",
					"WHERE session_id = ? AND message_id = ? ORDER BY time_created ASC, id ASC",
				].join(" "),
				[sessionId, messageRow.id],
			);
			const partEntries = partRows
				.map((row) => parseJson<Record<string, any>>(row.data))
				.filter((entry): entry is Record<string, any> => entry !== null);

			const content = getMessageContent(partEntries);
			if (!content) continue;

			projectPath = projectPath ?? messageData.path?.cwd;
			const model =
				typeof messageData.modelID === "string"
					? messageData.modelID
					: typeof messageData.model?.modelID === "string"
						? messageData.model.modelID
						: undefined;

			messages.push({
				role,
				content,
				timestamp: toIsoString(messageData.time?.created ?? messageRow.time_created),
				model,
			});
		}

		if (messages.length === 0) {
			throw new Error(`No messages found in OpenCode session: ${sessionId}`);
		}

		return {
			id: sessionId,
			source: "opencode",
			messages,
			projectPath,
			name: session.title,
			createdAt: toIsoString(session.time_created),
			metadata: {
				installDir,
				storage: "db",
			},
		};
	} finally {
		db.close();
	}
}

function loadOpencodeJsonSession(installDir: string, sessionId: string): CanonicalSession {
	const msgDir = join(installDir, "storage", "message", sessionId);
	const partDir = join(installDir, "storage", "part");

	// Try to load session metadata
	let sessionMeta: Record<string, any> = {};
	const sessionFile = join(installDir, "storage", "session", "global", `${sessionId}.json`);
	if (existsSync(sessionFile)) {
		sessionMeta = parseJson<Record<string, any>>(readFileSync(sessionFile, "utf-8")) ?? {};
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
			const role = normalizeRole(msgData.role);
			if (!role) continue;

			// Load parts for this message.
			const msgPartDir = join(partDir, messageId);
			const partEntries = loadJsonPartEntries(msgPartDir);
			const content = getMessageContent(partEntries);
			if (content) {
				messages.push({
					role,
					content,
					timestamp: toIsoString(msgData.time?.created),
					model:
						typeof msgData.modelID === "string"
							? msgData.modelID
							: typeof msgData.model?.modelID === "string"
								? msgData.model.modelID
								: undefined,
				});
			}
		} catch {
			// Skip malformed message.
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
		createdAt: toIsoString(sessionMeta.time?.created),
		metadata: { installDir, storage: "json" },
	};
}

async function openDatabase(dbPath: string): Promise<SqlJsDatabase> {
	const SQL = await getSqlJs();
	return new SQL.Database(readFileSync(dbPath));
}

async function getSqlJs(): Promise<SqlJsStatic> {
	if (!sqlJsPromise) {
		sqlJsPromise = import("sql.js").then(async ({ default: initSqlJs }) =>
			initSqlJs({
				locateFile: () => require.resolve("sql.js/dist/sql-wasm.wasm"),
			}),
		);
	}
	return sqlJsPromise;
}

function queryAll<T extends object>(
	db: SqlJsDatabase,
	sql: string,
	params: ReadonlyArray<unknown> = [],
): T[] {
	const statement = db.prepare(sql);
	try {
		if (params.length > 0) {
			statement.bind([...params]);
		}

		const rows: T[] = [];
		while (statement.step()) {
			rows.push(statement.getAsObject() as T);
		}
		return rows;
	} finally {
		statement.free();
	}
}

function queryOne<T extends object>(
	db: SqlJsDatabase,
	sql: string,
	params: ReadonlyArray<unknown> = [],
): T | null {
	const [row] = queryAll<T>(db, sql, params);
	return row ?? null;
}

function loadJsonPartEntries(partDir: string): Record<string, any>[] {
	if (!dirExists(partDir)) return [];
	return readdirSync(partDir)
		.filter((fileName) => fileName.startsWith("prt_") && fileName.endsWith(".json"))
		.sort()
		.map((fileName) =>
			parseJson<Record<string, any>>(readFileSync(join(partDir, fileName), "utf-8")),
		)
		.filter((entry): entry is Record<string, any> => entry !== null);
}

function getMessageContent(partEntries: ReadonlyArray<Record<string, any>>): string {
	const parts: string[] = [];

	for (const part of partEntries) {
		if (part.type === "text" && typeof part.text === "string" && part.text.trim()) {
			parts.push(part.text);
		} else if (part.type === "code" && typeof part.text === "string" && part.text.trim()) {
			const language = typeof part.language === "string" ? part.language : "";
			parts.push(`\`\`\`${language}\n${part.text}\n\`\`\``);
		}
	}

	return parts.join("\n").trim();
}

function normalizeRole(role: unknown): CanonicalMessage["role"] | null {
	switch (role) {
		case "user":
			return "user";
		case "assistant":
			return "assistant";
		case "system":
			return "system";
		default:
			return null;
	}
}

function toIsoString(value: unknown): string | undefined {
	return typeof value === "number" && Number.isFinite(value)
		? new Date(value).toISOString()
		: undefined;
}

function parseJson<T>(raw: unknown): T | null {
	if (typeof raw !== "string" || raw.length === 0) return null;
	try {
		return JSON.parse(raw) as T;
	} catch {
		return null;
	}
}

function encodeRef(installDir: string, sessionId: string, storage: OpencodeStorageKind): string {
	return `${storage}:${installDir}:${sessionId}`;
}

function parseRef(ref: string): OpencodeRef {
	const firstSeparator = ref.indexOf(":");
	const lastSeparator = ref.lastIndexOf(":");

	if (firstSeparator > 0 && lastSeparator > firstSeparator) {
		const storage = ref.slice(0, firstSeparator);
		const installDir = ref.slice(firstSeparator + 1, lastSeparator);
		const sessionId = ref.slice(lastSeparator + 1);

		if ((storage === "db" || storage === "json") && installDir && sessionId) {
			return { installDir, sessionId, storage };
		}
	}

	if (lastSeparator > 0) {
		return {
			installDir: ref.slice(0, lastSeparator),
			sessionId: ref.slice(lastSeparator + 1),
			storage: "json",
		};
	}

	throw new Error(`Invalid OpenCode session ref: ${ref}`);
}

export default opencodePlugin;
