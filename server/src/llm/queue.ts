export type Priority = "interactive" | "background";

export interface Job {
  /** Jobs with the same key are deduplicated while pending. */
  key: string;
  run: (signal: AbortSignal) => Promise<void>;
  onError?: (err: Error) => void;
}

/**
 * LLM worker queue. Concurrency 1 (one GPU job at a time); interactive work (Explain
 * flow, chat) always runs before background card summaries. Each job gets a timeout.
 */
export class LlmQueue {
  private interactive: Job[] = [];
  private background: Job[] = [];
  private running: Job | null = null;
  private paused = false;
  private wake: (() => void) | null = null;
  onChange?: () => void;

  constructor(private timeoutMs = 60_000) {
    void this.loop();
  }

  get pending() {
    return this.interactive.length + this.background.length;
  }

  get size() {
    return this.pending + (this.running ? 1 : 0);
  }

  has(key: string) {
    return this.running?.key === key || [...this.interactive, ...this.background].some((j) => j.key === key);
  }

  enqueue(job: Job, priority: Priority) {
    if (this.has(job.key)) return false;
    (priority === "interactive" ? this.interactive : this.background).push(job);
    this.onChange?.();
    this.kick();
    return true;
  }

  /** Drops pending background jobs (e.g. when the user switches entry files). */
  clearBackground(keep?: (key: string) => boolean) {
    const before = this.background.length;
    this.background = keep ? this.background.filter((j) => keep(j.key)) : [];
    if (before !== this.background.length) this.onChange?.();
  }

  /** While paused (model unavailable), jobs stay queued and resume on unpause. */
  setPaused(paused: boolean) {
    this.paused = paused;
    if (!paused) this.kick();
  }

  private kick() {
    this.wake?.();
    this.wake = null;
  }

  private async loop() {
    for (;;) {
      const job = this.paused ? undefined : (this.interactive.shift() ?? this.background.shift());
      if (!job) {
        await new Promise<void>((r) => {
          this.wake = r;
        });
        continue;
      }
      this.running = job;
      this.onChange?.();
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
      let failure: Error | null = null;
      try {
        await job.run(ctrl.signal);
      } catch (err) {
        failure = ctrl.signal.aborted ? new Error(`Timed out after ${Math.round(this.timeoutMs / 1000)}s`) : (err as Error);
      } finally {
        clearTimeout(timer);
        this.running = null;
      }
      // Run the error handler after the job is no longer "running", so a handler can
      // re-enqueue the same job (retry) without being rejected as a duplicate.
      if (failure) {
        try {
          job.onError?.(failure);
        } catch {
          // error handlers must not kill the worker
        }
      }
      this.onChange?.();
    }
  }
}
