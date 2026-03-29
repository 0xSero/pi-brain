/**
 * @file core/uploads/types.ts
 *
 * Responsibility: Type definitions for upload targets.
 * Describes the contract that every upload target must satisfy, and the
 * result shape returned after a successful (or failed) upload.
 *
 * Invariants:
 * - UploadResult always includes success/failure status and a human message.
 * - The upload function receives a fully formed ExportBundle, never raw sessions.
 * - Credentials are resolved at call time, never stored in the result.
 */

import type { UploadConfig } from "../configs/types.js";
import type { ExportBundle } from "../data-processing/types.js";

/** Result of an upload attempt. */
export interface UploadResult {
	/** Whether the upload succeeded. */
	readonly success: boolean;
	/** Human-readable status message. */
	readonly message: string;
	/** The target type that was used. */
	readonly targetType: "huggingface" | "http";
	/** URL where the uploaded data can be accessed (if applicable). */
	readonly url?: string;
	/** Timestamp of the upload attempt. */
	readonly timestamp: string;
}

/** Contract for an upload target implementation. */
export interface UploadTarget {
	/** Upload a bundle to the target. */
	upload(bundle: ExportBundle, config: UploadConfig): Promise<UploadResult>;
}
