/**
 * Orchestrator V1 (agents' review loop): Claude delivers in the Google Drive channel → an auditor (OpenAI) reviews
 * → it writes structured instructions → Claude gets a new task → … until done or until Hans must approve.
 * Shared types. Nothing here touches Atomivid's production database or audiovisual spend.
 */

/** Verdict the auditor must return (validated against AUDIT_SCHEMA; anything else blocks the task). */
export type AuditDecision = "approve" | "revise" | "needs_human";

export type AuditVerdict = {
  decision: AuditDecision;
  summary: string;
  /** Concrete next steps for Claude when decision = "revise" (empty otherwise). */
  instructions: string[];
  /** Problems found in the delivery. */
  findings: string[];
  /** The auditor believes the next step needs money, production, a deploy/merge, credentials or protected assets. */
  requires_human_approval: boolean;
};

/** One delivery of Claude in Entregas/ (protocol v2: `<ID>__claude__hecha.md`). */
export type Delivery = { fileId: string; name: string; taskId: string; modifiedTime: string; content: string };

/** Origin of a task chain: the first request, then one follow-up per revision. */
export type ChainInfo = { rootId: string; attempt: number };

export type AuditUsage = { inputTokens: number; outputTokens: number; costUsd: number; model: string };

export interface Auditor {
  readonly name: string;
  readonly paid: boolean;
  audit(input: { task: string; delivery: string; attempt: number; maxAttempts: number }): Promise<{ verdict: AuditVerdict; usage: AuditUsage }>;
}

export type AuditEvent =
  | "cycle_started" | "skipped_kill_switch" | "delivery_seen" | "already_processed" | "audit_ok" | "audit_failed"
  | "budget_refused" | "guard_escalated" | "followup_created" | "task_completed" | "approval_requested" | "attempts_exhausted"
  | "cycle_finished" | "recovered" | "delivery_error";

export type AuditLogEntry = { at: string; event: AuditEvent; taskId?: string; key?: string; detail?: Record<string, unknown> };
