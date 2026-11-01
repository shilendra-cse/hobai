import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { Histogram } from "./histogram.js";
import { startLatencyProxy, type LatencyProxy } from "./latency-proxy.js";

describe("Histogram", () => {
  it("gives percentiles to the millisecond", () => {
    const histogram = new Histogram();
    for (let ms = 1; ms <= 100; ms++) histogram.add(ms);

    expect(histogram.count).toBe(100);
    expect(histogram.percentile(50)).toBe(50);
    expect(histogram.percentile(99)).toBe(99);
    expect(histogram.max).toBe(100);
  });

  it("starts over after a reset", () => {
    const histogram = new Histogram();
    histogram.add(500);
    histogram.reset();

    expect(histogram.count).toBe(0);
    expect(histogram.percentile(99)).toBe(0);
  });
});

describe("latency proxy", () => {
  let proxy: LatencyProxy | undefined;
  let echo: net.Server | undefined;
  afterEach(async () => {
    await proxy?.close();
    await new Promise((resolve) => echo?.close(resolve) ?? resolve(null));
  });

  it("delays a round trip by its delay each way, keeping the bytes in order", async () => {
    echo = net.createServer((socket) => socket.pipe(socket));
    await new Promise<void>((resolve) => echo!.listen(0, "127.0.0.1", resolve));
    const address = echo.address();
    if (!address || typeof address === "string") throw new Error("no port");
    proxy = await startLatencyProxy({
      target: { host: "127.0.0.1", port: address.port },
      delayMs: 40,
    });

    const client = net.connect({ host: "127.0.0.1", port: proxy.port });
    await new Promise<void>((resolve) => client.once("connect", resolve));
    const started = Date.now();
    const reply = new Promise<string>((resolve) => {
      let text = "";
      client.on("data", (chunk) => {
        text += chunk.toString();
        if (text.length >= 6) resolve(text);
      });
    });
    client.write("abc");
    client.write("def");

    expect(await reply).toBe("abcdef");
    expect(Date.now() - started).toBeGreaterThanOrEqual(75);
    client.destroy();
  });
});
