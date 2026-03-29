/**
 * @file core/data-processing/types.ts
 *
 * Responsibility: Canonical data types that every source plugin must produce.
 * The core never sees raw provider-specific formats — only CanonicalSession.
 *
 * Invariants:
 * - CanonicalSession is the single interchange format between plugins and core.
 * - Messages are ordered chronologically within a session.
 * - Every session has a unique id, a source tag, and at least one message.
 * - Roles are normalized to "user" | "assistant" | "tool-result" | "system".
 */

/** Normalized message role across all source formats. */
export type MessageRole = "user" | "assistant" | "tool-result" | "system";

/** A single message in canonical form. */
export interface CanonicalMessage {
	/** The role of the message author. */
	readonly role: MessageRole;
	/** The text content (may contain code, markdown, etc.). */
	readonly content: string;
	/** ISO-8601 timestamp, if available from the source. */
	readonly timestamp?: string;
	/** Model identifier used for this response, if known. */
	readonly model?: string;
	/** Tool name, only for tool-result messages. */
	readonly toolName?: string;
	/** Tool call ID linking result to a prior assistant tool_call. */
	readonly toolCallId?: string;
}

/** Tool call metadata embedded in an assistant message. */
export interface CanonicalToolCall {
	readonly id: string;
	readonly name: string;
	readonly arguments: Record<string, unknown>;
}

/** A complete session in canonical form. */
export interface CanonicalSession {
	/** Unique identifier for this session. */
	readonly id: string;
	/** Which source produced this session (e.g. "pi", "claude", "codex"). */
	readonly source: string;
	/** The ordered messages in this session. */
	readonly messages: ReadonlyArray<CanonicalMessage>;
	/** Working directory or project path, if known. */
	readonly projectPath?: string;
	/** Human-readable session name or title, if available. */
	readonly name?: string;
	/** ISO-8601 creation timestamp. */
	readonly createdAt?: string;
	/** Freeform metadata from the source plugin. */
	readonly metadata?: Readonly<Record<string, unknown>>;
}

/** A chunk of text with position tracking for the chunker. */
export interface TextChunk {
	/** Zero-based chunk index. */
	readonly index: number;
	/** The chunk text. */
	readonly text: string;
	/** Byte offset in the source text where this chunk starts. */
	readonly startOffset: number;
	/** Byte offset in the source text where this chunk ends (exclusive). */
	readonly endOffset: number;
	/** Approximate token count for this chunk. */
	readonly tokenCount: number;
}

/** An artifact produced by a formatter. */
export interface ExportArtifact {
	/** The format this artifact is in. */
	readonly format: string;
	/** File name (relative to export directory). */
	readonly fileName: string;
	/** The serialized content ready to write to disk. */
	readonly content: string;
}

/** A complete export bundle with manifest. */
export interface ExportBundle {
	/** The artifacts in this bundle. */
	readonly artifacts: ReadonlyArray<ExportArtifact>;
	/** SHA-256 hash of the concatenated artifact contents. */
	readonly manifestHash: string;
	/** ISO-8601 timestamp of bundle creation. */
	readonly createdAt: string;
	/** Metadata about the export. */
	readonly metadata: {
		readonly sessionCount: number;
		readonly messageCount: number;
		readonly formats: ReadonlyArray<string>;
		readonly source: string;
	};
}
