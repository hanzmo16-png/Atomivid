import { initialQueue, type Queue } from './model';
export const STATE_BRANCH = 'automation/quality-loop-state';
export type Snapshot = { state: Queue; revision: string | null };
export interface QueueStore { read(): Promise<Snapshot>; write(state: Queue, revision: string | null): Promise<void> }
export class Conflict extends Error {}
export async function update<T>(store: QueueStore, mutate: (q: Queue) => T): Promise<T> {
  for (let i=0;i<5;i++) { const s = await store.read(); const value = mutate(s.state); try { await store.write(s.state, s.revision); return value; } catch(e) { if (!(e instanceof Conflict)) throw e; } }
  throw new Error('CAS_RETRIES_EXHAUSTED');
}
export class GitHubQueueStore implements QueueStore {
  constructor(readonly repo: string, private token?: string, private fetcher: typeof fetch = fetch) { if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error('INVALID_REPO'); }
  private async api(p: string, init: RequestInit = {}) { const r = await this.fetcher(`https://api.github.com/repos/${this.repo}${p}`, { ...init, headers: { accept: 'application/vnd.github+json', ...(this.token ? { authorization: `Bearer ${this.token}` } : {}), 'content-type': 'application/json', ...init.headers }, cache: 'no-store', signal: AbortSignal.timeout(20000) }); return r; }
  async read(): Promise<Snapshot> {
    const r = await this.api(`/contents/state.json?ref=${STATE_BRANCH}`);
    if (r.status===404) return { state: initialQueue(new Date().toISOString()), revision: null };
    if (!r.ok) throw new Error(`QUEUE_READ_${r.status}`);
    const j = await r.json(); const q = JSON.parse(Buffer.from(j.content,'base64').toString('utf8')) as Queue;
    if (q.version !== 'quality-loop/1' || typeof q.enabled !== 'boolean' || !Array.isArray(q.cycles) || !Array.isArray(q.defects) || !Array.isArray(q.activity) || !q.mirror) throw new Error('CORRUPT_QUEUE');
    return { state: q, revision: j.sha };
  }
  async write(q: Queue, revision: string | null) {
    if (!this.token) throw new Error('QUEUE_WRITE_NOT_CONFIGURED');
    const content = JSON.stringify(q, null, 2)+'\n';
    if (!revision) {
      // Orphan state branch: no application sources, no production-branch commit.
      const tree = await this.api('/git/trees', {method:'POST',body:JSON.stringify({tree:[{path:'state.json',mode:'100644',type:'blob',content}]})});
      if (!tree.ok) throw new Error(`QUEUE_TREE_${tree.status}`);
      const commit = await this.api('/git/commits',{method:'POST',body:JSON.stringify({message:'Quality loop state',tree:(await tree.json()).sha,parents:[]})});
      if (!commit.ok) throw new Error(`QUEUE_COMMIT_${commit.status}`);
      const ref = await this.api('/git/refs',{method:'POST',body:JSON.stringify({ref:`refs/heads/${STATE_BRANCH}`,sha:(await commit.json()).sha})});
      if (ref.status===422) throw new Conflict(); if(!ref.ok) throw new Error(`QUEUE_REF_${ref.status}`); return;
    }
    const r=await this.api('/contents/state.json',{method:'PUT',body:JSON.stringify({message:'Quality loop state',branch:STATE_BRANCH,sha:revision,content:Buffer.from(content).toString('base64')})});
    if(r.status===409||r.status===422)throw new Conflict(); if(!r.ok)throw new Error(`QUEUE_WRITE_${r.status}`);
  }
}
