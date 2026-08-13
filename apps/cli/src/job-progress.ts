export const SPECIALIST_PASSES = [
  "correctness",
  "nitpick",
  "devils-advocate",
] as const;

export type PassChipStatus = "pending" | "running" | "done" | "error";

export type AgentPassChip = {
  id: string;
  status: PassChipStatus;
  findings?: number;
  seconds?: number;
};

export type AgentTrackStatus =
  | "queued"
  | "running"
  | "done"
  | "error"
  | "skipped";

export type AgentTrack = {
  agent: string;
  status: AgentTrackStatus;
  label: string;
  startedAt?: string;
  finishedAt?: string;
  passes: AgentPassChip[];
};

export type JobProgress = {
  sharedLabel: string;
  agents: AgentTrack[];
};

export function initJobProgress(agents: string[]): JobProgress {
  return {
    sharedLabel: "Queued",
    agents: agents.map((agent) => ({
      agent,
      status: "queued",
      label: "Waiting to start",
      passes: SPECIALIST_PASSES.map((id) => ({ id, status: "pending" })),
    })),
  };
}

function findTrack(
  progress: JobProgress,
  agent: string,
): AgentTrack | undefined {
  return progress.agents.find((track) => track.agent === agent);
}

function ensurePass(track: AgentTrack, passId: string): AgentPassChip {
  let chip = track.passes.find((pass) => pass.id === passId);
  if (!chip) {
    chip = { id: passId, status: "pending" };
    track.passes.push(chip);
  }
  return chip;
}

function refreshLabel(track: AgentTrack): void {
  if (track.status === "done") {
    const findings = track.passes.reduce(
      (sum, pass) => sum + (pass.findings ?? 0),
      0,
    );
    track.label = findings ? `Done · ${findings} finding(s)` : "Done";
    return;
  }
  if (track.status === "skipped") {
    track.label = track.label || "Skipped";
    return;
  }
  if (track.status === "error") {
    track.label = track.label.startsWith("Failed")
      ? track.label
      : `Failed — ${track.label}`;
    return;
  }
  const running = track.passes
    .filter((pass) => pass.status === "running")
    .map((pass) => pass.id);
  const finished = track.passes.filter(
    (pass) => pass.status === "done" || pass.status === "error",
  ).length;
  if (running.length > 0) {
    track.label = `${running.join(" · ")} running`;
    return;
  }
  if (finished > 0) {
    track.label = `${finished}/${track.passes.length} passes done`;
    return;
  }
  track.label = track.status === "running" ? "Starting" : "Waiting to start";
}

export function trackPercent(track: AgentTrack): number {
  if (track.status === "done") return 100;
  if (track.status === "queued" || track.status === "skipped") return 0;
  const total = Math.max(track.passes.length, 1);
  let score = 0;
  for (const pass of track.passes) {
    if (pass.status === "done" || pass.status === "error") score += 1;
    else if (pass.status === "running") score += 0.45;
  }
  if (track.status === "running" && score === 0) return 8;
  if (track.status === "error") {
    return Math.min(99, Math.max(12, Math.round((score / total) * 100)));
  }
  return Math.min(99, Math.round((score / total) * 100));
}

function stripAgentPrefix(
  line: string,
  agents: string[],
): { agent?: string; rest: string } {
  const match = line.match(/^\[([^\]]+)\]\s*([\s\S]*)$/);
  if (match?.[1] && agents.includes(match[1])) {
    return { agent: match[1], rest: match[2] ?? "" };
  }
  return { rest: line };
}

/**
 * Update live job progress from one un-timestamped log line
 * (the same string passed to appendLog).
 */
export function applyLogToProgress(
  progress: JobProgress,
  line: string,
  agents: string[],
): JobProgress {
  const raw = line.replace(/^\n+/, "").trimEnd();
  if (!raw) return progress;

  const { agent, rest } = stripAgentPrefix(raw, agents);
  const text = (agent ? rest : raw).trim();

  if (!agent) {
    if (/^Fetching PR\b/i.test(text)) {
      progress.sharedLabel = "Fetching pull request";
    } else if (/^Cached PR\b/i.test(text)) {
      progress.sharedLabel = "PR cached — overview next";
    } else if (/▶ overview\b/i.test(text)) {
      progress.sharedLabel = "Writing shared overview";
    } else if (/✓ overview done/i.test(text)) {
      progress.sharedLabel = "Overview ready — agents starting";
    } else if (/Starting \d+ agent/i.test(text)) {
      progress.sharedLabel = "Agents running in parallel";
    } else if (/merged into triage/i.test(text)) {
      progress.sharedLabel = text.replace(/^✓\s*/, "").slice(0, 180);
    } else if (/^All done\./i.test(text) || /^Finished with partial/i.test(text)) {
      progress.sharedLabel = "Finished";
    } else if (/^Stopped early/i.test(text)) {
      progress.sharedLabel = "Stopped";
    } else if (/^Skipping (\S+)/.test(text)) {
      const skipped = text.match(/^Skipping (\S+)/)?.[1];
      const track = skipped ? findTrack(progress, skipped) : undefined;
      if (track) {
        track.status = "skipped";
        track.label = "Not available";
        track.finishedAt = new Date().toISOString();
      }
    }
    return progress;
  }

  const track = findTrack(progress, agent);
  if (!track) return progress;

  const startPass = text.match(/▶ pass \d+\/\d+:\s+(\S+)/);
  if (startPass?.[1]) {
    track.status = "running";
    if (!track.startedAt) track.startedAt = new Date().toISOString();
    ensurePass(track, startPass[1]).status = "running";
    refreshLabel(track);
    return progress;
  }

  const donePass = text.match(
    /✓ pass (\S+) done — (\d+) finding\(s\) in ([\d.]+)s/,
  );
  if (donePass?.[1]) {
    const chip = ensurePass(track, donePass[1]);
    chip.status = "done";
    chip.findings = Number(donePass[2]);
    chip.seconds = Number(donePass[3]);
    refreshLabel(track);
    return progress;
  }

  const failPass = text.match(/✗ pass (\S+) failed/);
  if (failPass?.[1]) {
    ensurePass(track, failPass[1]).status = "error";
    refreshLabel(track);
    return progress;
  }

  if (/^Starting/i.test(text)) {
    track.status = "running";
    track.startedAt = track.startedAt ?? new Date().toISOString();
    refreshLabel(track);
    return progress;
  }

  if (/^Done ·/i.test(text)) {
    track.status = "done";
    track.finishedAt = new Date().toISOString();
    for (const pass of track.passes) {
      if (pass.status === "running") pass.status = "done";
    }
    refreshLabel(track);
    return progress;
  }

  if (/^Failed:|^Stopped \(/i.test(text)) {
    track.status = "error";
    track.finishedAt = new Date().toISOString();
    track.label = text.slice(0, 120);
    for (const pass of track.passes) {
      if (pass.status === "running") pass.status = "error";
    }
    return progress;
  }

  return progress;
}

export function syncTracksFromResults(
  progress: JobProgress,
  results: { agent: string; status: "ok" | "skipped" | "error" }[],
): void {
  for (const result of results) {
    const track = findTrack(progress, result.agent);
    if (!track) continue;
    if (result.status === "ok") track.status = "done";
    else if (result.status === "error") track.status = "error";
    else track.status = "skipped";
    track.finishedAt = track.finishedAt ?? new Date().toISOString();
    refreshLabel(track);
  }
}
