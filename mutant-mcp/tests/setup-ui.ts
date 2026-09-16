/**
 * jsdom gaps the DNA import component depends on.
 *
 * Imported for its side effects before the component is imported, because a
 * couple of these decide which code path the component takes: without a
 * Streams-capable `File`, `supportsStreaming()` is false and every parse test
 * would quietly exercise only the unsupported-client branch.
 */
import { File as NodeFile } from "node:buffer";

// `supportsStreaming()` requires `File.prototype.stream`, which jsdom's Blob/File
// do not implement. Node's do, so the parser runs for real.
if (typeof File === "undefined" || typeof File.prototype.stream !== "function") {
  (globalThis as Record<string, unknown>).File = NodeFile;
}

// React only wraps updates in `act` (and so only flushes them deterministically)
// when it is told it is running under a test.
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

// `useApp` enables auto-resize by default, which constructs a `ResizeObserver`.
// jsdom does not implement one.
if (typeof globalThis.ResizeObserver === "undefined") {
  class NoopResizeObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  (globalThis as Record<string, unknown>).ResizeObserver = NoopResizeObserver;
}

// ext-apps measures the document inside a `requestAnimationFrame` it never
// cancels, so a frame queued just before a test unmounts runs after the app has
// closed and rejects its size notification with "Not connected". jsdom has no
// real layout to measure anyway, so frames are neutralised here. Nothing under
// test depends on them: React's scheduler uses MessageChannel, and
// testing-library waits on timers and MutationObserver.
for (const name of ["requestAnimationFrame", "cancelAnimationFrame"]) {
  Object.defineProperty(globalThis, name, {
    configurable: true,
    writable: true,
    value: name === "requestAnimationFrame" ? () => 0 : () => {},
  });
}

// The component mints one idempotency key per import attempt. Making it
// deterministic keeps the "same key across a retry" assertion readable.
function deterministicUuidFactory(): () => string {
  let sequence = 0;
  return () => `00000000-0000-4000-8000-${String((sequence += 1)).padStart(12, "0")}`;
}

const cryptoObject = globalThis.crypto as (Crypto & { randomUUID?: () => string }) | undefined;
if (cryptoObject && typeof cryptoObject.randomUUID !== "function") {
  Object.defineProperty(cryptoObject, "randomUUID", {
    configurable: true,
    value: deterministicUuidFactory(),
  });
} else if (!cryptoObject) {
  Object.defineProperty(globalThis, "crypto", {
    configurable: true,
    value: { randomUUID: deterministicUuidFactory() },
  });
}
