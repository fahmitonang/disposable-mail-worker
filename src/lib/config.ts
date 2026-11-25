export interface AppConfig {
	appName: string;
	domains: string[];
	defaultDomain: string;
	siteUrl: string;
	declineUrl: string;
	retentionHours: number;
	retentionMs: number;
	maxEmailBytes: number;
	maxMessagesPerInbox: number;
	reservedUsernames: Set<string>;
}

const DEFAULT_DOMAINS = ["ton.my.id"];
const DEFAULT_RETENTION_HOURS = 5;
const DEFAULT_MAX_EMAIL_BYTES = 5 * 1024 * 1024; // 5 MB
const DEFAULT_MAX_MESSAGES_PER_INBOX = 50;
const DEFAULT_RESERVED = [
	"admin",
	"administrator",
	"postmaster",
	"abuse",
	"hostmaster",
	"webmaster",
	"root",
	"security",
	"mailer-daemon",
	"noreply",
	"no-reply",
];

function parsePositiveInt(value: string | undefined, fallback: number): number {
	if (!value) return fallback;
	const parsed = Number.parseInt(value, 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseList(value: string | undefined, fallback: string[]): string[] {
	if (!value) return fallback;
	const items = value
		.split(",")
		.map((part) => part.trim().toLowerCase())
		.filter(Boolean);
	return items.length > 0 ? items : fallback;
}

export function getAppConfig(env: Partial<Env>): AppConfig {
	const domains = parseList(env.EMAIL_DOMAINS ?? env.EMAIL_DOMAIN, DEFAULT_DOMAINS);
	const retentionHours = parsePositiveInt(env.RETENTION_HOURS, DEFAULT_RETENTION_HOURS);
	const maxEmailBytes = parsePositiveInt(env.MAX_EMAIL_BYTES, DEFAULT_MAX_EMAIL_BYTES);
	const maxMessagesPerInbox = parsePositiveInt(
		env.MAX_MESSAGES_PER_INBOX,
		DEFAULT_MAX_MESSAGES_PER_INBOX,
	);
	const reservedList = parseList(env.RESERVED_USERNAMES, DEFAULT_RESERVED);

	return {
		appName: env.APP_NAME?.trim() || "Ton Mail",
		domains,
		defaultDomain: domains[0],
		siteUrl: env.SITE_URL?.trim() || "https://mail.ton.my.id",
		declineUrl: env.DECLINE_URL?.trim() || "https://ton.my.id/",
		retentionHours,
		retentionMs: retentionHours * 60 * 60 * 1000,
		maxEmailBytes,
		maxMessagesPerInbox,
		reservedUsernames: new Set(reservedList),
	};
}
