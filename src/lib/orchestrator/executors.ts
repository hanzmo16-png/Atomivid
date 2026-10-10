/**
 * How Claude receives the next task, using officially supported mechanisms only:
 *  - DriveHandoffExecutor (default): the follow-up task file in Solicitudes/ IS the handoff. Claude picks it up
 *    from its Drive routine or when Hans opens a session. No API calls, no cost.
 *  - ClaudeCodeActionExecutor (opt-in, off by default): fires `repository_dispatch` (event "claude-task") for the
 *    workflow .github/workflows/claude-executor.yml, which runs the official anthropics/claude-code-action with
 *    CLAUDE_CODE_OAUTH_TOKEN (Claude Pro/Max subscription token from `claude setup-token`). It does NOT assume free
 *    API calls: without that secret (or with ANTHROPIC_API_KEY, which is pay-per-use) the workflow refuses to run.
 *    The action works on a branch/PR; it never merges or deploys.
 * Approval notices: GitHub mention by the Actions bot (no paid WhatsApp), plus the Drive file written by the engine.
 */
export interface ClaudeExecutor {
  readonly mode: "drive" | "claude-code-action";
  dispatch(task: { taskId: string }): Promise<{ ok: boolean; detail: string }>;
}

export class DriveHandoffExecutor implements ClaudeExecutor {
  readonly mode = "drive" as const;
  async dispatch(task: { taskId: string }) { return { ok: true, detail: `tarea ${task.taskId} publicada en Solicitudes/ para Claude` }; }
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export class ClaudeCodeActionExecutor implements ClaudeExecutor {
  readonly mode = "claude-code-action" as const;
  constructor(private env: Record<string, string | undefined> = process.env, private fetchImpl: FetchLike = fetch) {}
  async dispatch(task: { taskId: string }) {
    if (this.env.ORCH_CLAUDE_ACTION_ENABLED !== "true") return { ok: false, detail: "ejecutor de Claude Code Action desactivado (ORCH_CLAUDE_ACTION_ENABLED)" };
    const token = this.env.GITHUB_TOKEN, repo = this.env.GITHUB_REPOSITORY;
    if (!token || !repo) return { ok: false, detail: "sin credenciales de GitHub para despachar" };
    const res = await this.fetchImpl(`https://api.github.com/repos/${repo}/dispatches`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "content-type": "application/json" },
      body: JSON.stringify({ event_type: "claude-task", client_payload: { taskId: task.taskId } }),
    });
    return { ok: res.ok, detail: res.ok ? "despachado a claude-executor" : `despacho rechazado (${res.status})` };
  }
}

export interface ApprovalNotifier {
  notify(n: { taskId: string; kind: "approval" | "completed" | "blocked" }): Promise<boolean>;
}

/** No notifier configured: the Drive file is the only notice. */
export class NoopNotifier implements ApprovalNotifier { async notify() { return false; } }

export const ORCH_ISSUE_TITLE = "Aprobaciones del orquestador de Atomivid";
const TEXT = {
  approval: "El orquestador necesita tu aprobación para continuar una tarea.",
  completed: "El orquestador dio por completada una tarea; revisa el resultado.",
  blocked: "El orquestador detuvo una tarea y necesita tu atención.",
};

/**
 * Comment mentioning the owner on one tracking issue, posted with the workflow's GITHUB_TOKEN (github-actions[bot],
 * so GitHub notifies the owner). The repository is public: generic text + task id only; details stay in Drive.
 */
export class GitHubIssueNotifier implements ApprovalNotifier {
  constructor(private env: Record<string, string | undefined> = process.env, private fetchImpl: FetchLike = fetch) {}
  async notify(n: { taskId: string; kind: "approval" | "completed" | "blocked" }) {
    const token = this.env.GITHUB_TOKEN, repo = this.env.GITHUB_REPOSITORY, mention = this.env.NOTICE_MENTION;
    if (!token || !repo || !mention || !/^[A-Za-z0-9-]{1,39}$/.test(mention)) return false;
    const gh = (p: string, init?: RequestInit) => this.fetchImpl(`https://api.github.com/repos/${repo}${p}`, { ...init, headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "content-type": "application/json" } });
    const list = await gh("/issues?state=open&per_page=100");
    let issue = list.ok ? ((await list.json()) as { number: number; title: string }[]).find((i) => i.title === ORCH_ISSUE_TITLE)?.number : undefined;
    if (!issue) {
      const created = await gh("/issues", { method: "POST", body: JSON.stringify({ title: ORCH_ISSUE_TITLE, body: `Avisos del orquestador para @${mention}. Los detalles están en la carpeta de coordinación de Google Drive.` }) });
      if (!created.ok) return false;
      issue = ((await created.json()) as { number: number }).number;
    }
    const safeId = /^T-\d{8}-\d{4}-[a-z]+-\d{2,}$/.test(n.taskId) ? n.taskId : "(tarea)";
    const res = await gh(`/issues/${issue}/comments`, { method: "POST", body: JSON.stringify({ body: `@${mention} ${TEXT[n.kind]} Tarea ${safeId} (detalles en Drive → Entregas).` }) });
    return res.ok;
  }
}
