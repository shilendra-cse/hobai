import { describe, expect, it } from "vitest";
import { tryWithRetries } from "./retry.js";

const noAnswer = () => new Error("timeout exceeded when trying to connect");
const refused = () => Object.assign(new Error("refused"), { code: "23503" });

describe("tryWithRetries", () => {
  it("retries what passes until it works", async () => {
    let calls = 0;
    let retries = 0;
    const error = await tryWithRetries(
      async () => {
        if (++calls < 3) throw noAnswer();
      },
      { retryForMs: 1_000, firstRetryMs: 1, onRetry: () => retries++ },
    );
    expect(error).toBeNull();
    expect([calls, retries]).toEqual([3, 2]);
  });

  it("stops at once on an error that won't pass", async () => {
    let calls = 0;
    const error = await tryWithRetries(
      async () => {
        calls += 1;
        throw refused();
      },
      { retryForMs: 1_000, firstRetryMs: 1 },
    );
    expect(error).toMatchObject({ code: "23503" });
    expect(calls).toBe(1);
  });

  it("gives up after its time", async () => {
    const error = await tryWithRetries(
      async () => {
        throw noAnswer();
      },
      { retryForMs: 20, firstRetryMs: 5 },
    );
    expect(String(error)).toContain("timeout exceeded");
  });
});
