"use strict";

const PHASES = Object.freeze(["idle", "starting", "ready", "backoff", "crash-loop", "stopping", "stopped"]);

function positiveInteger(value, field, maximum = 86_400_000) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new TypeError(`${field} is invalid`);
  return value;
}

function childPid(child) {
  return Number.isSafeInteger(child?.pid) && child.pid > 0 ? child.pid : null;
}

function isChildProcessLike(child) {
  return Boolean(child && typeof child === "object"
    && typeof child.once === "function"
    && typeof child.off === "function");
}

class ServiceSupervisor {
  #launch;
  #terminate;
  #onState;
  #now;
  #setTimer;
  #clearTimer;
  #maxRestarts;
  #crashWindowMs;
  #backoffBaseMs;
  #backoffCapMs;
  #phase = "idle";
  #generation = 0;
  #restartCount = 0;
  #restartDelayMs = null;
  #child = null;
  #timer = null;
  #desired = false;
  #crashes = [];
  #startPromise = null;
  #resolveStart = null;
  #rejectStart = null;
  #shutdownPromise = null;

  constructor(options) {
    if (!options || typeof options !== "object" || Array.isArray(options)) throw new TypeError("Service supervisor options are invalid");
    if (typeof options.launch !== "function") throw new TypeError("Service launch callback is required");
    if (typeof options.terminate !== "function") throw new TypeError("Service terminate callback is required");
    this.#launch = options.launch;
    this.#terminate = options.terminate;
    this.#onState = typeof options.onState === "function" ? options.onState : () => undefined;
    this.#now = typeof options.now === "function" ? options.now : Date.now;
    this.#setTimer = typeof options.setTimer === "function" ? options.setTimer : setTimeout;
    this.#clearTimer = typeof options.clearTimer === "function" ? options.clearTimer : clearTimeout;
    this.#maxRestarts = positiveInteger(options.maxRestarts ?? 5, "maxRestarts", 100);
    this.#crashWindowMs = positiveInteger(options.crashWindowMs ?? 60_000, "crashWindowMs");
    this.#backoffBaseMs = positiveInteger(options.backoffBaseMs ?? 500, "backoffBaseMs");
    this.#backoffCapMs = positiveInteger(options.backoffCapMs ?? 30_000, "backoffCapMs");
    if (this.#backoffBaseMs > this.#backoffCapMs) throw new TypeError("Service backoff range is invalid");
    this.#emitState();
  }

  snapshot() {
    return Object.freeze({
      phase: this.#phase,
      generation: this.#generation,
      restartCount: this.#restartCount,
      restartDelayMs: this.#restartDelayMs,
      pid: childPid(this.#child),
    });
  }

  start() {
    if (this.#phase === "ready") return Promise.resolve(this.snapshot());
    if (this.#startPromise) return this.#startPromise;
    if (this.#phase === "stopping") return Promise.reject(new Error("Service supervisor is stopping"));
    this.#desired = true;
    this.#shutdownPromise = null;
    this.#startPromise = new Promise((resolve, reject) => {
      this.#resolveStart = resolve;
      this.#rejectStart = reject;
    });
    void this.#launchNext();
    return this.#startPromise;
  }

  restart(reason = "health-check-failed") {
    const child = this.#child;
    if (!this.#desired || this.#phase !== "ready" || !child) return Promise.resolve(false);
    return Promise.resolve(this.#terminate(child, reason)).then(() => true);
  }

  shutdown() {
    if (this.#shutdownPromise) return this.#shutdownPromise;
    this.#shutdownPromise = this.#stop();
    return this.#shutdownPromise;
  }

  async #launchNext() {
    if (!this.#desired) return;
    this.#timer = null;
    this.#restartDelayMs = null;
    this.#phase = "starting";
    this.#generation += 1;
    const generation = this.#generation;
    this.#emitState();
    try {
      const child = await this.#launch(Object.freeze({ generation }));
      if (!isChildProcessLike(child)) throw new TypeError("Service launch did not return a child process");
      if (!this.#desired || generation !== this.#generation) {
        await this.#terminate(child, "stale-launch");
        return;
      }
      this.#child = child;
      const onExit = (code, signal) => this.#handleExit(child, generation, code, signal);
      child.once("exit", onExit);
      if (child.exitCode !== null || child.signalCode !== null) {
        child.off("exit", onExit);
        this.#handleExit(child, generation, child.exitCode, child.signalCode);
        return;
      }
      this.#phase = "ready";
      this.#restartDelayMs = null;
      this.#emitState();
      const resolve = this.#resolveStart;
      this.#clearStartPromise();
      resolve?.(this.snapshot());
    } catch (error) {
      if (!this.#desired || generation !== this.#generation) return;
      this.#scheduleRestart("launch-failed", error);
    }
  }

  #handleExit(child, generation, code, signal) {
    if (child !== this.#child || generation !== this.#generation) return;
    this.#child = null;
    if (!this.#desired || this.#phase === "stopping" || this.#phase === "stopped") {
      this.#phase = "stopped";
      this.#emitState();
      return;
    }
    const failure = code === 0 && signal === null ? "unexpected-clean-exit" : "unexpected-exit";
    this.#scheduleRestart(failure);
  }

  #scheduleRestart(failure, error = null) {
    const now = this.#now();
    this.#crashes = this.#crashes.filter(timestamp => now - timestamp <= this.#crashWindowMs);
    this.#crashes.push(now);
    this.#restartCount = this.#crashes.length;
    if (this.#restartCount > this.#maxRestarts) {
      this.#desired = false;
      this.#phase = "crash-loop";
      this.#restartDelayMs = null;
      this.#emitState(failure);
      const reject = this.#rejectStart;
      this.#clearStartPromise();
      reject?.(error instanceof Error ? error : new Error("Service entered crash-loop state"));
      return;
    }
    const exponent = Math.max(0, this.#restartCount - 1);
    this.#restartDelayMs = Math.min(this.#backoffCapMs, this.#backoffBaseMs * (2 ** exponent));
    this.#phase = "backoff";
    this.#emitState(failure);
    this.#timer = this.#setTimer(() => {
      this.#timer = null;
      void this.#launchNext();
    }, this.#restartDelayMs);
    this.#timer?.unref?.();
  }

  async #stop() {
    this.#desired = false;
    if (this.#timer !== null) {
      this.#clearTimer(this.#timer);
      this.#timer = null;
    }
    this.#restartDelayMs = null;
    this.#phase = "stopping";
    this.#emitState();
    const reject = this.#rejectStart;
    this.#clearStartPromise();
    reject?.(new Error("Service supervisor stopped before readiness"));
    const child = this.#child;
    this.#child = null;
    if (child) await this.#terminate(child, "shutdown");
    this.#phase = "stopped";
    this.#emitState();
  }

  #clearStartPromise() {
    this.#startPromise = null;
    this.#resolveStart = null;
    this.#rejectStart = null;
  }

  #emitState(failure = null) {
    try {
      this.#onState(Object.freeze({ ...this.snapshot(), failure }));
    } catch {
      // State reporting must not change supervision behavior.
    }
  }
}

module.exports = Object.freeze({ PHASES, ServiceSupervisor });
