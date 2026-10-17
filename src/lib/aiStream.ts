// Workers AI streams OpenAI-style chunks that *also* repeat the payload in the
// legacy native fields:
//
//   { "choices": [{ "delta": { "content": "Hello" } }], "response": "Hello", "tool_calls": [] }
//
// workers-ai-provider (3.3.x and 4.0) emits a delta for both copies, so every
// token shows up twice ("MoreMore information information") and tool-call
// arguments are concatenated twice into invalid JSON. Dropping the native
// copies whenever `choices` is present leaves exactly one source of truth.

/** Strips the duplicated native fields from one SSE `data:` payload. */
export function dedupeSseData(data: string): string {
  if (!data.startsWith("{")) return data;
  let chunk: Record<string, unknown>;
  try {
    chunk = JSON.parse(data);
  } catch {
    return data;
  }
  if (!Array.isArray(chunk.choices)) return data;
  delete chunk.response;
  delete chunk.tool_calls;
  return JSON.stringify(chunk);
}

/** Byte-level SSE transform applying {@link dedupeSseData} line by line. */
export function dedupeSseStream(): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  const rewrite = (line: string) =>
    line.startsWith("data: ") ? `data: ${dedupeSseData(line.slice(6))}` : line;

  return new TransformStream({
    transform(bytes, controller) {
      buffer += decoder.decode(bytes, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      if (lines.length > 0)
        controller.enqueue(
          encoder.encode(lines.map(rewrite).join("\n") + "\n")
        );
    },
    flush(controller) {
      buffer += decoder.decode();
      if (buffer) controller.enqueue(encoder.encode(rewrite(buffer)));
    }
  });
}

/** Wraps the AI binding so streamed `run()` results are deduplicated. */
export function withDedupedStreams(ai: Ai): Ai {
  return new Proxy(ai, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target);
      if (prop !== "run") {
        return typeof value === "function" ? value.bind(target) : value;
      }
      return async (...args: Parameters<Ai["run"]>) => {
        const result: unknown = await target.run(...args);
        return result instanceof ReadableStream
          ? result.pipeThrough(dedupeSseStream())
          : result;
      };
    }
  });
}
