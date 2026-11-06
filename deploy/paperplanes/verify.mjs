import assert from 'node:assert/strict'
import { chromium } from '/opt/baselayer/node_modules/playwright-core/index.mjs'

const api = 'http://127.0.0.1:3000'
const created = await fetch(api + '/v1/sessions', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ browser: 'chromium', keepAlive: false, timeoutSec: 120, idleTimeoutSec: 60 }),
  signal: AbortSignal.timeout(100_000),
})
const session = await created.json()
assert.equal(created.status, 201, JSON.stringify(session))
let browser
let title
try {
  browser = await chromium.connectOverCDP(session.cdpUrl, { timeout: 30_000 })
  const page = await browser.contexts()[0].newPage()
  await page.goto('https://example.com', { waitUntil: 'domcontentloaded', timeout: 30_000 })
  title = await page.title()
  assert.equal(title, 'Example Domain')
} finally {
  try { if (browser) await browser.close() } finally {
    const released = await fetch(api + '/v1/sessions/' + session.sessionId, { method: 'DELETE', signal: AbortSignal.timeout(10_000) })
    assert.equal(released.status, 204, await released.text())
  }
}
console.log(JSON.stringify({ passed: true, session_id: session.sessionId, browser: 'chromium', url: 'https://example.com', title, released: true }))
