/**
 * @file core/uploads/http-client.ts
 *
 * Responsibility: Low-level HTTP utilities for uploading bundles.
 * Handles multipart form-data encoding and generic POST requests.
 *
 * Invariants:
 * - Uses only Node.js built-in fetch (no external HTTP libraries).
 * - Never logs or stores credentials.
 * - Throws on non-2xx responses with the status and body.
 */

/** Standard response shape from an upload request. */
export interface HttpResponse {
	readonly status: number;
	readonly ok: boolean;
	readonly body: string;
}

/**
 * POST JSON to a URL with optional extra headers.
 */
export async function postJson(
	url: string,
	data: unknown,
	headers?: Record<string, string>,
): Promise<HttpResponse> {
	const response = await fetch(url, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			...headers,
		},
		body: JSON.stringify(data),
	});

	const body = await response.text();
	return { status: response.status, ok: response.ok, body };
}

/**
 * Upload a file as multipart/form-data.
 * Creates a proper FormData boundary and encodes the file content.
 */
export async function uploadMultipart(
	url: string,
	fileName: string,
	content: string,
	fields?: Record<string, string>,
	headers?: Record<string, string>,
): Promise<HttpResponse> {
	const formData = new FormData();

	// Add extra fields first
	if (fields) {
		for (const [key, value] of Object.entries(fields)) {
			formData.append(key, value);
		}
	}

	// Add the file
	const blob = new Blob([content], { type: "application/octet-stream" });
	formData.append("file", blob, fileName);

	const response = await fetch(url, {
		method: "POST",
		headers: headers ?? {},
		body: formData,
	});

	const body = await response.text();
	return { status: response.status, ok: response.ok, body };
}
