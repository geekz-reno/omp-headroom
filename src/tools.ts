import { RETRIEVED_MARKER } from "./config.ts";
import { isRecord } from "./util.ts";

export async function retrieveViaProxy(
  proxyUrl: string,
  hash: string,
  query: string | undefined,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<unknown> {
  try {
    const response = await fetch(new URL("/v1/retrieve", proxyUrl), {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Client": "omp" },
      body: JSON.stringify(query ? { hash, query } : { hash }),
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
        : AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    let data: unknown;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { raw: text };
    }
    if (!response.ok)
      return {
        error:
          isRecord(data) && typeof data.error === "string" ? data.error : `HTTP ${response.status}`,
        hash,
      };
    return data;
  } catch (error) {
    return { error: String(error), hash };
  }
}

export interface RetrievalPageOptions {
  query?: string;
  offset?: number;
  limit?: number;
}

const DEFAULT_PAGE_CHARS = 12_000;
const MAX_PAGE_CHARS = 32_000;
const MAX_QUERY_CHARS = 1_024;
const boundedPages = new WeakSet<object>();

function freezePage(page: Record<string, unknown>): Record<string, unknown> {
  Object.freeze(page);
  boundedPages.add(page);
  return page;
}

function validInteger(value: unknown, minimum: number, maximum = Number.MAX_SAFE_INTEGER): boolean {
  return (
    typeof value === "number" && Number.isSafeInteger(value) && value >= minimum && value <= maximum
  );
}

function pageError(message: string): Record<string, unknown> {
  return freezePage({
    page: true,
    error: message,
    original_content: message,
    offset: 0,
    limit: DEFAULT_PAGE_CHARS,
    total_chars: message.length,
    truncated: false,
  });
}

function isBoundedPage(data: unknown): data is Record<string, unknown> {
  return (
    isRecord(data) &&
    boundedPages.has(data) &&
    Object.isFrozen(data) &&
    data.page === true &&
    typeof data.original_content === "string" &&
    validInteger(data.offset, 0) &&
    validInteger(data.limit, 1, MAX_PAGE_CHARS) &&
    validInteger(data.total_chars, 0) &&
    data.original_content.length <= (data.limit as number) &&
    typeof data.truncated === "boolean" &&
    (data.next_offset === undefined || validInteger(data.next_offset, 0)) &&
    (data.query === undefined ||
      (typeof data.query === "string" && data.query.length <= MAX_QUERY_CHARS)) &&
    (data.error === undefined ||
      data.error === null ||
      typeof data.error === "boolean" ||
      typeof data.error === "number" ||
      (typeof data.error === "string" && data.error.length <= MAX_PAGE_CHARS))
  );
}

function retrievalText(data: unknown): string {
  if (!isRecord(data)) return String(data ?? "");
  if (typeof data.original_content === "string") return data.original_content;
  if (typeof data.raw === "string") return data.raw;
  if (Array.isArray(data.results)) return JSON.stringify(data.results, null, 2);
  return JSON.stringify(data, null, 2);
}

function lowSurrogateAt(text: string, index: number): boolean {
  const code = text.charCodeAt(index);
  return code >= 0xdc00 && code <= 0xdfff;
}

function highSurrogateAt(text: string, index: number): boolean {
  const code = text.charCodeAt(index);
  return code >= 0xd800 && code <= 0xdbff;
}

/** Bound output in UTF-16 characters; query offsets address the numbered, filtered view. */
export function paginateRetrieveResult(
  data: unknown,
  options: RetrievalPageOptions = {},
): Record<string, unknown> {
  if (isBoundedPage(data)) return data;
  const offset = options.offset ?? 0;
  const limit = options.limit ?? DEFAULT_PAGE_CHARS;
  const query = options.query;
  if (!validInteger(offset, 0)) return pageError("Retrieval offset must be a nonnegative integer.");
  if (!validInteger(limit, 1, MAX_PAGE_CHARS)) {
    return pageError(`Retrieval limit must be an integer from 1 to ${MAX_PAGE_CHARS}.`);
  }
  if (query !== undefined && (typeof query !== "string" || query.length > MAX_QUERY_CHARS)) {
    return pageError(`Retrieval query must be a string of at most ${MAX_QUERY_CHARS} characters.`);
  }
  let body: string;
  try {
    body = retrievalText(data);
  } catch {
    return pageError("Unable to render the retrieval result as text.");
  }
  let matchedLines: number | undefined;
  if (query) {
    const needle = query.toLowerCase();
    const lines = body.split("\n");
    const matches: string[] = [];
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index].replace(/\r$/, "");
      if (line.toLowerCase().includes(needle)) matches.push(`${index + 1}: ${line}`);
    }
    matchedLines = matches.length;
    body = matches.join("\n");
  }
  let start = Math.min(offset, body.length);
  if (start > 0 && lowSurrogateAt(body, start) && highSurrogateAt(body, start - 1)) start -= 1;
  let end = Math.min(start + limit, body.length);
  if (end > start && highSurrogateAt(body, end - 1) && lowSurrogateAt(body, end)) end -= 1;
  if (end === start && start < body.length) {
    return pageError(
      "Retrieval limit is too small for the next Unicode character; use at least 2.",
    );
  }
  const result: Record<string, unknown> = {
    page: true,
    original_content: body.slice(start, end),
    offset: start,
    limit,
    total_chars: body.length,
    truncated: end < body.length,
  };
  if (result.truncated) result.next_offset = end;
  if (query) {
    result.query = query;
    result.matched_lines = matchedLines;
  }
  if (isRecord(data) && data.error !== undefined) {
    const error = data.error;
    result.error =
      error === null || typeof error === "boolean" || typeof error === "number"
        ? error
        : String(error).slice(0, MAX_PAGE_CHARS);
  }
  return freezePage(result);
}

export function stringifyRetrieveResult(
  data: unknown,
  hash: string,
  fallback = false,
  options: RetrievalPageOptions = {},
): string {
  const page = isBoundedPage(data) ? data : paginateRetrieveResult(data, options);
  const body = page.original_content as string;
  const key = String(hash || "?").slice(0, 128);
  const note = fallback ? "; local fallback" : "";
  const lines = [
    `${RETRIEVED_MARKER}hash=${key}${note}; original content — do not re-compress]`,
    `Characters ${page.offset}–${Number(page.offset) + body.length} of ${page.total_chars} (limit ${page.limit}).`,
  ];
  if (page.query) {
    lines.push(
      `Literal line filter ${JSON.stringify(page.query)}: ${page.matched_lines} matched lines; offsets index this filtered view.`,
    );
  }
  lines.push(body);
  if (page.truncated) {
    lines.push(
      `More: headroom_retrieve hash=${key} offset=${page.next_offset} limit=${page.limit}${page.query ? ` query=${JSON.stringify(page.query)}` : ""}`,
    );
  }
  return lines.join("\n");
}
