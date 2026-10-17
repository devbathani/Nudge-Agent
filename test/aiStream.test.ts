import { describe, expect, it } from "vitest";
import { dedupeSseData, dedupeSseStream } from "../src/lib/aiStream";

// Shapes copied from a real Llama 3.3 stream on Workers AI.
const textChunk = {
  choices: [{ index: 0, delta: { content: "Hello" } }],
  response: "Hello",
  tool_calls: []
};
const toolChunk = {
  choices: [
    {
      index: 0,
      delta: { tool_calls: [{ index: 0, function: { arguments: "03" } }] }
    }
  ],
  tool_calls: [{ arguments: "03" }]
};

async function pipe(parts: string[]): Promise<string> {
  const encoder = new TextEncoder();
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const part of parts) controller.enqueue(encoder.encode(part));
      controller.close();
    }
  });
  return new Response(source.pipeThrough(dedupeSseStream())).text();
}

describe("dedupeSseData", () => {
  it("drops the native copies when OpenAI-style choices are present", () => {
    expect(JSON.parse(dedupeSseData(JSON.stringify(textChunk)))).toEqual({
      choices: textChunk.choices
    });
    expect(JSON.parse(dedupeSseData(JSON.stringify(toolChunk)))).toEqual({
      choices: toolChunk.choices
    });
  });

  it("leaves native-only chunks, [DONE] and junk untouched", () => {
    const native = JSON.stringify({ response: "Hi", tool_calls: [] });
    expect(dedupeSseData(native)).toBe(native);
    expect(dedupeSseData("[DONE]")).toBe("[DONE]");
    expect(dedupeSseData("{not json")).toBe("{not json");
  });
});

describe("dedupeSseStream", () => {
  it("rewrites events split across arbitrary byte boundaries", async () => {
    const raw = `data: ${JSON.stringify(textChunk)}\n\ndata: [DONE]\n\n`;
    const out = await pipe([
      raw.slice(0, 17),
      raw.slice(17, 60),
      raw.slice(60)
    ]);
    expect(out).toBe(
      `data: ${JSON.stringify({ choices: textChunk.choices })}\n\ndata: [DONE]\n\n`
    );
  });

  it("flushes a trailing line without a newline", async () => {
    expect(await pipe(["data: [DONE]"])).toBe("data: [DONE]");
  });
});
