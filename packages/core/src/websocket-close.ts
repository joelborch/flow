const UNSENDABLE_CLOSE_CODES = new Set([1004, 1005, 1006, 1015]);

/** Map peer-only/reserved close codes to a code the Worker may send back. */
export function websocketCloseReplyCode(code: number): number {
  return code >= 1000 && code <= 1015 && !UNSENDABLE_CLOSE_CODES.has(code) ? code : 1000;
}
