import { env } from "cloudflare:workers";
import { runDurableObjectAlarm, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import worker from "../src/index.ts";

function buildMockEmail(params: {
	from: string;
	to: string;
	rawText: string;
	rawSizeOverride?: number;
}): {
	message: ForwardableEmailMessage;
	rejectedReason: () => string | null;
} {
	const bytes = new TextEncoder().encode(params.rawText);
	let rejected: string | null = null;
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(bytes);
			controller.close();
		},
	});

	const message = {
		from: params.from,
		to: params.to,
		headers: new Headers(),
		raw: stream,
		rawSize: params.rawSizeOverride ?? bytes.byteLength,
		setReject(reason: string) {
			rejected = reason;
		},
		async forward() {},
		async reply() {},
	} as unknown as ForwardableEmailMessage;

	return {
		message,
		rejectedReason: () => rejected,
	};
}

describe("Ton Mail Worker API & Email Handler", () => {
	it("returns public app configuration and health status", async () => {
		const cfgRes = await SELF.fetch("https://mail.ton.my.id/api/config");
		expect(cfgRes.status).toBe(200);
		const cfg = (await cfgRes.json()) as {
			appName: string;
			domains: string[];
			retentionHours: number;
		};
		expect(cfg.appName).toBe("Ton Mail");
		expect(cfg.domains).toEqual(["ton.my.id"]);
		expect(cfg.retentionHours).toBe(5);

		const healthRes = await SELF.fetch("https://mail.ton.my.id/api/health");
		expect(healthRes.status).toBe(200);
	});

	it("returns empty inbox without allocating SQLite tables for untouched addresses", async () => {
		const res = await SELF.fetch("https://mail.ton.my.id/api/inbox/kosong999/messages");
		expect(res.status).toBe(200);
		const body = (await res.json()) as { address: string; messages: unknown[] };
		expect(body.address).toBe("kosong999@ton.my.id");
		expect(body.messages).toEqual([]);

		const stub = env.MAILBOX.getByName("kosong999@ton.my.id");
		const tableCount = await runInDurableObject(stub, (_instance, state) => {
			return state.storage.sql
				.exec<{ cnt: number }>("SELECT COUNT(*) AS cnt FROM sqlite_master WHERE type = 'table'")
				.one().cnt;
		});
		expect(tableCount).toBe(0);
	});

	it("blocks reserved addresses like admin@ton.my.id on both API and inbound email", async () => {
		const apiRes = await SELF.fetch("https://mail.ton.my.id/api/inbox/admin/messages");
		expect(apiRes.status).toBe(403);

		const mock = buildMockEmail({
			from: "sender@example.com",
			to: "admin@ton.my.id",
			rawText: "From: sender@example.com\r\nTo: admin@ton.my.id\r\nSubject: Hi\r\n\r\nHello",
		});
		await worker.email(mock.message, env);
		expect(mock.rejectedReason()).toContain("dicadangkan");
	});

	it("rejects emails exceeding the 5 MB size limit", async () => {
		const mock = buildMockEmail({
			from: "sender@example.com",
			to: "besar@ton.my.id",
			rawText: "Subject: Big\r\n\r\nBody",
			rawSizeOverride: 6 * 1024 * 1024,
		});
		await worker.email(mock.message, env);
		expect(mock.rejectedReason()).toContain("5 MB");
	});

	it("ingests inbound MIME email, serves detail/raw/attachments, isolates inboxes, and deletes cleanly", async () => {
		const rawEmail = [
			"From: Bank Contoh <no-reply@bankcontoh.id>",
			"To: budi@ton.my.id",
			"Subject: Verifikasi Login",
			'Content-Type: multipart/mixed; boundary="BOUND"',
			"",
			"--BOUND",
			"Content-Type: text/html; charset=utf-8",
			"",
			'<p>Kode verifikasi Anda adalah <strong>849201</strong>.</p><img src="https://cdn.example.com/logo.png"><script>alert(1)</script>',
			"--BOUND",
			"Content-Type: text/html; charset=utf-8",
			'Content-Disposition: attachment; filename="laporan.html"',
			"",
			"<h1>Lampiran berbahaya jika inline</h1><script>alert(1)</script>",
			"--BOUND--",
		].join("\r\n");

		const mock = buildMockEmail({
			from: "no-reply@bankcontoh.id",
			to: "Budi@ton.my.id",
			rawText: rawEmail,
		});

		await worker.email(mock.message, env);
		expect(mock.rejectedReason()).toBeNull();

		// Inbox list for budi
		const listRes = await SELF.fetch("https://mail.ton.my.id/api/inbox/budi/messages");
		expect(listRes.status).toBe(200);
		const listData = (await listRes.json()) as {
			messages: Array<{
				id: string;
				subject: string;
				otpCode: string | null;
				hasExternalImages: boolean;
				attachmentCount: number;
			}>;
		};
		expect(listData.messages).toHaveLength(1);
		const msg = listData.messages[0];
		expect(msg.subject).toBe("Verifikasi Login");
		expect(msg.otpCode).toBe("849201");
		expect(msg.hasExternalImages).toBe(true);
		expect(msg.attachmentCount).toBe(1);

		// Different inbox stays completely isolated
		const otherRes = await SELF.fetch("https://mail.ton.my.id/api/inbox/andi/messages");
		const otherData = (await otherRes.json()) as { messages: unknown[] };
		expect(otherData.messages).toEqual([]);

		// Detail endpoint
		const detailRes = await SELF.fetch(`https://mail.ton.my.id/api/inbox/budi/messages/${msg.id}`);
		expect(detailRes.status).toBe(200);
		const detailData = (await detailRes.json()) as {
			message: {
				htmlBody: string;
				attachments: Array<{ id: string; filename: string; mimeType: string }>;
			};
		};
		expect(detailData.message.htmlBody).toContain("849201");
		expect(detailData.message.htmlBody).not.toContain("<script>");
		expect(detailData.message.attachments).toHaveLength(1);
		expect(detailData.message.attachments[0].filename).toBe("laporan.html");

		// Attachment download forces application/octet-stream for HTML attachments
		const attId = detailData.message.attachments[0].id;
		const attRes = await SELF.fetch(
			`https://mail.ton.my.id/api/inbox/budi/messages/${msg.id}/attachments/${attId}`,
		);
		expect(attRes.status).toBe(200);
		expect(attRes.headers.get("Content-Type")).toBe("application/octet-stream");
		expect(attRes.headers.get("Content-Disposition")).toContain("attachment");
		expect(attRes.headers.get("X-Content-Type-Options")).toBe("nosniff");
		expect(new TextDecoder().decode(await attRes.arrayBuffer())).toContain("Lampiran berbahaya");

		// Raw source endpoint
		const rawRes = await SELF.fetch(`https://mail.ton.my.id/api/inbox/budi/messages/${msg.id}/raw`);
		expect(rawRes.status).toBe(200);
		expect(rawRes.headers.get("Content-Type")).toContain("text/plain");
		expect(await rawRes.text()).toContain("Subject: Verifikasi Login");

		// Delete single message and confirm DO storage is cleaned up
		const delRes = await SELF.fetch(`https://mail.ton.my.id/api/inbox/budi/messages/${msg.id}`, {
			method: "DELETE",
		});
		expect(delRes.status).toBe(200);

		const afterRes = await SELF.fetch("https://mail.ton.my.id/api/inbox/budi/messages");
		const afterData = (await afterRes.json()) as { messages: unknown[] };
		expect(afterData.messages).toEqual([]);
	});

	it("automatically expires messages and cleans up storage when the Durable Object alarm fires", async () => {
		const stub = env.MAILBOX.getByName("alarmtest@ton.my.id");
		const now = Date.now();

		await stub.storeEmail(
			{
				id: "msgexpiring12345",
				fromAddress: "sender@example.com",
				fromName: "Sender",
				toAddress: "alarmtest@ton.my.id",
				subject: "Soon expired",
				snippet: "Hello",
				textBody: "Hello",
				htmlBody: "<p>Hello</p>",
				hasExternalImages: false,
				otpCode: null,
				sizeBytes: 120,
				receivedAt: now - 5 * 60 * 60 * 1000 - 10_000,
				expiresAt: now - 10_000,
				rawEml: new TextEncoder().encode("Subject: Soon expired\r\n\r\nHello"),
				attachments: [],
			},
			50,
		);

		const alarmRan = await runDurableObjectAlarm(stub);
		expect(alarmRan).toBe(true);

		const remaining = await stub.listMessages(now);
		expect(remaining).toEqual([]);

		// Verify alarm cleaned up storage tables via deleteAll()
		const tablesAfter = await runInDurableObject(stub, (_instance, state) => {
			return state.storage.sql
				.exec<{ cnt: number }>("SELECT COUNT(*) AS cnt FROM sqlite_master WHERE type = 'table'")
				.one().cnt;
		});
		expect(tablesAfter).toBe(0);
	});
});
