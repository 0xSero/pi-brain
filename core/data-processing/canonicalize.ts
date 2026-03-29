/**
 * @file core/data-processing/canonicalize.ts
 *
 * Responsibility: Validate and normalize raw plugin output into CanonicalSession.
 * This is the gateway between plugins and core — anything that doesn't conform
 * to CanonicalSession is rejected here.
 *
 * Invariants:
 * - Output is always a valid CanonicalSession or an error is thrown.
 * - Messages are sorted chronologically when timestamps are available.
 * - Empty sessions (no messages) are rejected.
 */

import type { CanonicalMessage, CanonicalSession } from "./types.js";

/**
 * Validate and normalize a session object.
 * Throws if the session is structurally invalid.
 */
export function canonicalize(raw: unknown): CanonicalSession {
	if (!raw || typeof raw !== "object") {
		throw new Error("canonicalize: input must be a non-null object");
	}

	const obj = raw as Record<string, unknown>;

	if (typeof obj.id !== "string" || obj.id.length === 0) {
		throw new Error("canonicalize: session must have a non-empty string id");
	}

	if (typeof obj.source !== "string" || obj.source.length === 0) {
		throw new Error("canonicalize: session must have a non-empty string source");
	}

	if (!Array.isArray(obj.messages) || obj.messages.length === 0) {
		throw new Error("canonicalize: session must have at least one message");
	}

	const messages: CanonicalMessage[] = obj.messages.map(validateMessage);

	// Sort by timestamp when available
	messages.sort((a, b) => {
		if (!a.timestamp && !b.timestamp) return 0;
		if (!a.timestamp) return -1;
		if (!b.timestamp) return 1;
		return a.timestamp.localeCompare(b.timestamp);
	});

	return {
		id: obj.id,
		source: obj.source,
		messages,
		projectPath: typeof obj.projectPath === "string" ? obj.projectPath : undefined,
		name: typeof obj.name === "string" ? obj.name : undefined,
		createdAt: typeof obj.createdAt === "string" ? obj.createdAt : undefined,
		metadata:
			obj.metadata && typeof obj.metadata === "object"
				? (obj.metadata as Record<string, unknown>)
				: undefined,
	};
}

const VALID_ROLES = new Set(["user", "assistant", "tool-result", "system"]);

function validateMessage(raw: unknown, index: number): CanonicalMessage {
	if (!raw || typeof raw !== "object") {
		throw new Error(`canonicalize: message at index ${index} must be a non-null object`);
	}

	const msg = raw as Record<string, unknown>;

	if (typeof msg.role !== "string" || !VALID_ROLES.has(msg.role)) {
		throw new Error(
			`canonicalize: message at index ${index} has invalid role "${msg.role}". ` +
				`Must be one of: ${[...VALID_ROLES].join(", ")}`,
		);
	}

	if (typeof msg.content !== "string") {
		throw new Error(`canonicalize: message at index ${index} must have string content`);
	}

	return {
		role: msg.role as CanonicalMessage["role"],
		content: msg.content,
		timestamp: typeof msg.timestamp === "string" ? msg.timestamp : undefined,
		model: typeof msg.model === "string" ? msg.model : undefined,
		toolName: typeof msg.toolName === "string" ? msg.toolName : undefined,
		toolCallId: typeof msg.toolCallId === "string" ? msg.toolCallId : undefined,
	};
}
