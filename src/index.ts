import { getAppConfig } from "./lib/config.ts";
import { EmailTooLargeError, parseIncomingEmail, readStreamWithLimit } from "./lib/mime.ts";
import {
	isValidId,
	parseEnvelopeAddress,
	sanitizeDownloadFilename,
	validateInboxAddress,
} from "./lib/validation.ts";

export { MailboxDO } from "./mailbox-do.ts";

const UNSAFE_INLINE_MIME_RE =
	/(?:^text\/html\b|^application\/xhtml|^image\/svg|^text\/xml\b|^application\/xml\b|javascript|ecmascript)/i;

function jsonResponse(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: {
			"Content-Type": "application/json; charset=utf-8",
			"Cache-Control": "no-store",
			"X-Content-Type-Options": "nosniff",
			"Referrer-Policy": "no-referrer",
		},
	});
}

function decodeSegment(segment: string): string | null {
	try {
		return decodeURIComponent(segment);
	} catch {
		return null;
	}
}

function buildContentDisposition(filename: string): string {
	const ascii = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
	const encoded = encodeURIComponent(filename);
	return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

async function handleApiRequest(request: Request, env: Env): Promise<Response> {
	const url = new URL(request.url);
	const config = getAppConfig(env);
	const method = request.method.toUpperCase();

	if (url.pathname === "/api/config") {
		if (method !== "GET") {
			return jsonResponse({ error: "Metode tidak diizinkan." }, 405);
		}
		return jsonResponse({
			appName: config.appName,
			domains: config.domains,
			defaultDomain: config.defaultDomain,
			siteUrl: config.siteUrl,
			declineUrl: config.declineUrl,
			retentionHours: config.retentionHours,
			maxEmailBytes: config.maxEmailBytes,
			maxMessagesPerInbox: config.maxMessagesPerInbox,
		});
	}

	if (url.pathname === "/api/health") {
		if (method !== "GET") {
			return jsonResponse({ error: "Metode tidak diizinkan." }, 405);
		}
		return jsonResponse({ ok: true, domain: config.defaultDomain, time: Date.now() });
	}

	const segments = url.pathname.split("/").filter(Boolean);
	// Expected routes:
	// /api/inbox/:username/messages
	// /api/inbox/:username/messages/:id
	// /api/inbox/:username/messages/:id/raw
	// /api/inbox/:username/messages/:id/attachments/:attId
	if (segments[0] !== "api" || segments[1] !== "inbox" || segments.length < 4) {
		return jsonResponse({ error: "Endpoint tidak ditemukan." }, 404);
	}

	const rawUsername = decodeSegment(segments[2]);
	if (!rawUsername) {
		return jsonResponse({ error: "Username tidak valid." }, 400);
	}

	const domainParam = url.searchParams.get("domain");
	const validated = validateInboxAddress(rawUsername, domainParam, config);
	if (!validated.ok) {
		return jsonResponse({ error: validated.error, code: validated.code }, validated.status);
	}

	const stub = env.MAILBOX.getByName(validated.address);

	// /api/inbox/:username/messages
	if (segments.length === 4 && segments[3] === "messages") {
		if (method === "GET") {
			const messages = await stub.listMessages();
			return jsonResponse({
				address: validated.address,
				username: validated.username,
				domain: validated.domain,
				retentionHours: config.retentionHours,
				serverTime: Date.now(),
				messages,
			});
		}
		if (method === "DELETE") {
			const deletedCount = await stub.clearAll();
			return jsonResponse({ deleted: true, deletedCount });
		}
		return jsonResponse({ error: "Metode tidak diizinkan." }, 405);
	}

	// /api/inbox/:username/messages/:id
	if (segments.length === 5 && segments[3] === "messages") {
		const messageId = decodeSegment(segments[4]);
		if (!messageId || !isValidId(messageId)) {
			return jsonResponse({ error: "ID email tidak valid." }, 400);
		}

		if (method === "GET") {
			const message = await stub.getMessage(messageId);
			if (!message) {
				return jsonResponse({ error: "Email tidak ditemukan atau sudah terhapus." }, 404);
			}
			return jsonResponse({ message, serverTime: Date.now() });
		}

		if (method === "DELETE") {
			const deleted = await stub.deleteMessage(messageId);
			if (!deleted) {
				return jsonResponse({ error: "Email tidak ditemukan atau sudah terhapus." }, 404);
			}
			return jsonResponse({ deleted: true });
		}

		return jsonResponse({ error: "Metode tidak diizinkan." }, 405);
	}

	// /api/inbox/:username/messages/:id/raw
	if (segments.length === 6 && segments[3] === "messages" && segments[5] === "raw") {
		if (method !== "GET") {
			return jsonResponse({ error: "Metode tidak diizinkan." }, 405);
		}
		const messageId = decodeSegment(segments[4]);
		if (!messageId || !isValidId(messageId)) {
			return jsonResponse({ error: "ID email tidak valid." }, 400);
		}

		const raw = await stub.getRawMessage(messageId);
		if (!raw) {
			return jsonResponse({ error: "Email tidak ditemukan atau sudah terhapus." }, 404);
		}

		const download = url.searchParams.get("download") === "1";
		const headers = new Headers({
			"Content-Type": download ? "message/rfc822" : "text/plain; charset=utf-8",
			"Cache-Control": "no-store",
			"X-Content-Type-Options": "nosniff",
			"Referrer-Policy": "no-referrer",
		});

		if (download) {
			const safeFile = sanitizeDownloadFilename(`email-${messageId.slice(0, 12)}.eml`);
			headers.set("Content-Disposition", buildContentDisposition(safeFile));
		}

		return new Response(raw.rawEml, { status: 200, headers });
	}

	// /api/inbox/:username/messages/:id/attachments/:attId
	if (segments.length === 7 && segments[3] === "messages" && segments[5] === "attachments") {
		if (method !== "GET") {
			return jsonResponse({ error: "Metode tidak diizinkan." }, 405);
		}
		const messageId = decodeSegment(segments[4]);
		const attachmentId = decodeSegment(segments[6]);
		if (!messageId || !isValidId(messageId) || !attachmentId || !isValidId(attachmentId)) {
			return jsonResponse({ error: "ID lampiran tidak valid." }, 400);
		}

		const attachment = await stub.getAttachment(messageId, attachmentId);
		if (!attachment) {
			return jsonResponse({ error: "Lampiran tidak ditemukan atau sudah terhapus." }, 404);
		}

		const safeMime = UNSAFE_INLINE_MIME_RE.test(attachment.mimeType)
			? "application/octet-stream"
			: attachment.mimeType || "application/octet-stream";

		return new Response(attachment.content, {
			status: 200,
			headers: {
				"Content-Type": safeMime,
				"Content-Disposition": buildContentDisposition(attachment.filename),
				"Content-Length": String(attachment.sizeBytes),
				"Cache-Control": "no-store",
				"X-Content-Type-Options": "nosniff",
				"Referrer-Policy": "no-referrer",
			},
		});
	}

	return jsonResponse({ error: "Endpoint tidak ditemukan." }, 404);
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);
		try {
			if (url.pathname.startsWith("/api/")) {
				return await handleApiRequest(request, env);
			}
			return new Response("Not Found", { status: 404 });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			console.error(
				JSON.stringify({
					event: "http_error",
					method: request.method,
					path: url.pathname,
					error: message,
				}),
			);
			return jsonResponse({ error: "Terjadi kesalahan pada server." }, 500);
		}
	},

	async email(message: ForwardableEmailMessage, env: Env): Promise<void> {
		const config = getAppConfig(env);
		const recipientCheck = parseEnvelopeAddress(message.to, config);

		if (!recipientCheck.ok) {
			console.log(
				JSON.stringify({
					event: "email_rejected",
					reason: recipientCheck.code,
					toDomain: message.to.split("@")[1] ?? "unknown",
				}),
			);
			message.setReject(recipientCheck.error);
			return;
		}

		if (message.rawSize > config.maxEmailBytes) {
			console.log(
				JSON.stringify({
					event: "email_rejected",
					reason: "SIZE_LIMIT_EXCEEDED",
					rawSize: message.rawSize,
					maxEmailBytes: config.maxEmailBytes,
				}),
			);
			message.setReject(
				`Email melebihi batas maksimal ${Math.round(config.maxEmailBytes / (1024 * 1024))} MB.`,
			);
			return;
		}

		try {
			const rawBytes = await readStreamWithLimit(message.raw, config.maxEmailBytes);
			const parsed = await parseIncomingEmail({
				rawBytes,
				envelopeFrom: message.from,
				envelopeTo: recipientCheck.address,
				retentionMs: config.retentionMs,
			});

			const stub = env.MAILBOX.getByName(recipientCheck.address);
			await stub.storeEmail(parsed, config.maxMessagesPerInbox);

			console.log(
				JSON.stringify({
					event: "email_stored",
					messageId: parsed.id,
					domain: recipientCheck.domain,
					sizeBytes: parsed.sizeBytes,
					attachments: parsed.attachments.length,
					hasOtp: parsed.otpCode !== null,
				}),
			);
		} catch (error) {
			if (error instanceof EmailTooLargeError) {
				message.setReject(error.message);
				return;
			}
			const errMsg = error instanceof Error ? error.message : String(error);
			console.error(
				JSON.stringify({
					event: "email_ingest_error",
					domain: recipientCheck.domain,
					error: errMsg,
				}),
			);
			message.setReject("Gagal memproses email masuk.");
		}
	},
} satisfies ExportedHandler<Env>;
