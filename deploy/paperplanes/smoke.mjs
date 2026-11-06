import { readFileSync, writeFileSync } from 'node:fs'
import { loadEnvFile } from 'node:process'
import { Sandbox } from 'e2b'

try { loadEnvFile('.env') } catch (error) { if (error.code !== 'ENOENT') throw error }
const template = JSON.parse(readFileSync('.deploy/baselayer-template.json', 'utf8'))
let sandbox
try {
  sandbox = await Sandbox.create(template.templateId, {
    timeoutMs: 300_000, secure: true, network: { allowPublicTraffic: false },
    metadata: { project: 'baselayer', 'ppr.role': 'image-smoke', 'ppr.ignore': 'true' },
  })
  console.log('Testing sandbox', sandbox.sandboxId)
  await sandbox.files.write('/data/scry.env', `E2B_SANDBOX_ID=${sandbox.sandboxId}\n`, { user: 'root' })
  const script = `
import assert from 'node:assert/strict';
import { chromium } from '/opt/baselayer/node_modules/playwright-core/index.mjs';
import { readdirSync, readFileSync } from 'node:fs';
const api = 'http://127.0.0.1:3000';
const created = await fetch(api + '/v1/sessions', { method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify({browser:'chromium',keepAlive:false,timeoutSec:120,idleTimeoutSec:60}) });
const session = await created.json();
assert.equal(created.status,201,JSON.stringify(session));
console.log('Created session', JSON.stringify(session));
let browser;
try {
  browser = await chromium.connectOverCDP(session.cdpUrl);
  const page = await browser.contexts()[0].newPage();
  await page.goto('https://example.com', {waitUntil:'domcontentloaded'});
  assert.equal(await page.title(),'Example Domain');
  console.log('Browser navigation passed');
} finally {
  if (browser) await browser.close();
  const released = await fetch(api + '/v1/sessions/' + session.sessionId, {method:'DELETE'});
  assert.equal(released.status,204,await released.text());
}
await new Promise(r=>setTimeout(r,7000));
const files = readdirSync('/data/scry/spool').filter(f=>f.endsWith('.ndjson'));
const records = files.flatMap(f=>readFileSync('/data/scry/spool/'+f,'utf8').trim().split('\\n').filter(Boolean).map(line=>JSON.parse(line)));
assert(records.length>0,'Scry wrote no records');
assert(records.some(r=>r.kind==='run.started' && r.provider_sandbox_id===process.env.TEST_SANDBOX_ID),'Missing sandbox identity in Scry records');
assert(records.some(r=>r.kind==='proc.sample'),'Scry wrote no process samples');
console.log('Scry recording passed',records.length,'records');
`
  await sandbox.files.write('/tmp/baselayer-smoke.mjs', script, { user: 'root' })
  const result = await sandbox.commands.run('node /tmp/baselayer-smoke.mjs', {
    user: 'root', timeoutMs: 150_000, envs: { TEST_SANDBOX_ID: sandbox.sandboxId },
  })
  console.log(result.stdout)
  writeFileSync('.deploy/baselayer-smoke.json', JSON.stringify({ template, sandbox_id: sandbox.sandboxId, passed: true, at: new Date().toISOString(), output: result.stdout }, null, 2) + '\n')
} catch (error) {
  if (sandbox) {
    const logs = await sandbox.commands.run('tail -n 30 /data/logs/*error.log; supervisorctl -c /data/baselayer-supervisord.conf status', { user: 'root' }).catch(() => null)
    if (logs) console.error(logs.stdout)
  }
  console.error(error.stdout ?? '', error.stderr ?? '', error.message)
  process.exitCode = 1
} finally {
  if (sandbox) { await sandbox.kill(); console.log('Temporary test sandbox deleted') }
}
