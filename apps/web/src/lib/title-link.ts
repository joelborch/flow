// A task whose title is (or contains) a link — someone pasted a tweet or an
// article into quick add — gets a one-click way to open it. Only http(s):
// anything else a title might contain (javascript:, data:) never becomes a
// link.

const URL_IN_TEXT = /https?:\/\/[^\s<>"'`]+/i;

/** The first http(s) URL in a title, normalised, or null if there isn't one. */
export function titleLink(title: string): string | null {
  const match = URL_IN_TEXT.exec(title);
  if (!match) return null;
  // Sentence punctuation straight after a link belongs to the sentence; a
  // closing paren only when the URL never opened one (Wikipedia keeps its own).
  let raw = match[0].replace(/[.,;:!?]+$/, "");
  if (raw.endsWith(")") && !raw.includes("(")) raw = raw.slice(0, -1);
  try {
    const url = new URL(raw);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}
