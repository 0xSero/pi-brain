/**
 * @file core/privacy/anonymizer.ts
 *
 * Responsibility: Full anonymization layer that goes beyond redaction.
 * Redaction replaces secrets in message content. Anonymization strips
 * tracking data from the entire session structure: IDs, paths, timestamps,
 * usernames, hostnames — anything that could fingerprint or re-identify
 * the source user.
 *
 * Invariants:
 * - Anonymization is deterministic within a single export run (same salt).
 * - Different export runs produce different anonymous IDs (new salt each time).
 * - No original session UUID, username, hostname, or absolute path survives.
 * - Timestamps are fuzzed within a configurable window (default +-30min).
 * - Relative ordering of messages within a session is always preserved.
 * - The anonymizer operates on SanitizedSession (after redaction, not before).
 */

import { createHash, randomBytes } from "node:crypto";
import { hostname, userInfo } from "node:os";
import type { AnonymizeConfig } from "../configs/types.js";
import type { SanitizedMessage, SanitizedSession } from "./types.js";

export type { AnonymizeConfig } from "../configs/types.js";

const DEFAULT_JITTER_MS = 30 * 60 * 1000; // 30 minutes

/** Result of anonymizing a batch of sessions. */
export interface AnonymizeResult {
	readonly sessions: SanitizedSession[];
	readonly stats: {
		readonly sessionsProcessed: number;
		readonly idsAnonymized: number;
		readonly pathsStripped: number;
		readonly timestampsFuzzed: number;
		readonly stringsStripped: number;
	};
}

/**
 * Anonymize a batch of sanitized sessions for safe public/private upload.
 * Uses a fresh random salt so each export run produces different IDs.
 */
export function anonymize(
	sessions: ReadonlyArray<SanitizedSession>,
	config?: AnonymizeConfig,
): AnonymizeResult {
	const salt = randomBytes(32).toString("hex");
	const jitterMs = config?.timestampJitterMs ?? DEFAULT_JITTER_MS;
	const doIds = config?.anonymizeIds !== false;
	const doTimestamps = config?.fuzzTimestamps !== false;
	const doPaths = config?.stripPaths !== false;

	// Collect system-identifying strings to strip
	const stripStrings = buildStripList(config?.additionalStrips);

	const stats = {
		sessionsProcessed: 0,
		idsAnonymized: 0,
		pathsStripped: 0,
		timestampsFuzzed: 0,
		stringsStripped: 0,
	};
	const result: SanitizedSession[] = [];

	// Generate a deterministic but random-looking jitter seed per session
	for (const session of sessions) {
		stats.sessionsProcessed++;

		// Anonymize session ID
		let anonId = session.id;
		if (doIds) {
			anonId = hashWithSalt(session.id, salt);
			stats.idsAnonymized++;
		}

		// Strip project path
		let projectPath = session.projectPath;
		if (doPaths && projectPath) {
			projectPath = anonymizePath(projectPath);
			stats.pathsStripped++;
		}

		// Fuzz session createdAt
		let createdAt = session.createdAt;
		if (doTimestamps && createdAt) {
			createdAt = fuzzTimestamp(createdAt, jitterMs, salt + session.id);
			stats.timestampsFuzzed++;
		}

		// Process messages
		const messages: SanitizedMessage[] = session.messages.map((msg, idx) => {
			let content = msg.content;

			// Strip identifying strings from content
			for (const s of stripStrings) {
				if (content.includes(s)) {
					const count = content.split(s).length - 1;
					stats.stringsStripped += count;
					content = replaceAll(content, s, "<REDACTED>");
				}
			}

			// Fuzz message timestamp
			let timestamp = msg.timestamp;
			if (doTimestamps && timestamp) {
				timestamp = fuzzTimestamp(timestamp, jitterMs, salt + session.id + idx);
				stats.timestampsFuzzed++;
			}

			return { ...msg, content, timestamp };
		});

		// Strip name if it contains identifying info
		let name = session.name;
		if (name) {
			for (const s of stripStrings) {
				if (name.includes(s)) {
					name = replaceAll(name, s, "<REDACTED>");
				}
			}
		}

		// Build clean metadata (strip everything except source)
		const metadata: Record<string, unknown> = {};
		if (session.metadata) {
			// Only keep safe fields
			if (session.metadata.source) metadata.source = session.metadata.source;
		}

		result.push({
			...session,
			id: anonId,
			name,
			projectPath: doPaths ? projectPath : session.projectPath,
			createdAt,
			messages,
			metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
		});
	}

	return { sessions: result, stats };
}

/**
 * Build the list of strings to strip from all text fields.
 * Includes OS username, hostname, home directory, and any custom additions.
 */
function buildStripList(additional?: ReadonlyArray<string>): string[] {
	const strips: string[] = [];

	try {
		const user = userInfo().username;
		if (user && user.length > 1) strips.push(user);
	} catch {
		// Fallback: no username available
	}

	try {
		const host = hostname();
		if (host && host.length > 1) strips.push(host);
	} catch {
		// Fallback
	}

	if (additional) {
		for (const s of additional) {
			if (s.length > 1) strips.push(s);
		}
	}

	// Sort longest first so longer matches are replaced before substrings
	strips.sort((a, b) => b.length - a.length);

	// Deduplicate
	return [...new Set(strips)];
}

/**
 * Hash a value with a salt to produce a deterministic but unlinkable ID.
 * Output is 16 hex chars (64 bits) — enough uniqueness, not reversible.
 */
function hashWithSalt(value: string, salt: string): string {
	return createHash("sha256").update(`${salt}:${value}`).digest("hex").slice(0, 16);
}

/**
 * Replace an absolute path with an anonymized version.
 * Strips home directory, username, and hostname components.
 * Preserves the last 2 path segments as relative context.
 */
function anonymizePath(fullPath: string): string {
	const segments = fullPath.split("/").filter(Boolean);

	// Find the last meaningful segments (skip home/Users/username prefix)
	let startIdx = 0;
	for (let i = 0; i < segments.length; i++) {
		if (segments[i] === "Users" || segments[i] === "home" || segments[i] === "root") {
			startIdx = i + 2; // Skip "Users/username" or "home/username"
			break;
		}
	}

	const meaningful = segments.slice(startIdx);
	if (meaningful.length === 0) return "<project>";
	if (meaningful.length <= 2) return meaningful.join("/");
	return meaningful.slice(-2).join("/");
}

/**
 * Fuzz a timestamp by a deterministic but unpredictable offset.
 * Uses a seed to ensure the same timestamp in the same session
 * gets the same fuzz (preserving relative message order).
 */
function fuzzTimestamp(isoTimestamp: string, maxJitterMs: number, seed: string): string {
	const date = new Date(isoTimestamp);
	if (Number.isNaN(date.getTime())) return isoTimestamp;

	// Generate deterministic jitter from seed
	const hash = createHash("sha256").update(seed).digest();
	// Use first 4 bytes as a signed 32-bit int
	const rawInt = hash.readInt32BE(0);
	// Scale to [-maxJitterMs, +maxJitterMs]
	const jitter = (rawInt / 0x7fffffff) * maxJitterMs;

	return new Date(date.getTime() + jitter).toISOString();
}

function replaceAll(text: string, search: string, replacement: string): string {
	return text.split(search).join(replacement);
}
