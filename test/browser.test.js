const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const net = require('net');
const { spawn } = require('child_process');
const { once } = require('events');
const WebSocket = require('ws');
const { Server } = require('ssh2');

function outputMatch(child, stream, pattern) {
  return new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error('Process startup timed out: ' + output)), 10000);
    child[stream].on('data', data => { output += data; const match = output.match(pattern); if (match) { clearTimeout(timer); resolve(match[1]); } });
    child.once('exit', code => { clearTimeout(timer); reject(new Error('Process exited: ' + code)); });
  });
}

// No browser package or downloaded browser required. CI can set CHROMIUM_PATH.
test('Chromium: SSH lifecycle, responsive UI, dialogs, filtered ordering and auth settings', { timeout: 30000 }, async t => {
  const chromium = process.env.CHROMIUM_PATH || '/usr/bin/chromium';
  if (!fs.existsSync(chromium)) return t.skip('Set CHROMIUM_PATH to run browser verification');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'remotehub-browser-'));
  const processes = [];
  const connections = new Set();
  let shellCount = 0;
  let receivedResponses = 0;
  const receivedInput = [];
  const hostKey = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' });
  const sshServer = new Server({ hostKeys: [hostKey] }, client => {
    connections.add(client); client.on('close', () => connections.delete(client)); client.on('error', () => {});
    client.on('authentication', ctx => ctx.accept());
    client.on('ready', () => client.on('session', accept => {
      const session = accept(); session.on('pty', accept => accept());
      session.on('window-change', accept => { if (accept) accept(); });
      session.on('shell', accept => {
        shellCount++;
        const stream = accept();
        stream.on('data', data => { receivedInput.push(data.toString()); if (data.toString().includes('\x1b[')) receivedResponses++; });
        stream.write('browser-ready 한글\r\n\x1b[6n');
      });
    }));
  });
  t.after(async () => {
    for (const client of connections) client.end();
    sshServer.close();
    await Promise.all(processes.map(async child => { if (child.exitCode === null) { const closed = once(child, 'exit'); child.kill(); await closed; } }));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await new Promise(resolve => sshServer.listen(0, '127.0.0.1', resolve));
  // Minimal RFB 3.8 peer verifies noVNC through the production TCP/WebSocket bridge.
  const vncSockets = new Set();
  const vncServer = net.createServer(socket => {
    vncSockets.add(socket); socket.on('close', () => vncSockets.delete(socket)); socket.on('error', () => {});
    socket.write('RFB 003.008\n');
    let state = 0, buffer = Buffer.alloc(0), sentFrame = false;
    socket.on('data', data => {
      buffer = Buffer.concat([buffer, data]);
      while (buffer.length >= (state === 0 ? 12 : 1)) {
        const length = state === 0 ? 12 : state < 3 ? 1 : buffer.length;
        buffer = buffer.subarray(length);
        if (state === 0) socket.write(Buffer.from([1, 1]));
        else if (state === 1) socket.write(Buffer.alloc(4));
        else if (state === 2) {
          const name = Buffer.from('Loopback VNC');
          const init = Buffer.alloc(24 + name.length);
          init.writeUInt16BE(2, 0); init.writeUInt16BE(2, 2); init[4] = 32; init[5] = 24; init[7] = 1;
          for (const offset of [8, 10, 12]) init.writeUInt16BE(255, offset);
          init[14] = 16; init[15] = 8; init.writeUInt32BE(name.length, 20); name.copy(init, 24); socket.write(init);
        } else if (!sentFrame) {
          sentFrame = true;
          const frame = Buffer.alloc(32); frame.writeUInt16BE(1, 2); frame.writeUInt16BE(2, 8); frame.writeUInt16BE(2, 10);
          for (let offset = 16; offset < 32; offset += 4) { frame[offset] = 255; frame[offset + 1] = 255; frame[offset + 2] = 255; }
          socket.write(frame);
        }
        state++;
      }
    });
  });
  await new Promise(resolve => vncServer.listen(0, '127.0.0.1', resolve));
  t.after(() => { for (const socket of vncSockets) socket.destroy(); vncServer.close(); });
  const configPath = path.join(dir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({ auth: { enabled: false, passwordHash: '' }, servers: [{ id: 'browser-ssh', name: 'Browser SSH', protocol: 'ssh', host: '127.0.0.1', port: sshServer.address().port, username: 'test' }] }));
  const app = spawn(process.execPath, ['src/server.js'], { env: { ...process.env, CONFIG_PATH: configPath, PORT: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
  processes.push(app);
  const port = await outputMatch(app, 'stdout', /Listening on: http:\/\/0\.0\.0\.0:(\d+)/);
  const browser = spawn(chromium, ['--headless', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--remote-debugging-port=0', `--user-data-dir=${path.join(dir, 'browser')}`, 'about:blank'], { stdio: ['ignore', 'pipe', 'pipe'] });
  processes.push(browser);
  const browserWs = await outputMatch(browser, 'stderr', /DevTools listening on (ws:\/\/[^\s]+)/);
  const debugPort = new URL(browserWs).port;
  const page = await (await fetch(`http://127.0.0.1:${debugPort}/json/new?about:blank`, { method: 'PUT' })).json();
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await once(ws, 'open'); t.after(() => ws.close());
  let id = 0;
  const pending = new Map();
  const exceptions = [];
  let postponedImport = null;
  ws.on('message', data => {
    const message = JSON.parse(data);
    if (message.method === 'Fetch.requestPaused') postponedImport = message.params.requestId;
    if (message.method === 'Runtime.exceptionThrown') exceptions.push(message.params.exceptionDetails);
    if (pending.has(message.id)) { const { resolve, reject, timer } = pending.get(message.id); pending.delete(message.id); clearTimeout(timer); message.error ? reject(new Error(JSON.stringify(message.error))) : resolve(message.result); }
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const requestId = ++id;
    const timer = setTimeout(() => { pending.delete(requestId); reject(new Error('CDP timeout: ' + method)); }, 5000);
    pending.set(requestId, { resolve, reject, timer }); ws.send(JSON.stringify({ id: requestId, method, params }));
  });
  const evaluate = async expression => {
    const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  const waitFor = async expression => {
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) { if (await evaluate(expression)) return; await new Promise(resolve => setTimeout(resolve, 50)); }
    throw new Error('Browser condition timed out: ' + expression + ' ' + JSON.stringify(await evaluate("({focus: document.activeElement.outerHTML.slice(0,300), dialogs: [...document.querySelectorAll('.modal-overlay')].map(el=>({id:el.id,active:el.classList.contains('active'),inert:el.inert})),})")) + ' ' + JSON.stringify(exceptions));
  };
  await send('Runtime.enable'); await send('Page.enable');
  await send('Page.navigate', { url: `http://127.0.0.1:${port}/` });
  await waitFor("document.body.innerText.includes('Browser SSH')");
  await send('Page.navigate', { url: `http://127.0.0.1:${port}/viewer.html?id=browser-ssh` });
  await waitFor("document.querySelector('.xterm-rows')?.textContent.includes('browser-ready 한글')");
  await waitFor("document.querySelector('.tab-status-dot.connected') !== null");
  const responseDeadline = Date.now() + 3000;
  while (!receivedResponses && Date.now() < responseDeadline) await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(receivedResponses > 0, 'live terminal queries must receive xterm responses');
  const responsesBeforeReload = receivedResponses;
  // Mobile helper keys reach the same live SSH channel.
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: false });
  await waitFor("document.getElementById('mobile-input-bar').getBoundingClientRect().height >= 44");
  await evaluate("document.querySelector('[data-terminal-key=Interrupt]').click(); document.querySelector('[data-terminal-key=Tab]').click()");
  const keyDeadline = Date.now() + 3000;
  while (!receivedInput.join('').includes('\x03\t') && Date.now() < keyDeadline) await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(receivedInput.join('').includes('\x03\t'));
  await evaluate("document.getElementById('btn-mobile-keyboard').click()");
  assert.ok(await evaluate("document.activeElement.classList.contains('xterm-helper-textarea')"));
  await evaluate("document.getElementById('btn-terminal-ctrl').click()");
  await send('Input.insertText', { text: 'd' });
  const controlDeadline = Date.now() + 3000;
  while (!receivedInput.join('').includes('\x04') && Date.now() < controlDeadline) await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(receivedInput.join('').includes('\x04'));
  assert.equal(await evaluate("document.getElementById('btn-terminal-ctrl').getAttribute('aria-pressed')"), 'false');
  // Model a keyboard that reduces the visual viewport without resizing the layout viewport.
  await evaluate("window.__nativeViewport = visualViewport; Object.defineProperty(window, 'visualViewport', {configurable: true, value: {height: 320, width: 390, offsetTop: 0, offsetLeft: 0, scale: 1}}); dispatchEvent(new Event('resize'))");
  await waitFor("document.getElementById('mobile-input-bar').getBoundingClientRect().bottom <= 320");
  assert.ok(await evaluate("document.querySelector('.sessions-workspace').getBoundingClientRect().height > 0"));
  await evaluate("document.querySelector('#viewer-tools > summary').click(); document.getElementById('btn-session-menu').click()");
  assert.ok(await evaluate("document.getElementById('tab-context-menu').getBoundingClientRect().bottom <= 320"));
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await evaluate("document.querySelector('#viewer-tools > summary').click(); document.getElementById('btn-clipboard').click()");
  await waitFor("document.getElementById('modal-clipboard').classList.contains('active')");
  assert.ok(await evaluate("document.getElementById('btn-clipboard-type-remote').getBoundingClientRect().bottom <= 320"));
  assert.ok(await evaluate("document.querySelector('#modal-clipboard .modal-body').clientHeight >= 80"));
  await evaluate("document.getElementById('btn-close-clipboard').click()");

  // Verify SSH keyboard shortcuts (Ctrl+Shift+C, Ctrl+Shift+V, and smart Ctrl+C)
  await evaluate("getActiveSession().instance.term.focus(); getActiveSession().instance.term.clearSelection()");
  const inputLenBefore = receivedInput.length;
  // 1. Without selection, Ctrl+C sends \x03 (SIGINT)
  await send('Input.dispatchKeyEvent', { type: 'keyDown', modifiers: 2, key: 'c', code: 'KeyC', windowsVirtualKeyCode: 67 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers: 2, key: 'c', code: 'KeyC', windowsVirtualKeyCode: 67 });
  const sigintDeadline = Date.now() + 2000;
  while (!receivedInput.slice(inputLenBefore).join('').includes('\x03') && Date.now() < sigintDeadline) {
    await new Promise(r => setTimeout(r, 20));
  }
  assert.ok(receivedInput.slice(inputLenBefore).join('').includes('\x03'), 'Ctrl+C without selection sends SIGINT');

  // 2. With selection, Ctrl+C copies and clears selection without sending \x03
  await evaluate("getActiveSession().instance.term.selectAll()");
  assert.equal(await evaluate("getActiveSession().instance.term.hasSelection()"), true);
  const inputLenBeforeSelection = receivedInput.length;
  await send('Input.dispatchKeyEvent', { type: 'keyDown', modifiers: 2, key: 'c', code: 'KeyC', windowsVirtualKeyCode: 67 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers: 2, key: 'c', code: 'KeyC', windowsVirtualKeyCode: 67 });
  await new Promise(r => setTimeout(r, 100));
  assert.equal(receivedInput.length, inputLenBeforeSelection, 'Ctrl+C with selection does NOT send SIGINT');
  assert.equal(await evaluate("getActiveSession().instance.term.hasSelection()"), true, 'Selection is preserved after Ctrl+C copy');
  assert.ok(await evaluate("document.getElementById('clipboard-toast').textContent.includes('복사되었습니다')"));

  // 3. Ctrl+Shift+C prevents default (blocking DevTools)
  const shiftCPrevented = await evaluate(`(() => {
    const event = new KeyboardEvent('keydown', { key: 'C', code: 'KeyC', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  })()`);
  assert.equal(shiftCPrevented, true, 'Ctrl+Shift+C must call preventDefault to suppress DevTools');

  // 4. Ctrl+Shift+V prevents default
  const shiftVPrevented = await evaluate(`(() => {
    const event = new KeyboardEvent('keydown', { key: 'V', code: 'KeyV', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  })()`);
  assert.equal(shiftVPrevented, true, 'Ctrl+Shift+V must call preventDefault');

  await evaluate("Object.defineProperty(window, 'visualViewport', {configurable: true, value: window.__nativeViewport}); dispatchEvent(new Event('resize'))");
  const before = await (await fetch(`http://127.0.0.1:${port}/api/sessions`)).json();
  assert.equal(before.total, 1);
  await send('Page.reload');
  await waitFor("document.querySelector('.xterm-rows')?.textContent.includes('browser-ready 한글')");
  const after = await (await fetch(`http://127.0.0.1:${port}/api/sessions`)).json();
  assert.equal(after.sessions[0].key, before.sessions[0].key); assert.equal(shellCount, 1);
  assert.equal(receivedResponses, responsesBeforeReload, 'history replay must not send terminal query responses');
  await evaluate("document.querySelector('.tab-close-btn').click()");
  await waitFor("fetch('/api/sessions').then(r => r.json()).then(s => s.total === 0)");
  await send('Page.reload');
  await waitFor("document.querySelector('#empty-workspace')?.style.display === 'flex'");
  assert.equal(await evaluate("document.querySelectorAll('.session-tab').length"), 0);
  await send('Network.enable');
  await send('Network.setCacheDisabled', { cacheDisabled: true });
  await send('Fetch.enable', { patterns: [{ urlPattern: '*xterm/lib/xterm.mjs*', requestStage: 'Request' }] });
  await evaluate("window.openNewTab('browser-ssh')");
  const importDeadline = Date.now() + 3000;
  while (!postponedImport && Date.now() < importDeadline) await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(postponedImport, 'the delayed terminal import must be intercepted');
  await evaluate("document.querySelector('.tab-close-btn').click()");
  await send('Fetch.continueRequest', { requestId: postponedImport });
  await send('Fetch.disable');
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(await evaluate("document.querySelectorAll('.xterm').length"), 0, 'closing before initialization must not leave a terminal behind');
  assert.equal((await (await fetch(`http://127.0.0.1:${port}/api/sessions`)).json()).total, 0);
  // A narrow viewer reserves the full width for the remote workspace.
  for (const width of [320, 390, 768, 1024, 1440]) {
    await send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
    await new Promise(resolve => setTimeout(resolve, 250));
    const metrics = await evaluate(`({ workspace: document.querySelector('.sessions-workspace').clientWidth, right: document.querySelector('.topbar-right').getBoundingClientRect().right, closed: document.querySelector('.viewer-sidebar').classList.contains('closed') })`);
    assert.ok(metrics.right <= width, `toolbar exceeds viewport ${width}`);
    if (width <= 900) { assert.equal(metrics.closed, true); assert.equal(metrics.workspace, width); }
  }
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 900, deviceScaleFactor: 1, mobile: false });
  await new Promise(resolve => setTimeout(resolve, 250));
  await evaluate("document.getElementById('btn-open-sidebar').click()");
  assert.equal(await evaluate("document.getElementById('sidebar-backdrop').hidden"), false);
  await evaluate("document.getElementById('sidebar-backdrop').click()");
  await evaluate("document.querySelector('#viewer-tools > summary').click()");
  assert.equal(await evaluate("document.querySelector('#viewer-tools').open"), true);
  assert.ok(await evaluate("document.querySelector('.viewer-tools-panel').getBoundingClientRect().right <= innerWidth"));

  const create = async name => {
    const response = await fetch(`http://127.0.0.1:${port}/api/servers`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, protocol: 'vnc', host: '127.0.0.1', port: 9, group: 'Filtered' }) });
    assert.equal(response.status, 201);
    return (await response.json()).id;
  };
  const firstId = await create('Filtered B');
  const secondId = await create('Filtered C');
  await send('Page.navigate', { url: `http://127.0.0.1:${port}/` });
  await waitFor("document.querySelectorAll('.server-card').length === 3");
  assert.ok(await evaluate("document.documentElement.scrollWidth <= innerWidth"));
  await evaluate("localStorage.setItem('remotehub_open_tabs', JSON.stringify([{serverId: '" + firstId + "'}])); document.getElementById('btn-refresh').click()");
  await waitFor("document.querySelector('.previous-tab-badge') !== null");
  assert.equal(await evaluate("document.querySelectorAll('.active-session-badge').length"), 0);
  await evaluate("{ const search = document.getElementById('search-input'); search.value = 'Filtered'; search.dispatchEvent(new Event('input')); }");
  await waitFor("document.querySelectorAll('.server-card').length === 2");
  await evaluate(`document.querySelector('#card-${firstId} .card-menu').open = true; document.querySelector('#card-${firstId} [data-action="down"]').click()`);
  await waitFor(`document.querySelector('.server-card')?.dataset.id === '${secondId}'`);
  const ordered = await (await fetch(`http://127.0.0.1:${port}/api/servers`)).json();
  assert.deepEqual(ordered.map(server => server.id), ['browser-ssh', secondId, firstId]);
  await evaluate("{ const search = document.getElementById('search-input'); search.value = 'no-match-anywhere'; search.dispatchEvent(new Event('input')); }");
  await waitFor("document.querySelector('.empty-state')?.textContent.includes('검색 결과')");
  await evaluate("document.querySelector('.empty-state button').click()");
  assert.equal(await evaluate("document.querySelectorAll('.server-card').length"), 3);

  await evaluate("document.getElementById('btn-open-add-server').focus(); document.getElementById('btn-open-add-server').click()");
  await waitFor("document.activeElement.closest('#modal-server') !== null");
  assert.equal(await evaluate("document.getElementById('modal-login').inert"), true);
  assert.equal(await evaluate("document.getElementById('server-optional').open"), false);
  await evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))");
  await evaluate("document.getElementById('btn-save-server').focus()");
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
  assert.ok(await evaluate("document.activeElement.matches('#modal-server .close-btn')"), await evaluate('document.activeElement.outerHTML'));
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await waitFor("!document.getElementById('modal-server').classList.contains('active')");
  assert.equal(await evaluate("document.activeElement.id"), 'btn-open-add-server');

  // Settings must allow entering the existing password after protection is unchecked.
  await evaluate(`fetch('/api/auth/settings', {method: 'PUT', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({enabled: true, newPassword: 'browser-password'})})`);
  await evaluate("document.getElementById('btn-open-settings').click()");
  await waitFor("document.getElementById('modal-settings').classList.contains('active')");
  await evaluate("const checkbox = document.getElementById('setting-auth-enabled'); checkbox.checked = false; checkbox.dispatchEvent(new Event('change'))");
  assert.ok(await evaluate("document.getElementById('setting-current-password').getClientRects().length > 0"));
  await evaluate("document.querySelector('#form-settings [type=submit]').click()");
  await waitFor("document.querySelector('#modal-settings .form-notice')?.textContent.includes('현재 비밀번호')");
  await evaluate("document.getElementById('setting-current-password').value = 'browser-password'; document.querySelector('#form-settings [type=submit]').click()");
  await waitFor("!document.getElementById('modal-settings').classList.contains('active')");
  assert.equal((await (await fetch(`http://127.0.0.1:${port}/api/status`)).json()).authEnabled, false);
  await waitFor("document.getElementById('btn-refresh').disabled === false");
  const savedConfig = fs.readFileSync(configPath, 'utf8');
  fs.writeFileSync(configPath, '{broken');
  await evaluate("document.getElementById('btn-refresh').click()");
  await waitFor("document.querySelector('.empty-state [onclick]')?.textContent.includes('다시 시도')");
  fs.writeFileSync(configPath, savedConfig);
  await evaluate("document.querySelector('.empty-state button').click()");
  await waitFor("document.querySelectorAll('.server-card').length === 3");
  const vncResponse = await fetch(`http://127.0.0.1:${port}/api/servers`, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({name: 'Actual VNC', protocol: 'vnc', host: '127.0.0.1', port: vncServer.address().port})});
  assert.equal(vncResponse.status, 201);
  const vncId = (await vncResponse.json()).id;
  await evaluate('localStorage.clear()');
  await send('Page.navigate', {url: `http://127.0.0.1:${port}/viewer.html?id=${vncId}`});
  await waitFor("document.querySelector('.tab-status-dot.connected') !== null");
  await waitFor("document.querySelector('.session-view.active canvas')?.width === 2");
  await waitFor("document.querySelector('.session-view.active canvas').getContext('2d').getImageData(0,0,1,1).data[0] === 255");
  // Changing protocol in the saved configuration changes the engine on reconnect.
  const changed = await fetch(`http://127.0.0.1:${port}/api/servers/${vncId}`, {method: 'PUT', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({protocol: 'ssh', port: sshServer.address().port, username: 'test'})});
  assert.equal(changed.status, 200);
  await evaluate("document.getElementById('btn-reconnect').click()");
  await waitFor("document.querySelector('.session-view.active.ssh-view .xterm-rows')?.textContent.includes('browser-ready 한글')");
  await waitFor("document.querySelector('.tab-status-dot.connected') !== null");
  await evaluate("document.querySelector('.tab-close-btn').click()");
  await waitFor("document.querySelectorAll('.session-tab').length === 0");
  // Exercise production RDP input handlers with real browser touch events and a recording session.
  await evaluate(`(async () => {
    const { setupRdpInputHandlers } = await import('/js/rdp-input.js');
    const canvas = document.createElement('canvas'); canvas.id = 'touch-test'; canvas.width = 400; canvas.height = 200; canvas.tabIndex = 0;
    Object.assign(canvas.style, {position: 'fixed', left: '40px', top: '100px', width: '200px', height: '100px', touchAction: 'none', zIndex: '9999'}); document.body.appendChild(canvas);
    window.__pointerEvents = [];
    const DeviceEvent = Object.fromEntries(['mouseMove','mouseButtonPressed','mouseButtonReleased','wheelRotations'].map(type => [type, (...values) => ({type, values})]));
    class InputTransaction { constructor() { this.events = []; } addEvent(event) { this.events.push(event); } }
    const session = {applyInputs: transaction => window.__pointerEvents.push(...transaction.events), releaseAllInputs() {}};
    window.__disposeTouch = setupRdpInputHandlers(canvas, () => session, {DeviceEvent, InputTransaction});
  })()`);
  await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  const touch = (type, points) => send('Input.dispatchTouchEvent', { type, touchPoints: points.map(([id, x, y]) => ({ id, x, y })) });
  await touch('touchStart', [[1, 80, 120]]); await touch('touchEnd', []);
  assert.deepEqual(await evaluate("window.__pointerEvents.filter(event => event.type.includes('Button')).map(event => [event.type,event.values[0]])"), [['mouseButtonPressed', 0], ['mouseButtonReleased', 0]]);
  await evaluate('window.__pointerEvents = []');
  await touch('touchStart', [[1, 80, 120]]); await touch('touchMove', [[1, 130, 150]]); await touch('touchEnd', []);
  assert.deepEqual(await evaluate("window.__pointerEvents.filter(event => event.type.includes('Button')).map(event => event.type)"), ['mouseButtonPressed', 'mouseButtonReleased']);
  await evaluate('window.__pointerEvents = []');
  await touch('touchStart', [[1, 80, 120]]); await new Promise(resolve => setTimeout(resolve, 600)); await touch('touchEnd', []);
  assert.deepEqual(await evaluate("window.__pointerEvents.filter(event => event.type.includes('Button')).map(event => event.values[0])"), [2, 2]);
  await evaluate('window.__pointerEvents = []');
  await touch('touchStart', [[1, 80, 120], [2, 150, 120]]); await touch('touchMove', [[1, 80, 160], [2, 150, 160]]); await touch('touchEnd', []);
  assert.ok(await evaluate("window.__pointerEvents.some(event => event.type === 'wheelRotations')"));
  assert.equal(await evaluate("window.__pointerEvents.filter(event => event.type.includes('Button')).length"), 0);
  await evaluate('window.__pointerEvents = []');
  await touch('touchStart', [[1, 80, 120]]); await touch('touchMove', [[1, 130, 150]]); await touch('touchCancel', []);
  assert.equal(await evaluate("window.__pointerEvents.filter(event => event.type === 'mouseButtonPressed').length"), await evaluate("window.__pointerEvents.filter(event => event.type === 'mouseButtonReleased').length"));
  await evaluate("window.__pointerEvents = []; document.getElementById('touch-test').dataset.touchMode = 'pan'");
  await touch('touchStart', [[1, 80, 120]]); await touch('touchEnd', []);
  assert.equal(await evaluate('window.__pointerEvents.length'), 0, 'pan mode must not send remote clicks');
  await evaluate("window.__disposeTouch(); document.getElementById('touch-test').remove()");
  assert.deepEqual(exceptions, []);
});
