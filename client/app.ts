interface AppConfigResponse {
	appName: string;
	domains: string[];
	defaultDomain: string;
	siteUrl: string;
	declineUrl: string;
	retentionHours: number;
	maxEmailBytes: number;
}

interface MessageSummary {
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

interface AttachmentMeta {
	id: string;
	filename: string;
	mimeType: string;
	sizeBytes: number;
}

interface MessageDetail extends Omit<MessageSummary, "attachmentCount"> {
	textBody: string;
	htmlBody: string;
	attachments: AttachmentMeta[];
}

interface MessagesListResponse {
	address: string;
	username: string;
	domain: string;
	retentionHours: number;
	serverTime: number;
	messages: MessageSummary[];
}

const STORAGE_CONSENT = "tonmail_consent_v1";
const STORAGE_RECENT = "tonmail_recent_v1";
const STORAGE_AUTO_ENABLED = "tonmail_auto_enabled_v1";
const STORAGE_AUTO_INTERVAL = "tonmail_auto_interval_v1";
const STORAGE_READ_IDS = "tonmail_read_ids_v1";

const USERNAME_RE = /^[a-z0-9](?:[a-z0-9._+-]{0,62}[a-z0-9])?$|^[a-z0-9]$/;

const WORDS_A = [
	"awan",
	"senja",
	"kopi",
	"angin",
	"hujan",
	"bintang",
	"ombak",
	"embun",
	"pelangi",
	"langit",
	"kertas",
	"lampu",
	"surya",
	"pantai",
	"daun",
	"bulan",
	"mega",
	"taman",
	"sungai",
	"rimba",
];

const WORDS_B = [
	"biru",
	"pagi",
	"tenang",
	"cerah",
	"cepat",
	"manis",
	"segar",
	"ramah",
	"kilat",
	"kecil",
	"hangat",
	"jernih",
	"teduh",
	"damai",
	"lincah",
	"murni",
];

function $<T extends HTMLElement>(id: string): T {
	const el = document.getElementById(id);
	if (!el) throw new Error(`Element #${id} tidak ditemukan`);
	return el as T;
}

const els = {
	consentAgree: $<HTMLButtonElement>("consent-agree"),
	consentDecline: $<HTMLAnchorElement>("consent-decline"),
	consentLimits: $<HTMLParagraphElement>("consent-limits"),
	brandName: $<HTMLSpanElement>("brand-name"),
	openForm: $<HTMLFormElement>("open-form"),
	nameInput: $<HTMLInputElement>("name-input"),
	domainSelect: $<HTMLSelectElement>("domain-select"),
	randomBtn: $<HTMLButtonElement>("random-btn"),
	formError: $<HTMLParagraphElement>("form-error"),
	recentWrap: $<HTMLDivElement>("recent"),
	recentList: $<HTMLSpanElement>("recent-list"),
	recentClear: $<HTMLButtonElement>("recent-clear"),
	welcome: $<HTMLDivElement>("welcome"),
	inbox: $<HTMLElement>("inbox"),
	addressText: $<HTMLSpanElement>("address-text"),
	copyBtn: $<HTMLButtonElement>("copy-btn"),
	status: $<HTMLSpanElement>("status"),
	autoToggle: $<HTMLInputElement>("auto-toggle"),
	autoInterval: $<HTMLSelectElement>("auto-interval"),
	notifyWrap: $<HTMLLabelElement>("notify-wrap"),
	notifyToggle: $<HTMLInputElement>("notify-toggle"),
	refreshBtn: $<HTMLButtonElement>("refresh-btn"),
	panes: $<HTMLDivElement>("panes"),
	messageList: $<HTMLUListElement>("message-list"),
	empty: $<HTMLDivElement>("empty"),
	emptyHint: $<HTMLParagraphElement>("empty-hint"),
	reader: $<HTMLElement>("reader"),
	placeholder: $<HTMLDivElement>("placeholder"),
	backBtn: $<HTMLButtonElement>("back-btn"),
	rSubject: $<HTMLHeadingElement>("r-subject"),
	rFrom: $<HTMLElement>("r-from"),
	rTo: $<HTMLElement>("r-to"),
	rDate: $<HTMLElement>("r-date"),
	rExpire: $<HTMLElement>("r-expire"),
	rOtp: $<HTMLDivElement>("r-otp"),
	rOtpCode: $<HTMLElement>("r-otp-code"),
	rOtpCopy: $<HTMLButtonElement>("r-otp-copy"),
	imagesBtn: $<HTMLButtonElement>("images-btn"),
	rawBtn: $<HTMLButtonElement>("raw-btn"),
	deleteBtn: $<HTMLButtonElement>("delete-btn"),
	rAttachments: $<HTMLUListElement>("r-attachments"),
	rBody: $<HTMLIFrameElement>("r-body"),
	footLimits: $<HTMLParagraphElement>("foot-limits"),
	rawModal: $<HTMLDivElement>("raw-modal"),
	rawBackdrop: $<HTMLDivElement>("raw-backdrop"),
	rawContent: $<HTMLPreElement>("raw-content"),
	rawCopyBtn: $<HTMLButtonElement>("raw-copy-btn"),
	rawDownloadBtn: $<HTMLAnchorElement>("raw-download-btn"),
	rawCloseBtn: $<HTMLButtonElement>("raw-close-btn"),
};

interface AppState {
	config: AppConfigResponse;
	username: string | null;
	domain: string;
	messages: MessageSummary[];
	knownIds: Set<string>;
	hasLoadedCurrentInbox: boolean;
	selectedId: string | null;
	selectedDetail: MessageDetail | null;
	showExternalImages: boolean;
	readIds: Set<string>;
	refreshTimer: number | null;
	expireTimer: number | null;
	isFetching: boolean;
}

const state: AppState = {
	config: {
		appName: "Ton Mail",
		domains: ["ton.my.id"],
		defaultDomain: "ton.my.id",
		siteUrl: window.location.origin,
		declineUrl: "https://ton.my.id/",
		retentionHours: 5,
		maxEmailBytes: 5 * 1024 * 1024,
	},
	username: null,
	domain: "ton.my.id",
	messages: [],
	knownIds: new Set(),
	hasLoadedCurrentInbox: false,
	selectedId: null,
	selectedDetail: null,
	showExternalImages: false,
	readIds: loadReadIds(),
	refreshTimer: null,
	expireTimer: null,
	isFetching: false,
};

function safeStorageGet(key: string): string | null {
	try {
		return window.localStorage.getItem(key);
	} catch {
		return null;
	}
}

function safeStorageSet(key: string, value: string): void {
	try {
		window.localStorage.setItem(key, value);
	} catch {
		// Ignore quota / privacy mode errors
	}
}

function safeStorageRemove(key: string): void {
	try {
		window.localStorage.removeItem(key);
	} catch {
		// Ignore
	}
}

function loadReadIds(): Set<string> {
	try {
		const raw = safeStorageGet(STORAGE_READ_IDS);
		if (!raw) return new Set();
		const parsed = JSON.parse(raw);
		if (Array.isArray(parsed)) {
			return new Set(parsed.filter((item): item is string => typeof item === "string").slice(-200));
		}
	} catch {
		// Ignore invalid JSON
	}
	return new Set();
}

function saveReadIds(): void {
	const arr = Array.from(state.readIds).slice(-200);
	safeStorageSet(STORAGE_READ_IDS, JSON.stringify(arr));
}

function loadRecent(): string[] {
	try {
		const raw = safeStorageGet(STORAGE_RECENT);
		if (!raw) return [];
		const parsed = JSON.parse(raw);
		if (Array.isArray(parsed)) {
			return parsed.filter((item): item is string => typeof item === "string").slice(0, 8);
		}
	} catch {
		// Ignore
	}
	return [];
}

function addRecent(address: string): void {
	const next = [address, ...loadRecent().filter((item) => item !== address)].slice(0, 8);
	safeStorageSet(STORAGE_RECENT, JSON.stringify(next));
	renderRecent();
}

function renderRecent(): void {
	const items = loadRecent();
	els.recentList.replaceChildren();
	if (items.length === 0) {
		els.recentWrap.hidden = true;
		return;
	}

	els.recentWrap.hidden = false;
	for (const address of items) {
		const btn = document.createElement("button");
		btn.type = "button";
		btn.className = "recent-pill";
		btn.textContent = address;
		btn.addEventListener("click", () => {
			const [user, dom] = address.split("@");
			if (user) {
				openInbox(user, dom || state.config.defaultDomain, true);
			}
		});
		els.recentList.appendChild(btn);
	}
}

function randomInt(max: number): number {
	const arr = new Uint32Array(1);
	crypto.getRandomValues(arr);
	return arr[0] % max;
}

function generateRandomUsername(): string {
	const w1 = WORDS_A[randomInt(WORDS_A.length)];
	const w2 = WORDS_B[randomInt(WORDS_B.length)];
	const num = 10 + randomInt(90);
	return `${w1}-${w2}${num}`;
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function formatDateTime(ts: number): string {
	try {
		return new Intl.DateTimeFormat("id-ID", {
			day: "2-digit",
			month: "short",
			year: "numeric",
			hour: "2-digit",
			minute: "2-digit",
			second: "2-digit",
		}).format(new Date(ts));
	} catch {
		return new Date(ts).toLocaleString();
	}
}

function formatShortTime(ts: number): string {
	const diffSec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
	if (diffSec < 60) return "baru saja";
	if (diffSec < 3600) return `${Math.floor(diffSec / 60)} mnt lalu`;
	if (diffSec < 86400) return `${Math.floor(diffSec / 3600)} jam lalu`;
	return formatDateTime(ts);
}

function formatExpireCountdown(expiresAt: number): string {
	const remainingMs = expiresAt - Date.now();
	if (remainingMs <= 0) return "Segera terhapus";
	const totalMinutes = Math.ceil(remainingMs / 60_000);
	const hours = Math.floor(totalMinutes / 60);
	const mins = totalMinutes % 60;
	const rel =
		hours > 0
			? mins > 0
				? `${hours} jam ${mins} menit lagi`
				: `${hours} jam lagi`
			: `${mins} menit lagi`;
	return `${rel} (${formatDateTime(expiresAt)})`;
}

function formatSender(fromName: string, fromAddress: string): string {
	if (fromName && fromName.toLowerCase() !== fromAddress.toLowerCase()) {
		return `${fromName} <${fromAddress}>`;
	}
	return fromAddress;
}

function showFormError(msg: string): void {
	els.formError.textContent = msg;
	els.formError.hidden = false;
}

function clearFormError(): void {
	els.formError.textContent = "";
	els.formError.hidden = true;
}

async function copyText(
	text: string,
	button: HTMLButtonElement,
	defaultLabel: string,
): Promise<void> {
	try {
		if (navigator.clipboard?.writeText) {
			await navigator.clipboard.writeText(text);
		} else {
			const textarea = document.createElement("textarea");
			textarea.value = text;
			textarea.style.position = "fixed";
			textarea.style.opacity = "0";
			document.body.appendChild(textarea);
			textarea.select();
			document.execCommand("copy");
			textarea.remove();
		}
		button.textContent = "Tersalin ✓";
		button.classList.add("copied");
		window.setTimeout(() => {
			button.textContent = defaultLabel;
			button.classList.remove("copied");
		}, 1800);
	} catch {
		button.textContent = "Gagal salin";
		window.setTimeout(() => {
			button.textContent = defaultLabel;
		}, 1800);
	}
}

function buildIframeSrcdoc(htmlBody: string, allowExternalImages: boolean): string {
	const imgSrc = allowExternalImages ? "data: https: http:" : "data:";
	const csp = `default-src 'none'; style-src 'unsafe-inline'; img-src ${imgSrc}; font-src data:;`;
	return `<!DOCTYPE html>
<html lang="id">
<head>
<meta charset="UTF-8">
<meta name="referrer" content="no-referrer">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style>
  html, body {
    margin: 0;
    padding: 0;
    background: #ffffff;
    color: #0f172a;
    font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif;
    font-size: 14.5px;
    line-height: 1.6;
    word-break: break-word;
  }
  body {
    padding: 18px 20px;
  }
  img {
    max-width: 100%;
    height: auto;
  }
  a {
    color: #1d4ed8;
  }
  pre {
    overflow-x: auto;
    background: #f8fafc;
    padding: 10px 12px;
    border-radius: 6px;
  }
  blockquote {
    margin: 10px 0;
    padding-left: 12px;
    border-left: 3px solid #cbd5e1;
    color: #475569;
  }
  .ton-plaintext {
    white-space: pre-wrap;
    font-family: ui-sans-serif, system-ui, -apple-system, sans-serif;
  }
</style>
</head>
<body>${htmlBody || '<p style="color:#64748b;font-style:italic">(Email tanpa isi)</p>'}</body>
</html>`;
}

function updateEmptyHint(): void {
	if (!els.autoToggle.checked) {
		els.emptyHint.textContent = "Auto refresh nonaktif. Klik Muat ulang untuk memeriksa email.";
		return;
	}
	const sec = Number(els.autoInterval.value) || 15;
	const label = sec === 60 ? "1 menit" : `${sec} detik`;
	els.emptyHint.textContent = `Inbox diperiksa otomatis setiap ${label}.`;
}

function scheduleRefresh(): void {
	if (state.refreshTimer !== null) {
		window.clearInterval(state.refreshTimer);
		state.refreshTimer = null;
	}
	updateEmptyHint();

	if (!state.username || !els.autoToggle.checked) return;

	const seconds = Math.max(5, Number(els.autoInterval.value) || 15);
	state.refreshTimer = window.setInterval(() => {
		void fetchMessages(true);
	}, seconds * 1000);
}

function clearExpireTimer(): void {
	if (state.expireTimer !== null) {
		window.clearInterval(state.expireTimer);
		state.expireTimer = null;
	}
}

function startExpireTimer(): void {
	clearExpireTimer();
	if (!state.selectedDetail) return;
	const update = () => {
		if (!state.selectedDetail) return;
		els.rExpire.textContent = formatExpireCountdown(state.selectedDetail.expiresAt);
	};
	update();
	state.expireTimer = window.setInterval(update, 30_000);
}

function renderMessageList(): void {
	els.messageList.replaceChildren();
	if (state.messages.length === 0) {
		els.empty.hidden = false;
		return;
	}

	els.empty.hidden = true;
	for (const msg of state.messages) {
		const li = document.createElement("li");
		li.className = "message-item";
		if (msg.id === state.selectedId) li.classList.add("active");
		if (!state.readIds.has(msg.id)) li.classList.add("unread");

		const btn = document.createElement("button");
		btn.type = "button";
		btn.className = "message-btn";
		btn.addEventListener("click", () => {
			void selectMessage(msg.id);
		});

		const top = document.createElement("div");
		top.className = "msg-top";

		const from = document.createElement("span");
		from.className = "msg-from";
		from.textContent = msg.fromName || msg.fromAddress;

		const time = document.createElement("span");
		time.className = "msg-time";
		time.textContent = formatShortTime(msg.receivedAt);

		top.append(from, time);

		const subject = document.createElement("div");
		subject.className = "msg-subject";
		subject.textContent = msg.subject;

		const snippet = document.createElement("div");
		snippet.className = "msg-snippet";
		snippet.textContent = msg.snippet || "(Tanpa pratinjau)";

		btn.append(top, subject, snippet);

		if (msg.otpCode || msg.attachmentCount > 0) {
			const badges = document.createElement("div");
			badges.className = "msg-badges";

			if (msg.otpCode) {
				const otpBadge = document.createElement("span");
				otpBadge.className = "badge badge-otp";
				otpBadge.textContent = `OTP: ${msg.otpCode}`;
				badges.appendChild(otpBadge);
			}

			if (msg.attachmentCount > 0) {
				const attBadge = document.createElement("span");
				attBadge.className = "badge badge-att";
				attBadge.textContent = `${msg.attachmentCount} lampiran`;
				badges.appendChild(attBadge);
			}

			btn.appendChild(badges);
		}

		li.appendChild(btn);
		els.messageList.appendChild(li);
	}
}

function renderReader(): void {
	const detail = state.selectedDetail;
	if (!detail) {
		els.reader.hidden = true;
		els.placeholder.hidden = false;
		els.panes.classList.remove("reading");
		clearExpireTimer();
		return;
	}

	els.placeholder.hidden = true;
	els.reader.hidden = false;
	els.panes.classList.add("reading");

	els.rSubject.textContent = detail.subject;
	els.rFrom.textContent = formatSender(detail.fromName, detail.fromAddress);
	els.rTo.textContent = detail.toAddress;
	els.rDate.textContent = formatDateTime(detail.receivedAt);
	startExpireTimer();

	if (detail.otpCode) {
		els.rOtpCode.textContent = detail.otpCode;
		els.rOtp.hidden = false;
	} else {
		els.rOtp.hidden = true;
	}

	if (detail.hasExternalImages) {
		els.imagesBtn.hidden = false;
		els.imagesBtn.textContent = state.showExternalImages
			? "Sembunyikan gambar eksternal"
			: "Tampilkan gambar eksternal";
	} else {
		els.imagesBtn.hidden = true;
	}

	els.rAttachments.replaceChildren();
	if (detail.attachments.length > 0 && state.username) {
		els.rAttachments.hidden = false;
		for (const att of detail.attachments) {
			const li = document.createElement("li");
			const a = document.createElement("a");
			a.className = "attachment-link";
			a.href = `/api/inbox/${encodeURIComponent(state.username)}/messages/${encodeURIComponent(detail.id)}/attachments/${encodeURIComponent(att.id)}?domain=${encodeURIComponent(state.domain)}`;
			a.download = att.filename;
			a.rel = "noopener noreferrer";

			const nameSpan = document.createElement("span");
			nameSpan.textContent = att.filename;
			const sizeSpan = document.createElement("span");
			sizeSpan.className = "attachment-size";
			sizeSpan.textContent = `(${formatBytes(att.sizeBytes)})`;

			a.append(nameSpan, sizeSpan);
			li.appendChild(a);
			els.rAttachments.appendChild(li);
		}
	} else {
		els.rAttachments.hidden = true;
	}

	els.rBody.srcdoc = buildIframeSrcdoc(detail.htmlBody, state.showExternalImages);
}

function maybeNotifyNewMessages(newMsgs: MessageSummary[]): void {
	if (
		!els.notifyToggle.checked ||
		!document.hidden ||
		!("Notification" in window) ||
		Notification.permission !== "granted"
	) {
		return;
	}

	const latest = newMsgs[0];
	if (!latest) return;

	const title =
		newMsgs.length === 1 ? `Email baru: ${latest.subject}` : `${newMsgs.length} email baru masuk`;
	const body =
		newMsgs.length === 1
			? `Dari ${latest.fromName || latest.fromAddress}${latest.otpCode ? ` — Kode: ${latest.otpCode}` : ""}`
			: `Terbaru dari ${latest.fromName || latest.fromAddress}: ${latest.subject}`;

	const notification = new Notification(title, {
		body,
		icon: "/icon.svg",
		tag: `tonmail-${latest.toAddress}`,
	});
	notification.onclick = () => {
		window.focus();
		void selectMessage(latest.id);
		notification.close();
	};
}

async function fetchMessages(isAuto = false): Promise<void> {
	if (!state.username || state.isFetching) return;
	state.isFetching = true;
	if (!isAuto) {
		els.status.textContent = "Memeriksa...";
		els.refreshBtn.disabled = true;
	}

	const reqUsername = state.username;
	const reqDomain = state.domain;

	try {
		const res = await fetch(
			`/api/inbox/${encodeURIComponent(reqUsername)}/messages?domain=${encodeURIComponent(reqDomain)}`,
			{ cache: "no-store" },
		);
		const data = (await res.json()) as MessagesListResponse & { error?: string };

		// Ignore stale responses if user switched inbox mid-flight
		if (state.username !== reqUsername || state.domain !== reqDomain) return;

		if (!res.ok) {
			showFormError(data.error || "Gagal memuat inbox.");
			els.status.textContent = "Gagal memuat";
			return;
		}

		clearFormError();
		const incoming = data.messages || [];

		if (state.hasLoadedCurrentInbox) {
			const newlyArrived = incoming.filter((m) => !state.knownIds.has(m.id));
			if (newlyArrived.length > 0) {
				maybeNotifyNewMessages(newlyArrived);
			}
		}

		state.knownIds = new Set(incoming.map((m) => m.id));
		state.hasLoadedCurrentInbox = true;
		state.messages = incoming;

		// Clear selection if selected message expired or was deleted elsewhere
		if (state.selectedId && !incoming.some((m) => m.id === state.selectedId)) {
			state.selectedId = null;
			state.selectedDetail = null;
			renderReader();
		}

		renderMessageList();

		const nowLabel = new Intl.DateTimeFormat("id-ID", {
			hour: "2-digit",
			minute: "2-digit",
			second: "2-digit",
		}).format(new Date());
		els.status.textContent =
			incoming.length > 0 ? `${incoming.length} email · ${nowLabel}` : `Diperbarui ${nowLabel}`;
	} catch {
		if (state.username === reqUsername) {
			els.status.textContent = "Koneksi terputus";
		}
	} finally {
		state.isFetching = false;
		els.refreshBtn.disabled = false;
	}
}

async function selectMessage(messageId: string): Promise<void> {
	if (!state.username) return;
	state.selectedId = messageId;
	state.showExternalImages = false;
	state.readIds.add(messageId);
	saveReadIds();
	renderMessageList();

	const reqUsername = state.username;
	const reqDomain = state.domain;

	try {
		const res = await fetch(
			`/api/inbox/${encodeURIComponent(reqUsername)}/messages/${encodeURIComponent(messageId)}?domain=${encodeURIComponent(reqDomain)}`,
			{ cache: "no-store" },
		);
		if (state.selectedId !== messageId || state.username !== reqUsername) return;

		if (!res.ok) {
			state.selectedId = null;
			state.selectedDetail = null;
			renderReader();
			void fetchMessages(false);
			return;
		}

		const payload = (await res.json()) as { message: MessageDetail };
		state.selectedDetail = payload.message;
		renderReader();
	} catch {
		els.status.textContent = "Gagal memuat isi email";
	}
}

async function openRawModal(): Promise<void> {
	if (!state.username || !state.selectedDetail) return;
	const rawUrl = `/api/inbox/${encodeURIComponent(state.username)}/messages/${encodeURIComponent(state.selectedDetail.id)}/raw?domain=${encodeURIComponent(state.domain)}`;
	els.rawDownloadBtn.href = `${rawUrl}&download=1`;
	els.rawContent.textContent = "Memuat sumber email...";
	els.rawModal.hidden = false;

	try {
		const res = await fetch(rawUrl, { cache: "no-store" });
		if (!res.ok) {
			els.rawContent.textContent = "Gagal memuat sumber email.";
			return;
		}
		els.rawContent.textContent = await res.text();
	} catch {
		els.rawContent.textContent = "Terjadi kesalahan saat mengambil sumber email.";
	}
}

function closeRawModal(): void {
	els.rawModal.hidden = true;
}

async function deleteSelectedMessage(): Promise<void> {
	if (!state.username || !state.selectedDetail) return;
	const targetId = state.selectedDetail.id;
	els.deleteBtn.disabled = true;

	try {
		const res = await fetch(
			`/api/inbox/${encodeURIComponent(state.username)}/messages/${encodeURIComponent(targetId)}?domain=${encodeURIComponent(state.domain)}`,
			{ method: "DELETE" },
		);
		if (res.ok || res.status === 404) {
			state.messages = state.messages.filter((m) => m.id !== targetId);
			state.knownIds.delete(targetId);
			state.selectedId = null;
			state.selectedDetail = null;
			renderMessageList();
			renderReader();
			els.status.textContent = "Email dihapus";
		}
	} finally {
		els.deleteBtn.disabled = false;
	}
}

function closeInboxToHome(pushHistory = true): void {
	state.username = null;
	state.messages = [];
	state.knownIds = new Set();
	state.hasLoadedCurrentInbox = false;
	state.selectedId = null;
	state.selectedDetail = null;
	clearExpireTimer();
	scheduleRefresh();

	els.nameInput.value = "";
	clearFormError();
	els.inbox.hidden = true;
	els.welcome.hidden = false;
	document.title = state.config.appName;

	if (pushHistory && window.location.pathname !== "/") {
		window.history.pushState({}, "", "/");
	}
}

function openInbox(rawUsername: string, rawDomain: string, pushHistory = true): void {
	let username = rawUsername.trim().toLowerCase();
	let domain = rawDomain.trim().toLowerCase() || state.config.defaultDomain;

	if (username.includes("@")) {
		const [local, maybeDom] = username.split("@", 2);
		username = local;
		if (maybeDom && state.config.domains.includes(maybeDom)) {
			domain = maybeDom;
		}
	}

	if (!username || username.length > 64 || !USERNAME_RE.test(username) || username.includes("..")) {
		showFormError(
			"Username hanya boleh berisi huruf, angka, titik (.), garis bawah (_), tanda hubung (-), atau plus (+), tanpa titik ganda atau simbol di awal/akhir.",
		);
		return;
	}

	clearFormError();

	state.username = username;
	state.domain = domain;
	state.messages = [];
	state.knownIds = new Set();
	state.hasLoadedCurrentInbox = false;
	state.selectedId = null;
	state.selectedDetail = null;
	state.showExternalImages = false;

	els.nameInput.value = username;
	if (Array.from(els.domainSelect.options).some((opt) => opt.value === domain)) {
		els.domainSelect.value = domain;
	}

	const address = `${username}@${domain}`;
	els.addressText.textContent = address;
	els.welcome.hidden = true;
	els.inbox.hidden = false;
	document.title = `${address} — ${state.config.appName}`;

	addRecent(address);
	renderMessageList();
	renderReader();

	if (pushHistory) {
		const targetPath =
			domain === state.config.defaultDomain
				? `/${encodeURIComponent(username)}`
				: `/${encodeURIComponent(address)}`;
		if (window.location.pathname !== targetPath) {
			window.history.pushState({ username, domain }, "", targetPath);
		}
	}

	scheduleRefresh();
	void fetchMessages(false);
}

function parseInboxFromLocation(): { username: string; domain: string } | null {
	const url = new URL(window.location.href);
	const queryUser = url.searchParams.get("u") || url.searchParams.get("inbox");
	const hashUser = url.hash ? decodeURIComponent(url.hash.slice(1)) : "";
	const pathSegment = url.pathname.replace(/^\/+|\/+$/g, "");

	const candidate = (
		queryUser ||
		hashUser ||
		(pathSegment && !pathSegment.includes("/") ? decodeURIComponent(pathSegment) : "")
	).trim();
	if (!candidate) return null;

	if (candidate.includes("@")) {
		const [local, dom] = candidate.split("@", 2);
		return { username: local, domain: dom || state.config.defaultDomain };
	}

	return {
		username: candidate,
		domain: url.searchParams.get("domain") || state.config.defaultDomain,
	};
}

async function loadConfig(): Promise<void> {
	try {
		const res = await fetch("/api/config", { cache: "no-store" });
		if (!res.ok) return;
		const cfg = (await res.json()) as AppConfigResponse;
		state.config = cfg;
		state.domain = cfg.defaultDomain;

		els.brandName.textContent = cfg.appName;
		els.consentDecline.href = cfg.declineUrl;

		const maxMb = Math.round(cfg.maxEmailBytes / (1024 * 1024));
		const limitsText = `Email akan dihapus otomatis dalam ${cfg.retentionHours} jam. Hanya menerima, maksimal ${maxMb} MB per email.`;
		els.consentLimits.textContent = limitsText;
		els.footLimits.textContent = limitsText;

		els.domainSelect.replaceChildren();
		for (const domain of cfg.domains) {
			const opt = document.createElement("option");
			opt.value = domain;
			opt.textContent = domain;
			els.domainSelect.appendChild(opt);
		}
		els.domainSelect.value = cfg.defaultDomain;
	} catch {
		// Keep built-in defaults
	}
}

function initPreferences(): void {
	const savedAuto = safeStorageGet(STORAGE_AUTO_ENABLED);
	if (savedAuto !== null) {
		els.autoToggle.checked = savedAuto === "1";
	}

	const savedInterval = safeStorageGet(STORAGE_AUTO_INTERVAL);
	if (savedInterval && ["10", "15", "30", "60"].includes(savedInterval)) {
		els.autoInterval.value = savedInterval;
	}

	if (!("Notification" in window)) {
		els.notifyWrap.hidden = true;
	}

	updateEmptyHint();
}

function bindEvents(): void {
	els.consentAgree.addEventListener("click", () => {
		safeStorageSet(STORAGE_CONSENT, "1");
		document.documentElement.classList.add("consented");
	});

	document.querySelectorAll<HTMLAnchorElement>("a[data-link]").forEach((link) => {
		link.addEventListener("click", (event) => {
			event.preventDefault();
			closeInboxToHome(true);
		});
	});

	els.openForm.addEventListener("submit", (event) => {
		event.preventDefault();
		openInbox(els.nameInput.value, els.domainSelect.value, true);
	});

	els.nameInput.addEventListener("input", () => {
		clearFormError();
		const val = els.nameInput.value;
		if (val.includes("@")) {
			const [local, maybeDomain] = val.split("@", 2);
			els.nameInput.value = local;
			if (maybeDomain && state.config.domains.includes(maybeDomain.trim().toLowerCase())) {
				els.domainSelect.value = maybeDomain.trim().toLowerCase();
			}
		}
	});

	els.randomBtn.addEventListener("click", () => {
		const randomName = generateRandomUsername();
		openInbox(randomName, els.domainSelect.value, true);
	});

	els.recentClear.addEventListener("click", () => {
		safeStorageRemove(STORAGE_RECENT);
		renderRecent();
	});

	els.copyBtn.addEventListener("click", () => {
		if (!state.username) return;
		void copyText(`${state.username}@${state.domain}`, els.copyBtn, "Salin");
	});

	els.rOtpCopy.addEventListener("click", () => {
		if (!state.selectedDetail?.otpCode) return;
		void copyText(state.selectedDetail.otpCode, els.rOtpCopy, "Salin kode");
	});

	els.autoToggle.addEventListener("change", () => {
		safeStorageSet(STORAGE_AUTO_ENABLED, els.autoToggle.checked ? "1" : "0");
		scheduleRefresh();
	});

	els.autoInterval.addEventListener("change", () => {
		safeStorageSet(STORAGE_AUTO_INTERVAL, els.autoInterval.value);
		scheduleRefresh();
	});

	els.notifyToggle.addEventListener("change", async () => {
		if (!els.notifyToggle.checked) return;
		if (!("Notification" in window)) {
			els.notifyToggle.checked = false;
			return;
		}
		if (Notification.permission === "default") {
			const permission = await Notification.requestPermission();
			if (permission !== "granted") {
				els.notifyToggle.checked = false;
			}
		} else if (Notification.permission === "denied") {
			els.notifyToggle.checked = false;
			els.status.textContent = "Izin notifikasi ditolak browser";
		}
	});

	els.refreshBtn.addEventListener("click", () => {
		void fetchMessages(false);
	});

	els.backBtn.addEventListener("click", () => {
		state.selectedId = null;
		state.selectedDetail = null;
		renderMessageList();
		renderReader();
	});

	els.imagesBtn.addEventListener("click", () => {
		state.showExternalImages = !state.showExternalImages;
		renderReader();
	});

	els.rawBtn.addEventListener("click", () => {
		void openRawModal();
	});

	els.rawCloseBtn.addEventListener("click", closeRawModal);
	els.rawBackdrop.addEventListener("click", closeRawModal);
	els.rawCopyBtn.addEventListener("click", () => {
		void copyText(els.rawContent.textContent || "", els.rawCopyBtn, "Salin");
	});

	document.addEventListener("keydown", (event) => {
		if (event.key === "Escape" && !els.rawModal.hidden) {
			closeRawModal();
		}
	});

	els.deleteBtn.addEventListener("click", () => {
		void deleteSelectedMessage();
	});

	window.addEventListener("popstate", () => {
		const target = parseInboxFromLocation();
		if (target) {
			openInbox(target.username, target.domain, false);
		} else {
			closeInboxToHome(false);
		}
	});
}

async function boot(): Promise<void> {
	initPreferences();
	bindEvents();
	renderRecent();
	await loadConfig();

	const initial = parseInboxFromLocation();
	if (initial) {
		openInbox(initial.username, initial.domain, false);
	}
}

void boot();
