import { describe, expect, it } from "vite-plus/test";
import { getAppConfig } from "../src/lib/config.ts";
import { EmailTooLargeError, parseIncomingEmail, readStreamWithLimit } from "../src/lib/mime.ts";
import { extractOtpCode } from "../src/lib/otp.ts";
import { renderPlainTextToHtml, sanitizeEmailHtml } from "../src/lib/sanitize.ts";
import { parseEnvelopeAddress, validateInboxAddress } from "../src/lib/validation.ts";

describe("Address validation", () => {
	const config = getAppConfig({});

	it("normalizes valid usernames and accepts full email paste", () => {
		const res1 = validateInboxAddress("  Budi.Santoso_1  ", "ton.my.id", config);
		expect(res1).toEqual({
			ok: true,
			username: "budi.santoso_1",
			domain: "ton.my.id",
			address: "budi.santoso_1@ton.my.id",
		});

		const res2 = validateInboxAddress("Kopi+Test@TON.MY.ID", null, config);
		expect(res2).toEqual({
			ok: true,
			username: "kopi+test",
			domain: "ton.my.id",
			address: "kopi+test@ton.my.id",
		});
	});

	it("rejects reserved usernames such as admin", () => {
		const res = validateInboxAddress("admin", "ton.my.id", config);
		expect(res.ok).toBe(false);
		if (!res.ok) {
			expect(res.status).toBe(403);
			expect(res.code).toBe("RESERVED_USERNAME");
		}
	});

	it("rejects invalid syntax and unsupported domains", () => {
		const badDot = validateInboxAddress("foo..bar", "ton.my.id", config);
		expect(badDot.ok).toBe(false);

		const badStart = validateInboxAddress(".hidden", "ton.my.id", config);
		expect(badStart.ok).toBe(false);

		const badDomain = validateInboxAddress("budi", "example.com", config);
		expect(badDomain.ok).toBe(false);
		if (!badDomain.ok) {
			expect(badDomain.code).toBe("INVALID_DOMAIN");
		}
	});

	it("parses SMTP envelope recipient addresses", () => {
		const res = parseEnvelopeAddress("<User123@ton.my.id>", config);
		expect(res).toEqual({
			ok: true,
			username: "user123",
			domain: "ton.my.id",
			address: "user123@ton.my.id",
		});
	});
});

describe("OTP code extraction", () => {
	it("extracts Indonesian verification codes", () => {
		expect(
			extractOtpCode(
				"Kode Verifikasi Akun",
				"Halo, kode verifikasi Anda adalah: 482910. Berlaku 5 menit.",
				"",
			),
		).toBe("482910");

		expect(extractOtpCode("Konfirmasi", "918273 adalah kode OTP Anda. Jangan bagikan.", "")).toBe(
			"918273",
		);
	});

	it("extracts English verification codes including hyphenated and HTML-only emails", () => {
		expect(extractOtpCode("Sign-in", "", "<p>Your verification code is <b>739-102</b>.</p>")).toBe(
			"739-102",
		);

		expect(extractOtpCode("Your login code: 551904", "Welcome!", "")).toBe("551904");
	});

	it("avoids false positives on years, dates, and URLs", () => {
		expect(
			extractOtpCode(
				"Newsletter 2026",
				"Kunjungi https://example.com/order/987654 pada 2026-11-25 pukul 14:30.",
				"",
			),
		).toBeNull();
	});
});

describe("HTML sanitization and plain text rendering", () => {
	it("strips scripts, iframes, inline event handlers, and javascript URLs", () => {
		const dirty = `
			<div onclick="alert(1)">
				<script>alert('xss')</script>
				<iframe src="https://evil.test"></iframe>
				<a href="javascript:alert(1)">Bad link</a>
				<a href="https://ton.my.id">Good link</a>
				<img src="https://tracker.test/pixel.png" onerror="alert(2)">
			</div>
		`;
		const res = sanitizeEmailHtml(dirty);
		expect(res.hasExternalImages).toBe(true);
		expect(res.html).not.toContain("<script");
		expect(res.html).not.toContain("<iframe");
		expect(res.html).not.toContain("onclick");
		expect(res.html).not.toContain("onerror");
		expect(res.html).not.toContain("javascript:");
		expect(res.html).toContain('href="https://ton.my.id"');
		expect(res.html).toContain('target="_blank"');
		expect(res.html).toContain('rel="noopener noreferrer"');
	});

	it("detects external CSS background images and allows inline data images", () => {
		const res = sanitizeEmailHtml(
			`<style>body { background: url(https://cdn.test/bg.jpg); }</style><img src="data:image/png;base64,iVBORw0KGgo=">`,
		);
		expect(res.hasExternalImages).toBe(true);
		expect(res.html).toContain("data:image/png;base64,iVBORw0KGgo=");
	});

	it("escapes and linkifies plain text safely", () => {
		const html = renderPlainTextToHtml("Halo <script> lihat https://ton.my.id/test.");
		expect(html).not.toContain("<script>");
		expect(html).toContain("&lt;script&gt;");
		expect(html).toContain(
			'<a href="https://ton.my.id/test" target="_blank" rel="noopener noreferrer">https://ton.my.id/test</a>.',
		);
	});
});

describe("MIME parsing and stream size cap", () => {
	it("rejects streams exceeding maxBytes", async () => {
		const bigChunk = new Uint8Array(2048);
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(bigChunk);
				controller.close();
			},
		});
		await expect(readStreamWithLimit(stream, 1024)).rejects.toThrow(EmailTooLargeError);
	});

	it("inlines cid raster images and extracts downloadable attachments", async () => {
		const rawMime = [
			"From: Layanan <noreply@contoh.id>",
			"To: budi@ton.my.id",
			"Subject: Kode OTP Anda",
			'Content-Type: multipart/mixed; boundary="MIX"',
			"",
			"--MIX",
			'Content-Type: multipart/related; boundary="REL"',
			"",
			"--REL",
			"Content-Type: text/html; charset=utf-8",
			"",
			'<p>Kode verifikasi Anda: <b>654321</b></p><img src="cid:logo123@contoh.id">',
			"--REL",
			"Content-Type: image/png",
			"Content-Transfer-Encoding: base64",
			"Content-Disposition: inline; filename=logo.png",
			"Content-ID: <logo123@contoh.id>",
			"",
			"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
			"--REL--",
			"--MIX",
			"Content-Type: text/plain; charset=utf-8",
			'Content-Disposition: attachment; filename="catatan.txt"',
			"",
			"Isi lampiran teks.",
			"--MIX--",
		].join("\r\n");

		const parsed = await parseIncomingEmail({
			rawBytes: new TextEncoder().encode(rawMime),
			envelopeFrom: "noreply@contoh.id",
			envelopeTo: "budi@ton.my.id",
			retentionMs: 5 * 60 * 60 * 1000,
			now: 1_700_000_000_000,
		});

		expect(parsed.subject).toBe("Kode OTP Anda");
		expect(parsed.fromName).toBe("Layanan");
		expect(parsed.fromAddress).toBe("noreply@contoh.id");
		expect(parsed.otpCode).toBe("654321");
		expect(parsed.htmlBody).toContain("data:image/png;base64,");
		expect(parsed.hasExternalImages).toBe(false);
		expect(parsed.attachments).toHaveLength(1);
		expect(parsed.attachments[0].filename).toBe("catatan.txt");
		expect(new TextDecoder().decode(parsed.attachments[0].content)).toBe("Isi lampiran teks.");
	});
});
