const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const http = require('node:http');
const path = require('node:path');

function request(options, body, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ ...options, headers: { ...(extraHeaders || {}) } }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve({ statusCode: res.statusCode, body: data, headers: res.headers }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

test('dashboard exposes a working emergency control', async () => {
  const repoRoot = path.resolve(__dirname, '..');
  const child = spawn(process.execPath, ['server.js'], {
    cwd: repoRoot,
    env: { ...process.env, PORT: '3101', SHARE_USER_1: 'mira', SHARE_PASS_1: 'orange-ombre-1', SHARE_USER_2: 'leo', SHARE_PASS_2: 'navy-echo-2' },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk.toString(); });
  child.stderr.on('data', (chunk) => { output += chunk.toString(); });

  const waitForServer = async () => {
    for (let i = 0; i < 25; i += 1) {
      try {
        const res = await request({ hostname: '127.0.0.1', port: 3101, path: '/health', method: 'GET' });
        if (res.statusCode === 200) return;
      } catch (error) {
        // keep retrying
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error(`Server did not start. Output: ${output}`);
  };

  try {
    await waitForServer();

    const loginResponse = await request({
      hostname: '127.0.0.1',
      port: 3101,
      path: '/login',
      method: 'POST'
    }, 'username=mira&password=orange-ombre-1', {
      'Content-Type': 'application/x-www-form-urlencoded'
    });

    assert.equal(loginResponse.statusCode, 302, 'login should redirect to the dashboard');

    const cookie = loginResponse.headers['set-cookie']?.[0]?.split(';')[0] || '';
    const dashboardResponse = await request({ hostname: '127.0.0.1', port: 3101, path: '/dashboard', method: 'GET' }, undefined, cookie ? { Cookie: cookie } : {});
    assert.equal(dashboardResponse.statusCode, 200, 'dashboard should load for authenticated users');
    assert.match(dashboardResponse.body, /class="emergency-btn"/, 'dashboard should render the emergency button');
    assert.match(dashboardResponse.body, /data-emergency-video="https:\/\/www\.youtube\.com\/watch\?v=cd1xNW2apDs"/, 'dashboard should include the emergency video target');
  } finally {
    child.kill('SIGTERM');
  }
});
