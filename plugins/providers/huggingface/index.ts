/**
 * @file plugins/providers/huggingface/index.ts
 *
 * Hugging Face upload provider plugin.
 * Wraps the core uploader with HF-specific convenience:
 * token resolution from env, repo creation, visibility defaults.
 */

import type { HuggingFaceUploadConfig } from "../../../core/configs/types.js";
import type { ExportBundle } from "../../../core/data-processing/types.js";
import type { UploadResult } from "../../../core/uploads/types.js";
import { upload } from "../../../core/uploads/uploader.js";

/**
 * Upload a bundle to Hugging Face with sensible defaults.
 *
 * @param bundle - Export bundle to upload.
 * @param repo - HF dataset repo (e.g. "user/dataset-name").
 * @param options - Optional overrides for token and visibility.
 * @returns Upload result.
 */
export async function uploadToHuggingFace(
	bundle: ExportBundle,
	repo: string,
	options?: { token?: string; visibility?: "private" | "public" },
): Promise<UploadResult> {
	const config: HuggingFaceUploadConfig = {
		type: "huggingface",
		repo,
		token: options?.token,
		visibility: options?.visibility ?? "private",
	};

	return upload(bundle, config);
}

export { upload };
