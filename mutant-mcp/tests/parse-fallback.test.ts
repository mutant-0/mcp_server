import { afterEach, describe, expect, it, vi } from "vitest";
import { parseDnaFile } from "../src/ui/dna-import/parseFile.js";
import { fakeFile } from "./genomics-fixtures.js";

/**
 * Worker startup, handshake, and fallback behaviour.
 *
 * The component must never *require* a worker: MCP Apps resources cannot declare
 * a `worker-src` CSP directive, so a host is free to block the `blob:` script
 * while still letting `new Worker()` succeed. These tests pin every way that can
 * go wrong to "parse on the main thread instead" - except a failure *after* the
 * worker has produced output, which must surface as an error rather than silently
 * re-parsing from zero.
 */

/** How the fake worker misbehaves, if at all. */
type Script =
  | { kind: "happy" }
  | { kind: "ready-then-silent" }
  | { kind: "silent" }
  | { kind: "constructor-throws" }
  | { kind: "errors-while-starting" }
  | { kind: "errors-after-progress" }
  | { kind: "postMessage-throws" };

/** What the worker would return, if a real one were running. */
const WORKER_RESULT = {
  supported: true,
  snps: { rs328: "AA" },
  wgsVariantCalls: {},
  provider: "23andMe",
  providerLabel: "23andMe",
  genomeBuild: null,
  fileName: "worker.txt",
  fileSizeBytes: 42,
  coverage: { matched: 1, total: 3 },
  totalLines: 7,
};

const CATALOG = {
  version: 1,
  snp_count: 1,
  snps: {
    rs328: {
      rsID: "rs328",
      chromosome: "8",
      position_GRCh37: 19819724,
      position_GRCh38: 19962213,
      risk_allele: "A",
    },
  },
};

/** A readable microarray file, so the main-thread fallback can actually succeed. */
function readableFile(): File {
  return fakeFile(
    "23andme.txt",
    ["# rsid\tchromosome\tposition\tgenotype", "rs328\t8\t19819724\tAA", ""].join("\n"),
  );
}

/**
 * A file that throws the moment it is read. Used to prove the main thread was
 * never used: a fallback would reject instead of resolving with the worker result.
 */
function unreadableFile(): File {
  const explode = () => {
    throw new Error("the main thread must not parse in this case");
  };
  return { name: "worker.txt", size: 42, slice: explode, stream: explode } as unknown as File;
}

interface FakeWorkerState {
  url: string;
  terminated: boolean;
  posted: Array<{ jobId: string }>;
}

interface Harness {
  states: FakeWorkerState[];
  attempts: string[];
  createdUrls: string[];
  revokedUrls: string[];
}

// The component assigns `worker.onmessage` / `worker.onerror` directly, so the
// fake exposes them as plain writable fields, exactly like the DOM interface.
type MessageEventLike = {
  data: { type?: string; jobId?: string; progress?: number; result?: unknown; protocol?: number };
};
type ErrorEventLike = { message?: string };

/** Install a fake `Worker` plus object-URL spies, and return their bookkeeping. */
function installWorker(script: Script): Harness {
  const harness: Harness = { states: [], attempts: [], createdUrls: [], revokedUrls: [] };

  // Every script that is meant to get past startup announces itself, exactly as
  // the real worker does from the top of its own bundle.
  const announcesReady = script.kind !== "silent" && script.kind !== "errors-while-starting";

  class FakeWorker {
    onmessage: ((event: MessageEventLike) => void) | null = null;
    onerror: ((event: ErrorEventLike) => void) | null = null;
    readonly state: FakeWorkerState;
    private readonly listeners = new Map<string, Set<(event: never) => void>>();

    constructor(url: string) {
      harness.attempts.push(url);
      if (script.kind === "constructor-throws") {
        throw new TypeError("Worker construction is not allowed here");
      }
      this.state = { url, terminated: false, posted: [] };
      harness.states.push(this.state);

      if (announcesReady) {
        queueMicrotask(() => this.emit("message", { data: { type: "ready", protocol: 1 } }));
      }
      if (script.kind === "errors-while-starting") {
        queueMicrotask(() => this.emit("error", { message: "blocked by the host's CSP" }));
      }
    }

    addEventListener(type: string, listener: (event: never) => void): void {
      if (!this.listeners.has(type)) this.listeners.set(type, new Set());
      this.listeners.get(type)!.add(listener);
    }

    removeEventListener(type: string, listener: (event: never) => void): void {
      this.listeners.get(type)?.delete(listener);
    }

    private emit(type: "message", event: MessageEventLike): void;
    private emit(type: "error", event: ErrorEventLike): void;
    private emit(type: "message" | "error", event: MessageEventLike | ErrorEventLike): void {
      if (this.state.terminated) return;
      for (const listener of this.listeners.get(type) ?? []) listener(event as never);
      if (type === "message") this.onmessage?.(event as MessageEventLike);
      else this.onerror?.(event as ErrorEventLike);
    }

    postMessage(message: { jobId: string }): void {
      if (script.kind === "postMessage-throws") {
        throw new Error("DataCloneError: the file could not be cloned");
      }
      this.state.posted.push(message);

      if (script.kind === "happy") {
        queueMicrotask(() => {
          this.emit("message", { data: { type: "progress", jobId: message.jobId, progress: 50 } });
          this.emit("message", {
            data: { type: "result", jobId: message.jobId, result: WORKER_RESULT },
          });
        });
      }
      if (script.kind === "errors-after-progress") {
        queueMicrotask(() => {
          this.emit("message", { data: { type: "progress", jobId: message.jobId, progress: 50 } });
          this.emit("error", { message: "worker died mid-parse" });
        });
      }
    }

    terminate(): void {
      this.state.terminated = true;
    }
  }

  (globalThis as Record<string, unknown>).Worker = FakeWorker;
  vi.spyOn(URL, "createObjectURL").mockImplementation((obj: Blob | MediaSource) => {
    const url = `blob:test/${harness.createdUrls.length}/${(obj as Blob).type}`;
    harness.createdUrls.push(url);
    return url;
  });
  vi.spyOn(URL, "revokeObjectURL").mockImplementation((url: string) => {
    harness.revokedUrls.push(url);
  });

  return harness;
}

afterEach(() => {
  vi.restoreAllMocks();
  delete (globalThis as Record<string, unknown>).Worker;
});

describe("parseDnaFile worker startup", () => {
  it("uses the worker once it completes the handshake", async () => {
    const fake = installWorker({ kind: "happy" });

    // The file cannot be read here, so a fallback would reject.
    const result = await parseDnaFile(unreadableFile(), { catalog: CATALOG });

    expect(result).toEqual(WORKER_RESULT);
    expect(fake.attempts).toHaveLength(1);
    expect(fake.states[0]?.posted).toHaveLength(1);
    // The object URL is revoked once the script has been fetched, and the worker
    // is terminated so a finished parse cannot leak a thread.
    expect(fake.revokedUrls).toEqual(fake.createdUrls);
    expect(fake.states[0]?.terminated).toBe(true);
  });

  it("forwards worker progress to the caller", async () => {
    installWorker({ kind: "happy" });
    const progress: number[] = [];
    await parseDnaFile(unreadableFile(), {
      catalog: CATALOG,
      onProgress: (percent) => progress.push(percent),
    });
    expect(progress).toEqual([50]);
  });

  it("falls back to the main thread when construction is rejected", async () => {
    const fake = installWorker({ kind: "constructor-throws" });

    const result = await parseDnaFile(readableFile(), { catalog: CATALOG });

    expect(result).toMatchObject({ supported: true, snps: { rs328: "AA" } });
    expect(fake.attempts).toHaveLength(1);
    // Nothing to terminate, but the URL must not be leaked.
    expect(fake.revokedUrls).toEqual(fake.createdUrls);
  });

  it("falls back when the worker errors before it is ready", async () => {
    const fake = installWorker({ kind: "errors-while-starting" });

    const result = await parseDnaFile(readableFile(), { catalog: CATALOG });

    expect(result).toMatchObject({ supported: true, snps: { rs328: "AA" } });
    expect(fake.states[0]?.terminated).toBe(true);
    expect(fake.revokedUrls).toEqual(fake.createdUrls);
  });

  it("falls back when the worker never completes its handshake", async () => {
    // Construction succeeding is not evidence that the script ran: a CSP-blocked
    // worker stays silent forever. This is the only case that pays the timeout.
    const fake = installWorker({ kind: "silent" });

    const result = await parseDnaFile(readableFile(), { catalog: CATALOG });

    expect(result).toMatchObject({ supported: true, snps: { rs328: "AA" } });
    expect(fake.states[0]?.terminated).toBe(true);
    expect(fake.revokedUrls).toEqual(fake.createdUrls);
  }, 10_000);

  it("falls back when the file cannot be posted to the worker", async () => {
    const fake = installWorker({ kind: "postMessage-throws" });

    const result = await parseDnaFile(readableFile(), { catalog: CATALOG });

    expect(result).toMatchObject({ supported: true, snps: { rs328: "AA" } });
    expect(fake.states[0]?.terminated).toBe(true);
  });

  it("surfaces a failure that happens after the worker started working", async () => {
    installWorker({ kind: "errors-after-progress" });
    const progress: number[] = [];
    const pending = parseDnaFile(readableFile(), {
      catalog: CATALOG,
      onProgress: (percent) => progress.push(percent),
    });

    await expect(pending).rejects.toThrow(/worker died mid-parse/);
    // A re-parse on the main thread would have registered its own progress and
    // resolved instead of rejecting.
    expect(progress).toEqual([50]);
  });

  it("parses on the main thread when the host has no Worker at all", async () => {
    const created = vi.spyOn(URL, "createObjectURL");

    const result = await parseDnaFile(readableFile(), { catalog: CATALOG });

    expect(result).toMatchObject({ supported: true, snps: { rs328: "AA" } });
    expect(created).not.toHaveBeenCalled();
  });

  it("rejects an already-aborted signal without starting a worker", async () => {
    const fake = installWorker({ kind: "happy" });
    const controller = new AbortController();
    controller.abort();

    await expect(
      parseDnaFile(readableFile(), { catalog: CATALOG, signal: controller.signal }),
    ).rejects.toThrow(/Aborted/);
    expect(fake.attempts).toHaveLength(0);
  });

  it("terminates a starting worker when the signal aborts", async () => {
    const fake = installWorker({ kind: "silent" });
    const controller = new AbortController();
    const pending = parseDnaFile(readableFile(), {
      catalog: CATALOG,
      signal: controller.signal,
    });

    controller.abort();

    await expect(pending).rejects.toThrow(/Aborted/);
    expect(fake.states[0]?.terminated).toBe(true);
    // Revoked, not leaked, and the handshake listener is detached.
    expect(fake.revokedUrls).toEqual(fake.createdUrls);
  });

  it("terminates the worker when the signal aborts mid-parse", async () => {
    const fake = installWorker({ kind: "ready-then-silent" });
    const controller = new AbortController();
    const pending = parseDnaFile(readableFile(), {
      catalog: CATALOG,
      signal: controller.signal,
    });

    // Wait until the worker is ready and the parse it accepted is in flight.
    await vi.waitFor(() => expect(fake.states[0]?.posted).toHaveLength(1));

    controller.abort();

    await expect(pending).rejects.toThrow(/Aborted/);
    expect(fake.states[0]?.terminated).toBe(true);
  });
});
