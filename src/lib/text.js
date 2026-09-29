
export function expandXShortUrls(text, links) {
  let output = String(text || "");
  for (const link of links ?? []) {
    if (!link.url || !link.expandedUrl) continue;
    output = output.split(link.url).join(link.expandedUrl);
  }
  return output.trim();
}
export function normalizePlainText(value) {
  return String(value || "")
    .replace(/\r/g, "\n")
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
export function decodeCookieValue(value) {
  try {
    return decodeURIComponent(String(value || ""));
  } catch {
    return String(value || "");
  }
}
export function shortStatusText(value, maxLength = 72) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}...` : text;
}
export function removeJunkHtml(html) {
  let output = String(html || "")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<svg\b[\s\S]*?<\/svg>/gi, " ")
    .replace(/<canvas\b[\s\S]*?<\/canvas>/gi, " ")
    .replace(/<iframe\b[\s\S]*?<\/iframe>/gi, " ");

  for (const tag of ["nav", "header", "footer", "form", "button", "aside"]) {
    output = output.replace(new RegExp(`<${tag}\\b[\\s\\S]*?<\\/${tag}>`, "gi"), " ");
  }

  return output.replace(/<([a-z0-9-]+)\b[^>]*(?:class|id)=["'][^"']*(?:cookie|consent|banner|popup|modal|newsletter|subscribe|signup|sign-up|advert|advertisement|sponsored|promo|share|social|related|recommend|comment|comments|sidebar|breadcrumb|pagination|paywall|app-download)[^"']*["'][^>]*>[\s\S]*?<\/\1>/gi, " ");
}
export function htmlToReadableText(html) {
  return String(html || "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(?:p|div|section|article|main|h[1-6]|blockquote|pre|tr)>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<\/li>/gi, "\n")
    .replace(/<td\b[^>]*>/gi, " ")
    .replace(/<\/td>/gi, " ")
    .replace(/<[^>]+>/g, " ");
}
export function cleanReadableText(value) {
  const seen = new Set();
  const lines = decodeHtml(String(value || ""))
    .replace(/\r/g, "\n")
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => line && !isReadableJunkLine(line))
    .filter((line) => {
      const key = line.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}
export function isReadableJunkLine(line) {
  const lower = String(line || "").toLowerCase();
  if (lower.length <= 2) return true;
  if (/^(sign in|sign up|log in|subscribe|newsletter|cookie settings|accept all|reject all|advertisement|sponsored|share|follow us|read more)$/i.test(lower)) return true;
  if (/^(facebook|twitter|x|instagram|linkedin|reddit|whatsapp|telegram|email)$/.test(lower)) return true;
  if (lower.includes("enable javascript")) return true;
  if (lower.includes("cookies") && lower.length < 120) return true;
  if (lower.includes("privacy policy") && lower.length < 120) return true;
  return false;
}
export function cleanSearchSnippet(value) {
  return decodeHtml(String(value || "")
    .replace(/\b(?:Cached|Similar pages|Translate this page)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim()).slice(0, 520);
}
export function stripHtml(value) {
  return decodeHtml(String(value || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim());
}
export function decodeHtml(value) {
  return String(value || "").replace(/&(#\d+|#x[0-9a-f]+|amp|quot|apos|lt|gt|nbsp);/gi, (match, entity) => {
    const lower = entity.toLowerCase();
    if (lower.startsWith("#")) {
      const code = lower[1] === "x" ? parseInt(lower.slice(2), 16) : Number(lower.slice(1));
      return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    return { amp: "&", quot: "\"", apos: "'", lt: "<", gt: ">", nbsp: " " }[lower] ?? match;
  });
}

