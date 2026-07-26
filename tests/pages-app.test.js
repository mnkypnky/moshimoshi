const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('pages entrypoint exposes the public app shell', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  assert.match(html, /id="app"/, 'index.html should contain the main app shell');
  assert.match(html, /id="login-screen"/, 'index.html should contain the login experience');
  assert.match(html, /id="emergency-btn"/, 'index.html should contain the emergency button');
});
