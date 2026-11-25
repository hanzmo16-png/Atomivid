import { parseStartOutcome } from '../../src/lib/video/start-outcome';
/** Release only this runner's unstarted-render hold when the server supplies a complete typed proof. */
export function provedUnstartedRender(body: unknown): boolean {
 const outcome=parseStartOutcome((body as {outcome?:unknown}|null)?.outcome);
 return outcome!==null&&outcome.charge==='none_proven'&&outcome.attempts>=0&&(outcome.status==='script_ready'||outcome.status==='failed');
}
