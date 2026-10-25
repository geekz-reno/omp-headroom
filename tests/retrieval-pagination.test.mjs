import { describe, expect, test } from "bun:test";
import { paginateRetrieveResult, stringifyRetrieveResult } from "../src/tools.ts";

describe("bounded retrieval", () => {
  test("defaults to 12000 characters and supplies continuation offsets", () => {
    const source = "a".repeat(30_000);
    const page = paginateRetrieveResult({ original_content: source });
    expect(page).toMatchObject({
      page: true,
      original_content: source.slice(0, 12_000),
      offset: 0,
      limit: 12_000,
      total_chars: 30_000,
      next_offset: 12_000,
      truncated: true,
    });
    expect(Object.isFrozen(page)).toBe(true);
    expect(paginateRetrieveResult({ original_content: source }, { offset: 24_000 })).toMatchObject({
      original_content: source.slice(24_000),
      offset: 24_000,
      total_chars: 30_000,
      truncated: false,
    });
  });

  test("supports the maximum page size and rejects oversized limits", () => {
    const source = "a".repeat(100_000);
    expect(paginateRetrieveResult(source, { limit: 32_000 }).original_content.length).toBe(32_000);
    expect(paginateRetrieveResult(source, { limit: 32_001 }).error).toContain("32000");
  });

  test("validates offsets and limits without coercing fractional or non-finite values", () => {
    for (const offset of [-1, 1.5, NaN, Infinity, "0"]) {
      expect(paginateRetrieveResult("original", { offset }).error).toContain("offset");
    }
    for (const limit of [0, -1, 1.5, NaN, Infinity, "10"]) {
      expect(paginateRetrieveResult("original", { limit }).error).toContain("limit");
    }
    expect(paginateRetrieveResult("abc", { offset: 100 })).toMatchObject({
      original_content: "",
      offset: 3,
      total_chars: 3,
      truncated: false,
    });
  });

  test("uses literal case-insensitive line filtering with source line numbers", () => {
    const source = "Alpha\r\nfind .* HERE\r\nno match\r\nFind .* again";
    expect(paginateRetrieveResult({ original_content: source }, { query: ".*" })).toMatchObject({
      original_content: "2: find .* HERE\n4: Find .* again",
      matched_lines: 2,
      query: ".*",
      truncated: false,
    });
    expect(paginateRetrieveResult(source, { query: "FIND" }).matched_lines).toBe(2);
    expect(paginateRetrieveResult(source, { query: "absent" })).toMatchObject({
      original_content: "",
      matched_lines: 0,
      total_chars: 0,
      truncated: false,
    });
    expect(paginateRetrieveResult(source, { query: "" }).original_content).toBe(source);
  });

  test("offsets paginate the filtered view rather than original text", () => {
    const source = "ignored\nneedle one\nignored\nneedle two";
    const first = paginateRetrieveResult(source, { query: "needle", limit: 8 });
    const second = paginateRetrieveResult(source, {
      query: "needle",
      offset: first.next_offset,
      limit: 32,
    });
    expect(first.original_content + second.original_content).toBe("2: needle one\n4: needle two");
    expect(second.matched_lines).toBe(2);
  });

  test("picks raw text and result arrays and handles empty originals", () => {
    expect(paginateRetrieveResult({ raw: "raw transport response" }).original_content).toBe(
      "raw transport response",
    );
    expect(paginateRetrieveResult({ results: [{ text: "found" }] }).original_content).toBe(
      JSON.stringify([{ text: "found" }], null, 2),
    );
    expect(paginateRetrieveResult({ original_content: "" })).toMatchObject({
      original_content: "",
      total_chars: 0,
      truncated: false,
    });
    expect(paginateRetrieveResult(null).original_content).toBe("");
  });

  test("preserves error status while bounding error and output text", () => {
    const result = paginateRetrieveResult({ error: "not found", hash: "abcdef0123456789" });
    expect(result.error).toBe("not found");
    expect(result.original_content).toContain("not found");
    const large = paginateRetrieveResult({ error: "e".repeat(100_000) }, { limit: 20 });
    expect(large.error.length).toBeLessThanOrEqual(32_000);
    expect(large.original_content.length).toBeLessThanOrEqual(20);
    expect(paginateRetrieveResult({ error: false }).error).toBe(false);
  });

  test("does not split surrogate pairs or lose text across continuation pages", () => {
    const source = "A😀B😀C😀D";
    let offset = 0;
    let combined = "";
    for (let count = 0; count < 20; count++) {
      const page = paginateRetrieveResult(source, { offset, limit: 3 });
      expect(page.original_content.length).toBeLessThanOrEqual(3);
      expect(page.original_content.isWellFormed()).toBe(true);
      combined += page.original_content;
      if (!page.truncated) break;
      expect(page.next_offset).toBeGreaterThan(offset);
      offset = page.next_offset;
    }
    expect(combined).toBe(source);
    expect(paginateRetrieveResult("😀", { limit: 1 }).error).toContain("at least 2");
    expect(paginateRetrieveResult("A😀B", { offset: 2, limit: 2 })).toMatchObject({
      offset: 1,
      original_content: "😀",
      next_offset: 3,
    });
  });

  test("renders a bounded continuation with the legacy fallback signature", () => {
    const rendered = stringifyRetrieveResult(
      { original_content: "a".repeat(30_000) },
      "hash12345",
      true,
    );
    expect(rendered).toContain("local fallback");
    expect(rendered).not.toContain("full original");
    expect(rendered).toContain("headroom_retrieve hash=hash12345 offset=12000 limit=12000");
    expect(rendered.length).toBeLessThan(12_400);
    expect(rendered).toContain("do not re-compress");
  });

  test("does not filter or offset an already paginated result twice", () => {
    const source = "ignored\nneedle one\nneedle two\nignored";
    const options = { query: "needle", offset: 5, limit: 8 };
    const page = paginateRetrieveResult(source, options);
    const rendered = stringifyRetrieveResult(page, "hash12345", true);
    expect(rendered).toContain(page.original_content);
    expect(rendered).toContain("offsets index this filtered view");
    expect(rendered).toContain('query="needle"');
    expect(paginateRetrieveResult(page)).toBe(page);
  });

  test("never trusts an unbounded or mutable page-shaped proxy response", () => {
    const malformed = {
      page: true,
      original_content: "a".repeat(100_000),
      limit: 120_000,
      offset: 0,
      total_chars: 100_000,
      truncated: false,
    };
    expect(paginateRetrieveResult(Object.freeze(malformed)).original_content.length).toBe(12_000);
    expect(stringifyRetrieveResult(malformed, "h".repeat(100_000)).length).toBeLessThan(12_600);
    const disguised = Object.freeze({
      page: true,
      original_content: "safe excerpt",
      offset: 0,
      limit: 12_000,
      total_chars: 12,
      truncated: false,
      raw: "unbounded extra metadata ".repeat(10_000),
    });
    expect(paginateRetrieveResult(disguised).raw).toBeUndefined();
    expect(paginateRetrieveResult("text", { query: "q".repeat(2_000) }).error).toContain("query");
    const circular = {};
    circular.self = circular;
    expect(paginateRetrieveResult(circular).error).toContain("Unable to render");
  });
});
