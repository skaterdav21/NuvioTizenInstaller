// Step-based job runner. The UI renders a job as a checklist:
//   job:update { id, title, status, steps: [{ id, label, status, detail, progress }], result, error }
// status: pending | running | done | skipped | failed | waiting (needs the user, e.g. accept a TV prompt)
"use strict";

let broadcast = () => {};
const jobs = new Map();

function setBroadcaster(fn) {
  broadcast = fn;
}

function snapshot(job) {
  return {
    id: job.id,
    title: job.title,
    status: job.status,
    steps: job.steps.map((step) => ({ ...step })),
    result: job.result || null,
    error: job.error || "",
    startedAt: job.startedAt,
    finishedAt: job.finishedAt || 0
  };
}

function createJob(title, stepDefs) {
  const id = `job-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const job = {
    id,
    title,
    status: "running",
    steps: stepDefs.map((def) => ({ id: def.id, label: def.label, status: "pending", detail: "", progress: null })),
    startedAt: Date.now(),
    cancelled: false,
    logLines: []
  };
  jobs.set(id, job);
  let lastEmit = 0;
  let pending = null;

  const emit = (force = false) => {
    const now = Date.now();
    if (!force && now - lastEmit < 120) {
      if (!pending) pending = setTimeout(() => { pending = null; emit(true); }, 130);
      return;
    }
    lastEmit = now;
    broadcast("job:update", snapshot(job));
  };

  const findStep = (stepId) => {
    const step = job.steps.find((item) => item.id === stepId);
    if (!step) throw new Error(`Unknown step ${stepId}`);
    return step;
  };

  const api = {
    id,
    job,
    log(text, type = "info") {
      job.logLines.push({ t: Date.now(), type, text: String(text) });
      if (job.logLines.length > 2000) job.logLines.shift();
      broadcast("installer:log", { type, text: String(text), jobId: id });
    },
    step(stepId) {
      const step = findStep(stepId);
      return {
        start(detail = "") { step.status = "running"; step.detail = detail; step.progress = null; emit(true); api.log(`▶ ${step.label}${detail ? `: ${detail}` : ""}`); },
        detail(detail) { step.detail = detail; emit(); },
        progress(fraction, detail) {
          step.progress = Math.max(0, Math.min(1, fraction));
          if (detail !== undefined) step.detail = detail;
          emit();
        },
        waiting(detail) { step.status = "waiting"; step.detail = detail; emit(true); api.log(`⏳ ${detail}`); },
        resume(detail = "") { step.status = "running"; step.detail = detail; emit(true); },
        done(detail = "") { step.status = "done"; step.detail = detail; step.progress = null; emit(true); api.log(`✓ ${step.label}${detail ? `: ${detail}` : ""}`, "success"); },
        skip(detail = "") { step.status = "skipped"; step.detail = detail; step.progress = null; emit(true); api.log(`– ${step.label}: ${detail || "skipped"}`); },
        fail(detail = "") { step.status = "failed"; step.detail = detail; step.progress = null; emit(true); api.log(`✗ ${step.label}: ${detail}`, "error"); },
        get status() { return step.status; }
      };
    },
    // Runs fn for a step; marks done/failed. optional=true lets the job continue after a failure.
    async run(stepId, fn, { optional = false } = {}) {
      if (job.cancelled) throw new Error("Cancelled.");
      const step = api.step(stepId);
      step.start();
      try {
        const detail = await fn(step);
        if (step.status === "running" || step.status === "waiting") step.done(typeof detail === "string" ? detail : "");
        return detail;
      } catch (error) {
        step.fail(error?.message || String(error));
        if (!optional) throw error;
        return null;
      }
    },
    finish(result) {
      job.status = "done";
      job.result = result || null;
      job.finishedAt = Date.now();
      for (const step of job.steps) if (step.status === "pending") step.status = "skipped";
      emit(true);
    },
    fail(error) {
      job.status = "failed";
      job.error = error?.message || String(error);
      job.finishedAt = Date.now();
      for (const step of job.steps) if (step.status === "pending") step.status = "skipped";
      emit(true);
    },
    get cancelled() { return job.cancelled; }
  };
  emit(true);
  return api;
}

function cancelJob(id) {
  const job = jobs.get(id);
  if (job) job.cancelled = true;
}

function getJob(id) {
  const job = jobs.get(id);
  return job ? { ...snapshot(job), log: job.logLines } : null;
}

module.exports = { setBroadcaster, createJob, cancelJob, getJob };
