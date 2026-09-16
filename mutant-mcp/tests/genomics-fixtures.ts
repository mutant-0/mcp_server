import { strToU8 } from "fflate";

/**
 * Test double for a browser `File`.
 *
 * Matches the surface the vendored `stream.js` uses (`size`, `slice().arrayBuffer()`,
 * `stream()`), so the real streaming reader, gzip sniffing, and decoding run.
 * `supportsStreaming()` only checks the global `File`, so Node's own `File` is
 * irrelevant here: the object is passed straight to the parser.
 */
export function fakeFile(name: string, bytes: string | Uint8Array): File {
  const data = bytes instanceof Uint8Array ? bytes : strToU8(bytes);
  return {
    name,
    size: data.length,
    slice: (start: number, end: number) => ({
      arrayBuffer: async () => data.slice(start, end).buffer,
    }),
    stream: () =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(data);
          controller.close();
        },
      }),
  } as unknown as File;
}

export function concatBytes(...arrays: Uint8Array[]): Uint8Array {
  const total = arrays.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of arrays) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}
