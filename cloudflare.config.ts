import { bindings, defineConfig, defineWorker, exports } from "cf/config";
import * as entrypoint from "./src/index.ts" with { type: "cf-worker" };

const mailboxWorker = defineWorker({
	name: "ton-mail-worker",
	compatibilityDate: "2026-11-23",
	compatibilityFlags: ["nodejs_compat"],
	entrypoint,
	exports: {
		MailboxDO: exports.durableObject({ storage: "sqlite" }),
	},
});

export default defineConfig({
	worker: {
		...mailboxWorker,
		domains: ["mail.ton.my.id"],
		assets: {
			notFoundHandling: "single-page-application",
			runWorkerFirst: ["/api/*"],
		},
		env: {
			MAILBOX: bindings.durableObject({
				worker: mailboxWorker,
				exportName: "MailboxDO",
			}),
			EMAIL_DOMAIN: bindings.text("ton.my.id"),
			EMAIL_DOMAINS: bindings.text("ton.my.id"),
			APP_NAME: bindings.text("Ton Mail"),
			SITE_URL: bindings.text("https://mail.ton.my.id"),
			DECLINE_URL: bindings.text("https://ton.my.id/"),
			RETENTION_HOURS: bindings.text("5"),
			MAX_EMAIL_BYTES: bindings.text("5242880"),
			MAX_MESSAGES_PER_INBOX: bindings.text("50"),
			RESERVED_USERNAMES: bindings.text(
				"admin,administrator,postmaster,abuse,hostmaster,webmaster,root,security,mailer-daemon,noreply,no-reply",
			),
		},
		observability: {
			enabled: true,
			logs: {
				enabled: true,
				headSamplingRate: 1,
			},
			traces: {
				enabled: true,
				headSamplingRate: 0.1,
			},
		},
	},
});
