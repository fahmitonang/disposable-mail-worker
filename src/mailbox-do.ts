import { DurableObject } from "cloudflare:workers";
import type { ParsedEmailPayload } from "./lib/mime.ts";

export interface MessageSummary {
	id: string;
	fromAddress: string;
	fromName: string;
	toAddress: string;
	subject: string;
	snippet: string;
	hasExternalImages: boolean;
	otpCode: string | null;
	sizeBytes: number;
	receivedAt: number;
	expiresAt: number;
	attachmentCount: number;
}

export interface AttachmentMeta {
	id: string;
	filename: string;
	mimeType: string;
	sizeBytes: number;
}

export interface MessageDetail extends Omit<MessageSummary, "attachmentCount"> {
	textBody: string;
	htmlBody: string;
	attachments: AttachmentMeta[];
}

export interface AttachmentPayload {
	filename: string;
	mimeType: string;
	sizeBytes: number;
	content: ArrayBuffer;
}

export interface RawMessagePayload {
	subject: string;
	receivedAt: number;
	rawEml: ArrayBuffer;
}

type MessageSummaryRow = {
	id: string;
	from_address: string;
	from_name: string;
	to_address: string;
	subject: string;
	snippet: string;
	has_external_images: number;
	otp_code: string | null;
	size_bytes: number;
	received_at: number;
	expires_at: number;
	attachment_count: number;
};

type MessageDetailRow = Omit<MessageSummaryRow, "attachment_count"> & {
	text_body: string;
	html_body: string;
};

type AttachmentMetaRow = {
	id: string;
	filename: string;
	mime_type: string;
	size_bytes: number;
};

type AttachmentContentRow = {
	filename: string;
	mime_type: string;
	size_bytes: number;
	content: ArrayBuffer;
};

type RawRow = {
	subject: string;
	received_at: number;
	raw_eml: ArrayBuffer;
};

function toExactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
	const copy = new Uint8Array(bytes.byteLength);
	copy.set(bytes);
	return copy.buffer;
}

export class MailboxDO extends DurableObject<Env> {
	private schemaReady = false;

	private hasSchema(): boolean {
		if (this.schemaReady) return true;
		const rows = this.ctx.storage.sql
			.exec<{ name: string }>(
				"SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'messages'",
			)
			.toArray();
		if (rows.length > 0) {
			this.schemaReady = true;
			return true;
		}
		return false;
	}

	private ensureSchema(): void {
		if (this.schemaReady) return;
		this.ctx.storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS messages (
				id TEXT PRIMARY KEY,
				from_address TEXT NOT NULL,
				from_name TEXT NOT NULL,
				to_address TEXT NOT NULL,
				subject TEXT NOT NULL,
				snippet TEXT NOT NULL,
				text_body TEXT NOT NULL,
				html_body TEXT NOT NULL,
				has_external_images INTEGER NOT NULL DEFAULT 0,
				otp_code TEXT,
				size_bytes INTEGER NOT NULL,
				received_at INTEGER NOT NULL,
				expires_at INTEGER NOT NULL
			);
			CREATE INDEX IF NOT EXISTS idx_messages_received_at ON messages (received_at DESC);
			CREATE INDEX IF NOT EXISTS idx_messages_expires_at ON messages (expires_at ASC);

			CREATE TABLE IF NOT EXISTS message_raw (
				message_id TEXT PRIMARY KEY,
				raw_eml BLOB NOT NULL
			);

			CREATE TABLE IF NOT EXISTS attachments (
				id TEXT PRIMARY KEY,
				message_id TEXT NOT NULL,
				filename TEXT NOT NULL,
				mime_type TEXT NOT NULL,
				disposition TEXT NOT NULL,
				content_id TEXT,
				size_bytes INTEGER NOT NULL,
				content BLOB NOT NULL
			);
			CREATE INDEX IF NOT EXISTS idx_attachments_message_id ON attachments (message_id);
		`);
		this.schemaReady = true;
	}

	private deleteExpiredSync(now: number): number {
		const expiredIds = this.ctx.storage.sql
			.exec<{ id: string }>("SELECT id FROM messages WHERE expires_at <= ?", now)
			.toArray();

		for (const row of expiredIds) {
			this.ctx.storage.sql.exec("DELETE FROM attachments WHERE message_id = ?", row.id);
			this.ctx.storage.sql.exec("DELETE FROM message_raw WHERE message_id = ?", row.id);
			this.ctx.storage.sql.exec("DELETE FROM messages WHERE id = ?", row.id);
		}
		return expiredIds.length;
	}

	private getNextExpirySync(): number | null {
		const row = this.ctx.storage.sql
			.exec<{ next_exp: number | null }>("SELECT MIN(expires_at) AS next_exp FROM messages")
			.one();
		return row.next_exp;
	}

	private async syncAlarmOrCleanup(): Promise<void> {
		if (!this.hasSchema()) return;
		const nextExp = this.getNextExpirySync();
		if (nextExp === null) {
			await this.ctx.storage.deleteAll();
			this.schemaReady = false;
			return;
		}
		const target = Math.max(nextExp, Date.now() + 1000);
		await this.ctx.storage.setAlarm(target);
	}

	async storeEmail(payload: ParsedEmailPayload, maxMessages: number): Promise<{ id: string }> {
		const now = Date.now();
		const cap = Math.max(1, maxMessages);

		const nextExp = this.ctx.storage.transactionSync(() => {
			this.ensureSchema();
			this.deleteExpiredSync(now);

			this.ctx.storage.sql.exec(
				`INSERT INTO messages (
					id, from_address, from_name, to_address, subject, snippet,
					text_body, html_body, has_external_images, otp_code,
					size_bytes, received_at, expires_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				payload.id,
				payload.fromAddress,
				payload.fromName,
				payload.toAddress,
				payload.subject,
				payload.snippet,
				payload.textBody,
				payload.htmlBody,
				payload.hasExternalImages ? 1 : 0,
				payload.otpCode,
				payload.sizeBytes,
				payload.receivedAt,
				payload.expiresAt,
			);

			this.ctx.storage.sql.exec(
				"INSERT INTO message_raw (message_id, raw_eml) VALUES (?, ?)",
				payload.id,
				toExactArrayBuffer(payload.rawEml),
			);

			for (const att of payload.attachments) {
				this.ctx.storage.sql.exec(
					`INSERT INTO attachments (
						id, message_id, filename, mime_type, disposition, content_id, size_bytes, content
					) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
					att.id,
					payload.id,
					att.filename,
					att.mimeType,
					att.disposition,
					att.contentId,
					att.sizeBytes,
					toExactArrayBuffer(att.content),
				);
			}

			// Enforce per-inbox message cap by evicting oldest messages
			const overflow = this.ctx.storage.sql
				.exec<{ id: string }>(
					"SELECT id FROM messages ORDER BY received_at DESC, rowid DESC LIMIT -1 OFFSET ?",
					cap,
				)
				.toArray();

			for (const old of overflow) {
				this.ctx.storage.sql.exec("DELETE FROM attachments WHERE message_id = ?", old.id);
				this.ctx.storage.sql.exec("DELETE FROM message_raw WHERE message_id = ?", old.id);
				this.ctx.storage.sql.exec("DELETE FROM messages WHERE id = ?", old.id);
			}

			return this.getNextExpirySync();
		});

		if (nextExp !== null) {
			await this.ctx.storage.setAlarm(Math.max(nextExp, Date.now() + 1000));
		}

		return { id: payload.id };
	}

	async listMessages(now: number = Date.now()): Promise<MessageSummary[]> {
		if (!this.hasSchema()) return [];

		const rows = this.ctx.storage.sql
			.exec<MessageSummaryRow>(
				`SELECT
					m.id,
					m.from_address,
					m.from_name,
					m.to_address,
					m.subject,
					m.snippet,
					m.has_external_images,
					m.otp_code,
					m.size_bytes,
					m.received_at,
					m.expires_at,
					(SELECT COUNT(*) FROM attachments a WHERE a.message_id = m.id) AS attachment_count
				FROM messages m
				WHERE m.expires_at > ?
				ORDER BY m.received_at DESC, m.rowid DESC`,
				now,
			)
			.toArray();

		return rows.map((row) => ({
			id: row.id,
			fromAddress: row.from_address,
			fromName: row.from_name,
			toAddress: row.to_address,
			subject: row.subject,
			snippet: row.snippet,
			hasExternalImages: row.has_external_images === 1,
			otpCode: row.otp_code,
			sizeBytes: row.size_bytes,
			receivedAt: row.received_at,
			expiresAt: row.expires_at,
			attachmentCount: row.attachment_count,
		}));
	}

	async getMessage(id: string, now: number = Date.now()): Promise<MessageDetail | null> {
		if (!this.hasSchema()) return null;

		const rows = this.ctx.storage.sql
			.exec<MessageDetailRow>(
				`SELECT
					id, from_address, from_name, to_address, subject, snippet,
					text_body, html_body, has_external_images, otp_code,
					size_bytes, received_at, expires_at
				FROM messages
				WHERE id = ? AND expires_at > ?`,
				id,
				now,
			)
			.toArray();

		const row = rows[0];
		if (!row) return null;

		const attachments = this.ctx.storage.sql
			.exec<AttachmentMetaRow>(
				`SELECT id, filename, mime_type, size_bytes
				FROM attachments
				WHERE message_id = ?
				ORDER BY rowid ASC`,
				id,
			)
			.toArray()
			.map((att) => ({
				id: att.id,
				filename: att.filename,
				mimeType: att.mime_type,
				sizeBytes: att.size_bytes,
			}));

		return {
			id: row.id,
			fromAddress: row.from_address,
			fromName: row.from_name,
			toAddress: row.to_address,
			subject: row.subject,
			snippet: row.snippet,
			textBody: row.text_body,
			htmlBody: row.html_body,
			hasExternalImages: row.has_external_images === 1,
			otpCode: row.otp_code,
			sizeBytes: row.size_bytes,
			receivedAt: row.received_at,
			expiresAt: row.expires_at,
			attachments,
		};
	}

	async getRawMessage(id: string, now: number = Date.now()): Promise<RawMessagePayload | null> {
		if (!this.hasSchema()) return null;

		const rows = this.ctx.storage.sql
			.exec<RawRow>(
				`SELECT m.subject, m.received_at, r.raw_eml
				FROM messages m
				JOIN message_raw r ON r.message_id = m.id
				WHERE m.id = ? AND m.expires_at > ?`,
				id,
				now,
			)
			.toArray();

		const row = rows[0];
		if (!row) return null;

		return {
			subject: row.subject,
			receivedAt: row.received_at,
			rawEml: row.raw_eml,
		};
	}

	async getAttachment(
		messageId: string,
		attachmentId: string,
		now: number = Date.now(),
	): Promise<AttachmentPayload | null> {
		if (!this.hasSchema()) return null;

		const rows = this.ctx.storage.sql
			.exec<AttachmentContentRow>(
				`SELECT a.filename, a.mime_type, a.size_bytes, a.content
				FROM attachments a
				JOIN messages m ON m.id = a.message_id
				WHERE a.message_id = ? AND a.id = ? AND m.expires_at > ?`,
				messageId,
				attachmentId,
				now,
			)
			.toArray();

		const row = rows[0];
		if (!row) return null;

		return {
			filename: row.filename,
			mimeType: row.mime_type,
			sizeBytes: row.size_bytes,
			content: row.content,
		};
	}

	async deleteMessage(id: string): Promise<boolean> {
		if (!this.hasSchema()) return false;

		const deleted = this.ctx.storage.transactionSync(() => {
			const existing = this.ctx.storage.sql
				.exec<{ id: string }>("SELECT id FROM messages WHERE id = ?", id)
				.toArray();
			if (existing.length === 0) return false;

			this.ctx.storage.sql.exec("DELETE FROM attachments WHERE message_id = ?", id);
			this.ctx.storage.sql.exec("DELETE FROM message_raw WHERE message_id = ?", id);
			this.ctx.storage.sql.exec("DELETE FROM messages WHERE id = ?", id);
			return true;
		});

		if (deleted) {
			await this.syncAlarmOrCleanup();
		}

		return deleted;
	}

	async clearAll(): Promise<number> {
		if (!this.hasSchema()) return 0;

		const count = this.ctx.storage.sql
			.exec<{ total: number }>("SELECT COUNT(*) AS total FROM messages")
			.one().total;

		await this.ctx.storage.deleteAll();
		this.schemaReady = false;
		return count;
	}

	async alarm(): Promise<void> {
		if (!this.hasSchema()) return;

		const now = Date.now();
		this.ctx.storage.transactionSync(() => {
			this.deleteExpiredSync(now);
		});

		await this.syncAlarmOrCleanup();
	}
}
