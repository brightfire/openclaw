export const EXEC_TOOL_DISPLAY_SUMMARY = "Run shell commands that start now.";
export const PROCESS_TOOL_DISPLAY_SUMMARY = "Inspect and control running exec sessions.";
export const CRON_TOOL_DISPLAY_SUMMARY = "Schedule cron jobs, reminders, and wake events.";
export const SESSIONS_LIST_TOOL_DISPLAY_SUMMARY =
  "List visible sessions with mailbox filters and optional previews.";
export const SESSIONS_HISTORY_TOOL_DISPLAY_SUMMARY =
  "Read sanitized message history for a visible session.";
export const SESSIONS_SEND_TOOL_DISPLAY_SUMMARY = "Send a message to another visible session.";
export const SESSIONS_SPAWN_TOOL_DISPLAY_SUMMARY = "Spawn sub-agent or ACP sessions.";
export const SESSIONS_SPAWN_SUBAGENT_TOOL_DISPLAY_SUMMARY = "Spawn sub-agent sessions.";
export const SESSION_STATUS_TOOL_DISPLAY_SUMMARY = "Show session status, usage, and model state.";
export const UPDATE_PLAN_TOOL_DISPLAY_SUMMARY = "Track a short structured work plan.";

export function describeSessionsListTool(): string {
  return [
    "List visible sessions with optional filters for kind, label, agentId, search, recent activity, derived titles, and last-message previews.",
    "Use this to discover a target session before calling sessions_history or sessions_send.",
    "Set `key` to an exact canonical session key to fetch a single session's row; combine with `includeArchived: true` to also receive its archived twin rows for the same session lineage.",
  ].join(" ");
}

export function describeSessionsHistoryTool(): string {
  return [
    "Fetch sanitized message history for a visible session.",
    "Supports limits and optional tool messages; use this to inspect another session before replying, debugging, or resuming work.",
    "`sessionKey` accepts the canonical session key (e.g. `agent:main:main`), an archive-twin key (`<canonical>:archived:<sessionId>`), or a bare sessionId. Archived sessions are read transparently from their `.jsonl.reset.<ts>` transcript and the response includes `archived: true`.",
    "To resume context from a prior rolled-over session: call sessions_list with `key=<your canonical session key>` and `includeArchived: true` to get the archive twin's sessionId, then sessions_history with `sessionKey=<that sessionId>` (or the archive-twin key) to read its transcript.",
  ].join(" ");
}

export function describeSessionsSendTool(): string {
  return [
    "Send a message into another visible session by sessionKey or label.",
    "Thread-scoped chat sessions are rejected; target the parent channel session for inter-agent coordination.",
    "Use this to delegate follow-up work to an existing session; waits for the target run and returns the updated assistant reply when available.",
    "For cross-gateway messaging to remote fleet peers, use @<gateway>/session keys (see cross-gateway skill).",
  ].join(" ");
}

export function describeSessionsSpawnTool(options?: {
  acpAvailable?: boolean;
  threadAvailable?: boolean;
}): string {
  const baseDescription = [
    'Spawn a clean isolated session by default with `runtime="subagent"` or `runtime="acp"`.',
    options?.threadAvailable
      ? '`mode="run"` is one-shot and `mode="session"` is persistent and thread-bound.'
      : '`mode="run"` is one-shot background work.',
    "Subagents inherit the parent workspace directory automatically.",
    'For native subagents only, set `context="fork"` when the child needs the current transcript context; otherwise omit it or use `context="isolated"`.',
    "Use this when the work should happen in a fresh child session instead of the current one.",
  ];
  if (options?.acpAvailable === false) {
    return baseDescription
      .map((line) =>
        line.replace(
          ' with `runtime="subagent"` or `runtime="acp"`',
          " with the native subagent runtime",
        ),
      )
      .join(" ");
  }
  return [
    ...baseDescription.slice(0, 3),
    '`runtime="acp"` is for external ACP harness ids such as codex, claude, gemini, or opencode, or agents configured with `agents.list[].runtime.type="acp"`.',
    ...baseDescription.slice(3),
  ].join(" ");
}

export function describeSessionStatusTool(): string {
  return [
    "Show a /status-equivalent session status card for the current or another visible session, including usage, time, cost when available, and linked background task context.",
    'Use `sessionKey="current"` for the current session; do not use UI/client labels such as `openclaw-tui` as session keys.',
    "Optional `model` sets a per-session model override; `model=default` resets overrides.",
    "Use this for questions like what model is active or how a session is configured.",
  ].join(" ");
}

export function describeUpdatePlanTool(): string {
  return [
    "Update the current structured work plan for this run.",
    "Use this for non-trivial multi-step work so the plan stays current while execution continues.",
    "Keep steps short, mark at most one step as `in_progress`, and skip this tool for simple one-step tasks.",
  ].join(" ");
}
