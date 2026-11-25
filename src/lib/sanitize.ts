export interface SanitizeResult {
	html: string;
	hasExternalImages: boolean;
}

const SAFE_DATA_IMAGE_RE = /^data:image\/(?:png|jpeg|jpg|gif|webp);base64,[a-z0-9+/=\s]+$/i;
const EXTERNAL_URL_RE = /^(?:https?:)?\/\//i;
const SAFE_LINK_PROTOCOL_RE = /^(?:https?:\/\/|mailto:|tel:|#)/i;

export function escapeHtml(input: string): string {
	return input
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

function sanitizeStyleContent(css: string): { css: string; hasExternalImages: boolean } {
	let hasExternalImages = false;
	const cleaned = css
		.replace(/@import\b[^;]*;?/gi, "")
		.replace(/expression\s*\([^)]*\)/gi, "")
		.replace(/behavior\s*:[^;"]*;?/gi, "")
		.replace(/javascript\s*:/gi, "")
		.replace(/url\s*\(\s*(['"]?)([^)'"]+)\1\s*\)/gi, (full, _quote: string, rawUrl: string) => {
			const trimmed = rawUrl.trim();
			if (EXTERNAL_URL_RE.test(trimmed)) {
				hasExternalImages = true;
				return full;
			}
			if (SAFE_DATA_IMAGE_RE.test(trimmed)) {
				return full;
			}
			return "url()";
		});

	return { css: cleaned, hasExternalImages };
}

function sanitizeTagAttributes(
	tagName: string,
	rawAttrs: string,
): { attrs: string; hasExternalImages: boolean } {
	let hasExternalImages = false;
	let hasTarget = false;
	let hasRel = false;
	const safeAttrs: string[] = [];

	const attrRe = /([a-zA-Z][a-zA-Z0-9_:-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
	for (const match of rawAttrs.matchAll(attrRe)) {
		const attrName = match[1];
		const lowerName = attrName.toLowerCase();
		const value = match[2] ?? match[3] ?? match[4] ?? "";

		// Drop inline event handlers and dangerous attributes
		if (
			lowerName.startsWith("on") ||
			lowerName === "formaction" ||
			lowerName === "srcdoc" ||
			lowerName === "ping"
		) {
			continue;
		}

		if (lowerName === "href" || lowerName === "xlink:href") {
			const trimmed = value.trim();
			if (SAFE_LINK_PROTOCOL_RE.test(trimmed)) {
				safeAttrs.push(`href="${escapeHtml(trimmed)}"`);
			} else {
				safeAttrs.push('href="#"');
			}
			continue;
		}

		if (lowerName === "src" || lowerName === "poster" || lowerName === "background") {
			const trimmed = value.trim();
			if (EXTERNAL_URL_RE.test(trimmed)) {
				hasExternalImages = true;
				safeAttrs.push(`${lowerName}="${escapeHtml(trimmed)}"`);
			} else if (SAFE_DATA_IMAGE_RE.test(trimmed)) {
				safeAttrs.push(`${lowerName}="${escapeHtml(trimmed)}"`);
			}
			// Drop cid: (if unresolved), javascript:, data:text/html, etc.
			continue;
		}

		if (lowerName === "srcset") {
			const entries = value
				.split(",")
				.map((item) => item.trim())
				.filter(Boolean);
			const kept: string[] = [];
			for (const entry of entries) {
				const [urlPart, descriptor] = entry.split(/\s+/, 2);
				if (urlPart && EXTERNAL_URL_RE.test(urlPart)) {
					hasExternalImages = true;
					kept.push(descriptor ? `${urlPart} ${descriptor}` : urlPart);
				} else if (urlPart && SAFE_DATA_IMAGE_RE.test(urlPart)) {
					kept.push(descriptor ? `${urlPart} ${descriptor}` : urlPart);
				}
			}
			if (kept.length > 0) {
				safeAttrs.push(`srcset="${escapeHtml(kept.join(", "))}"`);
			}
			continue;
		}

		if (lowerName === "style") {
			const styleResult = sanitizeStyleContent(value);
			if (styleResult.hasExternalImages) {
				hasExternalImages = true;
			}
			safeAttrs.push(`style="${escapeHtml(styleResult.css)}"`);
			continue;
		}

		if (tagName === "a" && lowerName === "target") {
			hasTarget = true;
			safeAttrs.push('target="_blank"');
			continue;
		}

		if (tagName === "a" && lowerName === "rel") {
			hasRel = true;
			safeAttrs.push('rel="noopener noreferrer"');
			continue;
		}

		if (match[2] !== undefined || match[3] !== undefined || match[4] !== undefined) {
			safeAttrs.push(`${lowerName}="${escapeHtml(value)}"`);
		} else {
			safeAttrs.push(lowerName);
		}
	}

	if (tagName === "a") {
		if (!hasTarget) safeAttrs.push('target="_blank"');
		if (!hasRel) safeAttrs.push('rel="noopener noreferrer"');
	}

	return {
		attrs: safeAttrs.length > 0 ? ` ${safeAttrs.join(" ")}` : "",
		hasExternalImages,
	};
}

export function sanitizeEmailHtml(rawHtml: string): SanitizeResult {
	let hasExternalImages = false;

	// 1. Remove dangerous block elements along with their inner content
	let html = rawHtml
		.replace(/<!--[\s\S]*?-->/g, "")
		.replace(
			/<(script|iframe|frame|frameset|object|embed|applet|svg|math|textarea|select|button|template)\b[^>]*>[\s\S]*?<\/\1>/gi,
			"",
		)
		.replace(
			/<\/?(script|iframe|frame|frameset|object|embed|applet|svg|math|base|meta|link|form|input|button|select|textarea|template)\b[^>]*\/?>/gi,
			"",
		);

	// 2. Sanitize <style> blocks while keeping layout styling
	html = html.replace(/<style\b[^>]*>([\s\S]*?)<\/style>/gi, (_full, cssContent: string) => {
		const result = sanitizeStyleContent(cssContent);
		if (result.hasExternalImages) hasExternalImages = true;
		return `<style>${result.css}</style>`;
	});

	// 3. Sanitize attributes on all remaining start tags
	html = html.replace(
		/<([a-zA-Z][a-zA-Z0-9-]*)\b((?:[^>"']|"[^"]*"|'[^']*')*)(\/?)>/g,
		(_full, rawTag: string, rawAttrs: string, selfClosing: string) => {
			const tagName = rawTag.toLowerCase();
			if (!rawAttrs.trim() && tagName !== "a") {
				return `<${tagName}${selfClosing}>`;
			}
			const result = sanitizeTagAttributes(tagName, rawAttrs);
			if (result.hasExternalImages) hasExternalImages = true;
			return `<${tagName}${result.attrs}${selfClosing}>`;
		},
	);

	return { html, hasExternalImages };
}

export function renderPlainTextToHtml(text: string): string {
	const escaped = escapeHtml(text);
	const linkified = escaped.replace(/\b(https?:\/\/[^\s<>"']+)/gi, (url) => {
		// Trim common trailing punctuation from matched URLs
		const cleanUrl = url.replace(/[.,;:!?)\]]+$/, "");
		const suffix = url.slice(cleanUrl.length);
		return `<a href="${cleanUrl}" target="_blank" rel="noopener noreferrer">${cleanUrl}</a>${suffix}`;
	});

	return `<div class="ton-plaintext">${linkified}</div>`;
}
