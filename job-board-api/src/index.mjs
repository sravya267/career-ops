import 'dotenv/config';
import { createServer } from 'http';
import { config }       from './config.mjs';
import { runPipeline }  from './pipeline.mjs';

// Track whether a pipeline run is in progress to prevent overlapping runs.
let running = false;

const server = createServer(async (req, res) => {
  const { method, url } = req;

  if (url === '/health' && method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', ts: new Date().toISOString() }));
    return;
  }

  if (url === '/run' && method === 'POST') {
    if (running) {
      res.writeHead(409, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'busy', message: 'pipeline already running' }));
      return;
    }

    res.writeHead(202, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'started', ts: new Date().toISOString() }));

    running = true;
    runPipeline()
      .then(r  => console.log('[server] pipeline complete:', JSON.stringify(r)))
      .catch(e => console.error('[server] pipeline error:', e.message))
      .finally(() => { running = false; });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'not found' }));
});

server.listen(config.port, () =>
  console.log(`career-ops job-board-api listening on :${config.port}`)
);

// Graceful shutdown
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    console.log(`[server] ${sig} received — shutting down`);
    server.close(() => process.exit(0));
  });
}
