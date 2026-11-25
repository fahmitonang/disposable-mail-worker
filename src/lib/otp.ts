const KEYWORD_AFTER_PATTERNS: RegExp[] = [
	// Indonesian & English explicit verification keywords followed by code
	/(?:kode\s+(?:verifikasi|otp|keamanan|konfirmasi|masuk|rahasia|akses|aktivasi|otentikasi|autentikasi|login)|verification\s+code|security\s+code|confirmation\s+code|login\s+code|sign[\s-]*in\s+code|one[\s-]*time\s+(?:password|passcode|code)|auth(?:entication)?\s+code|passcode|otp(?:\s+code)?|2fa\s+code|mfa\s+code)\b\s*(?:(?:anda|kamu)\b\s*)?(?:adalah\b|is\b|:|-|=|\s)*(?:\r?\n\s*)?([0-9]{4,8}|[0-9]{3}[\s-][0-9]{3}|[A-Z0-9]{3}-[A-Z0-9]{3})(?![a-zA-Z0-9])/i,
	// Shorter "kode: 123456" / "code: 123456" / "pin: 123456"
	/(?:\bkode\b|\bcode\b|\bpin\b)\s*(?:(?:anda|kamu)\b\s*)?(?:adalah\b|is\b|:|=)\s*([0-9]{4,8}|[0-9]{3}[\s-][0-9]{3})(?![a-zA-Z0-9])/i,
];

const KEYWORD_BEFORE_PATTERNS: RegExp[] = [
	// "482910 adalah kode verifikasi Anda" / "482910 is your verification code"
	/(?<![a-zA-Z0-9#/.])([0-9]{4,8}|[0-9]{3}[\s-][0-9]{3})\s+(?:adalah|is)\s+(?:your\s+|the\s+)?(?:kode\s+(?:verifikasi|otp|keamanan|konfirmasi|masuk|akses|aktivasi)|verification\s+code|security\s+code|confirmation\s+code|login\s+code|one[\s-]*time\s+(?:password|code)|passcode|otp\b|pin\b)/i,
];

const SUBJECT_CONTEXT_RE =
	/\b(otp|kode|code|verif(?:y|ikasi|ication)|konfirmasi|confirm(?:ation)?|login|masuk|passcode|pin|2fa|mfa|aktivasi|activate|security|keamanan)\b/i;

const SUBJECT_CODE_RE = /(?<![a-zA-Z0-9#/.])([0-9]{4,8}|[0-9]{3}-[0-9]{3})(?![a-zA-Z0-9])/;

function stripHtmlForOtp(html: string): string {
	return html
		.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
		.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
		.replace(/<(?:br|\/p|\/div|\/tr|\/td|\/li|\/h[1-6])\b[^>]*>/gi, "\n")
		.replace(/<[^>]+>/g, " ")
		.replace(/&nbsp;/gi, " ")
		.replace(/&amp;/gi, "&")
		.replace(/&lt;/gi, "<")
		.replace(/&gt;/gi, ">")
		.replace(/&#(\d+);/g, (_, num: string) => String.fromCharCode(Number(num)))
		.replace(/[ \t]+/g, " ");
}

function normalizeCandidate(raw: string): string | null {
	const cleaned = raw.trim().replace(/\s+/g, "");
	const digitsOnly = cleaned.replace(/-/g, "");
	// Must contain at least one digit (reject pure words like "ABCDEF")
	if (!/\d/.test(digitsOnly)) return null;
	if (digitsOnly.length < 4 || digitsOnly.length > 8) return null;
	return cleaned;
}

function isLikelyYear(code: string): boolean {
	if (!/^\d{4}$/.test(code)) return false;
	const n = Number(code);
	return n >= 1990 && n <= 2099;
}

export function extractOtpCode(subject: string, textBody: string, htmlBody: string): string | null {
	const plainText = textBody.trim() || (htmlBody ? stripHtmlForOtp(htmlBody) : "");
	// Remove URLs so numeric IDs inside links are never mistaken for OTPs
	const sanitizedText = `${subject}\n${plainText}`
		.replace(/https?:\/\/[^\s<>")']+/gi, " ")
		.replace(/\b\d{4}-\d{2}-\d{2}\b/g, " ") // ISO dates
		.replace(/\b\d{1,2}:\d{2}(?::\d{2})?\b/g, " "); // timestamps

	for (const pattern of KEYWORD_AFTER_PATTERNS) {
		const match = sanitizedText.match(pattern);
		if (match?.[1]) {
			const candidate = normalizeCandidate(match[1]);
			if (candidate) return candidate;
		}
	}

	for (const pattern of KEYWORD_BEFORE_PATTERNS) {
		const match = sanitizedText.match(pattern);
		if (match?.[1]) {
			const candidate = normalizeCandidate(match[1]);
			if (candidate) return candidate;
		}
	}

	if (SUBJECT_CONTEXT_RE.test(subject)) {
		const cleanSubject = subject.replace(/https?:\/\/[^\s]+/gi, " ");
		const match = cleanSubject.match(SUBJECT_CODE_RE);
		if (match?.[1]) {
			const candidate = normalizeCandidate(match[1]);
			if (candidate && !isLikelyYear(candidate)) {
				return candidate;
			}
		}
	}

	return null;
}
