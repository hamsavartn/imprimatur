/**
 * Input limits enforced at the API boundary. Oversized payloads are a
 * denial-of-service surface (and the zod advisory's exhaustion vector);
 * every limit here has a test.
 */

export const MAX_DRAFT_CHARS = 200_000;
export const MAX_TITLE_CHARS = 300;

export function draftTooLarge(content: string): boolean {
  return content.length > MAX_DRAFT_CHARS;
}

export function titleTooLong(title: string): boolean {
  return title.length > MAX_TITLE_CHARS;
}
