import PostalMime from "postal-mime";
import { extractOtpCode } from "./otp.ts";
import { renderPlainTextToHtml, sanitizeEmailHtml } from "./sanitize.ts";
import { sanitizeDownloadFilename } from "./validation.ts";

const INLINE_IMAGE_MIMES = new Set([
	"image/png",
	"image/jpeg",
	"image/jpg",
	"image/gif",
	"image/webp",
]);

const MAX_INLINE_IMAGE_BYTES = 512 * 1024; // 512 KB max to inline as data URI

export interface ParsedAttachmentInput {
	id: string;
	filename: string;
	mimeType: string;
	disposition: string;
	contentId: string | null;
	sizeBytes: number;
	content: Uint8Array;
}

export interface ParsedEmailPayload {
	id: string;
	fromAddress: string;
	fromName: string;
	toAddress: string;
	subject: string;
	snippet: string;
	textBody: string;
	htmlBody: string;
	hasExternalImages: boolean;
	otpCode: string | null;
	sizeBytes: number;
	receivedAt: number;
	expiresAt: number;
	rawEml: Uint8Array;
	attachments: ParsedAttachmentInput[];
}

export class EmailTooLargeError extends Error {
	constructor(maxBytes: number) {
		super(`Email melebihi batas maksimal ${Math.round(maxBytes / (1024 * 1024))} MB.`);
		this.name = "EmailTooLargeError";
	}
}

export async function readStreamWithLimit(
	stream: ReadableStream<Uint8Array>,
	maxBytes: number,
): Promise<Uint8Array> {
	const reader = stream.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;

	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			if (!value || value.byteLength === 0) continue;
			total += value.byteLength;
			if (total > maxBytes) {
				await reader.cancel();
				throw new EmailTooLargeError(maxBytes);
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}

	const combined = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		combined.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return combined;
}

function uint8ToBase64(bytes: Uint8Array): string {
	let binary = "";
	const chunkSize = 0x8000;
	for (let i = 0; i < bytes.length; i += chunkSize) {
		const slice = bytes.subarray(i, i + chunkSize);
		binary += String.fromCharCode(...slice);
	}
	return btoa(binary);
}

function toUint8Array(content: string | ArrayBuffer | Uint8Array): Uint8Array {
	if (content instanceof Uint8Array) return content;
	if (content instanceof ArrayBuffer) return new Uint8Array(content);
	return new TextEncoder().encode(content);
}

function normalizeContentId(cid: string | undefined): string | null {
	if (!cid) return null;
	const cleaned = cid.trim().replace(/^<|>$/g, "").toLowerCase();
	return cleaned || null;
}

function buildSnippet(textBody: string, htmlBody: string): string {
	const source =
		textBody.trim() ||
		htmlBody
			.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
			.replace(/<[^>]+>/g, " ")
			.replace(/&nbsp;/gi, " ")
			.replace(/&amp;/gi, "&")
			.replace(/&lt;/gi, "<")
			.replace(/&gt;/gi, ">");
	return source.replace(/\s+/g, " ").trim().slice(0, 160);
}

export async function parseIncomingEmail(params: {
	rawBytes: Uint8Array;
	envelopeFrom: string;
	envelopeTo: string;
	retentionMs: number;
	now?: number;
}): Promise<ParsedEmailPayload> {
	const receivedAt = params.now ?? Date.now();
	const expiresAt = receivedAt + params.retentionMs;

	const parsed = await PostalMime.parse(params.rawBytes);

	const fromAddress = (parsed.from?.address || params.envelopeFrom || "unknown").trim();
	const fromName = (parsed.from?.name || "").trim();
	const subject = (parsed.subject || "").trim() || "(Tanpa subjek)";
	const textBody = parsed.text ?? "";

	const cidMap = new Map<string, string>();
	const attachments: ParsedAttachmentInput[] = [];

	for (const att of parsed.attachments ?? []) {
		const content = toUint8Array(att.content);
		const mimeType = (att.mimeType || "application/octet-stream").toLowerCase().trim();
		const disposition = (att.disposition || "attachment").toLowerCase().trim();
		const contentId = normalizeContentId(att.contentId);
		const filename = sanitizeDownloadFilename(att.filename);

		let inlined = false;
		if (
			contentId &&
			INLINE_IMAGE_MIMES.has(mimeType) &&
			content.byteLength > 0 &&
			content.byteLength <= MAX_INLINE_IMAGE_BYTES
		) {
			cidMap.set(contentId, `data:${mimeType};base64,${uint8ToBase64(content)}`);
			if (disposition === "inline") {
				inlined = true;
			}
		}

		// Store all non-inline attachments (and oversized/non-image inline ones) for download
		if (!inlined) {
			attachments.push({
				id: crypto.randomUUID().replace(/-/g, ""),
				filename,
				mimeType,
				disposition,
				contentId,
				sizeBytes: content.byteLength,
				content,
			});
		}
	}

	let rawHtml = parsed.html ?? "";
	if (rawHtml && cidMap.size > 0) {
		rawHtml = rawHtml.replace(
			/\bsrc\s*=\s*(["'])cid:([^"']+)\1/gi,
			(full, quote: string, cidRef: string) => {
				const normalized = cidRef.trim().replace(/^<|>$/g, "").toLowerCase();
				const dataUri = cidMap.get(normalized);
				return dataUri ? `src=${quote}${dataUri}${quote}` : full;
			},
		);
	}

	let htmlBody = "";
	let hasExternalImages = false;
	if (rawHtml.trim()) {
		const sanitized = sanitizeEmailHtml(rawHtml);
		htmlBody = sanitized.html;
		hasExternalImages = sanitized.hasExternalImages;
	} else if (textBody.trim()) {
		htmlBody = renderPlainTextToHtml(textBody);
	}

	const otpCode = extractOtpCode(subject, textBody, parsed.html ?? "");
	const snippet = buildSnippet(textBody, parsed.html ?? "");

	return {
		id: crypto.randomUUID().replace(/-/g, ""),
		fromAddress,
		fromName,
		toAddress: params.envelopeTo,
		subject,
		snippet,
		textBody,
		htmlBody,
		hasExternalImages,
		otpCode,
		sizeBytes: params.rawBytes.byteLength,
		receivedAt,
		expiresAt,
		rawEml: params.rawBytes,
		attachments,
	};
}
