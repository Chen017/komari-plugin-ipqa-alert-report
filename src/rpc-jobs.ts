// RPC handlers must return synchronously. Async work is explicitly submitted
// as a job; callers retrieve completion without serializing a Promise.
export function createRpcJobs() {
  const jobs = new Map<string, any>();
  let counter = 0;
  return {
    submit(work: () => Promise<unknown>) {
      const id = `${Date.now()}-${++counter}`;
      if (jobs.size >= 32) {
        const completed = [...jobs].find(([, job]) => job.status !== 'running');
        if (!completed) throw new Error('Too many active jobs');
        jobs.delete(completed[0]);
      }
      jobs.set(id, { id, status: 'running' });
      Promise.resolve().then(work).then(result => jobs.set(id, { id, status: 'completed', result }), error => jobs.set(id, { id, status: 'failed', error: String(error) }));
      return { accepted: true, job_id: id };
    },
    get(id: string) { return jobs.get(id) ?? null; },
  };
}
