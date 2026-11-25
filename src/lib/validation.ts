import type { AppConfig } from "./config.ts";

const LOCAL_PART_RE = /^[a-z0-9](?:[a-z0-9._+-]{0,62}[a-z0-9])?$|^[a-z0-9]$/;
const MESSAGE_ID_RE = /^[a-zA-Z0-9_-]{8,64}$/;

export type AddressValidationResult =
	| {
			ok: true;
			username: string;
			domain: string;
			address: string;
	  }
	| {
			ok: false;
			status: 400 | 403;
			code: "INVALID_USERNAME" | "INVALID_DOMAIN" | "RESERVED_USERNAME";
			error: string;
	  };

export function normalizeUsername(raw: string): string {
	const trimmed = raw.trim().toLowerCase();
	const atIndex = trimmed.indexOf("@");
	return atIndex >= 0 ? trimmed.slice(0, atIndex) : trimmed;
}

export function validateInboxAddress(
	rawUsername: string,
	rawDomain: string | null | undefined,
	config: AppConfig,
): AddressValidationResult {
	let username = rawUsername.trim().toLowerCase();
	let domain = (rawDomain ?? "").trim().toLowerCase();

	if (username.includes("@")) {
		const [local, maybeDomain] = username.split("@", 2);
		username = local;
		if (!domain && maybeDomain) {
			domain = maybeDomain;
		}
	}

	if (!domain) {
		domain = config.defaultDomain;
	}

	if (!config.domains.includes(domain)) {
		return {
			ok: false,
			status: 400,
			code: "INVALID_DOMAIN",
			error: `Domain "${domain}" tidak didukung.`,
		};
	}

	if (!username || username.length > 64) {
		return {
			ok: false,
			status: 400,
			code: "INVALID_USERNAME",
			error: "Username harus berisi 1 hingga 64 karakter.",
		};
	}

	if (!LOCAL_PART_RE.test(username) || username.includes("..")) {
		return {
			ok: false,
			status: 400,
			code: "INVALID_USERNAME",
			error:
				"Username hanya boleh berisi huruf, angka, titik (.), garis bawah (_), tanda hubung (-), atau plus (+), serta tidak boleh diawali/diakhiri simbol atau memiliki titik ganda.",
		};
	}

	if (config.reservedUsernames.has(username)) {
		return {
			ok: false,
			status: 403,
			code: "RESERVED_USERNAME",
			error: `Alamat ${username}@${domain} dicadangkan dan tidak dapat digunakan sebagai inbox publik.`,
		};
	}

	return {
		ok: true,
		username,
		domain,
		address: `${username}@${domain}`,
	};
}

export function parseEnvelopeAddress(
	envelopeTo: string,
	config: AppConfig,
): AddressValidationResult {
	const cleaned = envelopeTo.trim().replace(/^<|>$/g, "").toLowerCase();
	const atIndex = cleaned.lastIndexOf("@");
	if (atIndex <= 0 || atIndex === cleaned.length - 1) {
		return {
			ok: false,
			status: 400,
			code: "INVALID_USERNAME",
			error: "Alamat penerima tidak valid.",
		};
	}
	const local = cleaned.slice(0, atIndex);
	const domain = cleaned.slice(atIndex + 1);
	return validateInboxAddress(local, domain, config);
}

export function isValidId(id: string): boolean {
	return MESSAGE_ID_RE.test(id);
}

export function sanitizeDownloadFilename(filename: string | null | undefined): string {
	const fallback = "lampiran.bin";
	if (!filename) return fallback;
	const cleaned = filename
		.replace(/[\r\n\t\0/\\:*?"<>|]+/g, "_")
		.replace(/^\.+/, "")
		.trim()
		.slice(0, 120);
	return cleaned || fallback;
}
