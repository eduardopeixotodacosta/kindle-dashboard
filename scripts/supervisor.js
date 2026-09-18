#!/usr/bin/env node
// Keeps the backend alive and renders a fresh PNG on a fixed interval.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'out');
const PID_FILE = path.join(OUT, 'supervisor.pid');
const LOG_FILE = path.join(OUT, 'supervisor.log');
const BACKEND_LOG = path.join(OUT, 'backend.log');
const IMAGE = path.join(OUT, 'dash.png');
const PORT = positiveInt(process.env.PORT, 8787);
const INTERVAL_MS = positiveInt(process.env.RENDER_INTERVAL, 60) * 1000;
const RENDER_TIMEOUT_MS = positiveInt(process.env.RENDER_TIMEOUT, 30) * 1000;
const RENDER_LANG = (process.env.RENDER_LANG || '').trim();
const RESTART_MS = positiveInt(process.env.BACKEND_RESTART_DELAY, 5) * 1000;
const CHROME = findChrome();

let backend = null;
let renderTimer = null;
let restartTimer = null;
let stopping = false;
let rendering = false;

function positiveInt(value, fallback) {
  const parsed = Number.parseInt(value || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function playwrightChromeCandidates() {
  const root = path.join(require('os').homedir(), '.cache', 'ms-playwright');
  const out = [];
  try {
    for (const dir of fs.readdirSync(root)) {
      if (!dir.startsWith('chromium')) continue;
      out.push(path.join(root, dir, 'chrome-linux', 'headless_shell'));
      out.push(path.join(root, dir, 'chrome-linux', 'chrome'));
    }
  } catch { /* sem cache do Playwright */ }
  return out;
}

function findChrome() {
  const candidates = [
    process.env.CHROME,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    '/usr/bin/google-chrome',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    ...playwrightChromeCandidates(),
  ].filter(Boolean);
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (!found) throw new Error('Chrome not found; set CHROME to a Chrome/Chromium binary');
  return found;
}

function log(message) {
  const line = `[${new Date().toISOString()}] ${message}`;
  fs.appendFileSync(LOG_FILE, line + '\n');
  console.log(line);
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function claimPidFile() {
  fs.mkdirSync(OUT, { recursive: true });
  try {
    const oldPid = Number.parseInt(fs.readFileSync(PID_FILE, 'utf8'), 10);
    if (oldPid && oldPid !== process.pid && processIsAlive(oldPid)) {
      throw new Error(`supervisor already running with PID ${oldPid}`);
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  fs.writeFileSync(PID_FILE, String(process.pid));
}

function startBackend() {
  if (stopping || backend) return;

  const logFd = fs.openSync(BACKEND_LOG, 'a');
  backend = spawn(process.execPath, [path.join(ROOT, 'backend', 'server.js')], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', logFd, logFd],
    windowsHide: true,
  });
  fs.closeSync(logFd);
  log(`backend started pid=${backend.pid}`);

  backend.once('exit', (code, signal) => {
    log(`backend exited code=${code ?? '-'} signal=${signal ?? '-'}`);
    backend = null;
    if (!stopping) {
      restartTimer = setTimeout(startBackend, RESTART_MS);
    }
  });
}

async function backendIsReady() {
  try {
    const response = await fetch(`http://127.0.0.1:${PORT}/api/ping`, {
      signal: AbortSignal.timeout(5000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

function runChrome(args) {
  return new Promise((resolve) => {
    const child = spawn(CHROME, args, {
      cwd: ROOT,
      stdio: 'ignore',
      windowsHide: true,
    });
    let settled = false;
    let exited = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      // SIGKILL guarda pelo exit real do processo, nao pelo settle da promise:
      // finish() abaixo ja marca settled antes dos 2s.
      setTimeout(() => {
        if (!exited) child.kill('SIGKILL');
      }, 2000).unref();
      finish({ ok: false, timeout: true });
    }, RENDER_TIMEOUT_MS);
    timer.unref();
    child.once('error', (error) => finish({ ok: false, error }));
    child.once('exit', (code, signal) => {
      exited = true;
      finish({ ok: code === 0, code, signal });
    });
  });
}

async function render() {
  if (stopping || rendering) return;
  rendering = true;
  const tempImage = path.join(OUT, `dash-${process.pid}.tmp.png`);

  try {
    if (!(await backendIsReady())) {
      log('render skipped: backend is not ready');
      return;
    }

    const result = await runChrome([
      '--headless=new',
      '--disable-gpu',
      '--hide-scrollbars',
      '--force-device-scale-factor=1',
      '--window-size=1072,1448',
      '--virtual-time-budget=5000',
      `--screenshot=${tempImage}`,
      `http://127.0.0.1:${PORT}/render${RENDER_LANG ? `?lang=${encodeURIComponent(RENDER_LANG)}` : ''}`,
    ]);

    if (!result.ok) {
      log(`render failed: ${result.timeout ? `chrome timeout after ${RENDER_TIMEOUT_MS / 1000}s` : result.error ? result.error.message : `chrome exit ${result.code}${result.signal ? ` signal ${result.signal}` : ''}`}`);
      return;
    }

    const stat = fs.statSync(tempImage);
    if (stat.size === 0) throw new Error('Chrome produced an empty image');

    try {
      fs.renameSync(tempImage, IMAGE);
    } catch (error) {
      if (!['EEXIST', 'EPERM'].includes(error.code)) throw error;
      fs.copyFileSync(tempImage, IMAGE);
      fs.unlinkSync(tempImage);
    }
    log(`render ok (${stat.size} bytes)`);
  } catch (error) {
    log(`render failed: ${error.message}`);
  } finally {
    try {
      fs.unlinkSync(tempImage);
    } catch {}
    rendering = false;
  }
}

function scheduleRender() {
  const tick = async () => {
    await render();
    if (!stopping) renderTimer = setTimeout(tick, INTERVAL_MS);
  };
  renderTimer = setTimeout(tick, 2000);
}

function cleanupPidFile() {
  try {
    if (fs.readFileSync(PID_FILE, 'utf8').trim() === String(process.pid)) {
      fs.unlinkSync(PID_FILE);
    }
  } catch {}
}

function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  log(`received ${signal}; stopping`);
  clearTimeout(renderTimer);
  clearTimeout(restartTimer);
  if (backend) backend.kill('SIGTERM');
  cleanupPidFile();
  setTimeout(() => process.exit(0), 1000).unref();
}

claimPidFile();
log(`supervisor started pid=${process.pid} port=${PORT} interval=${INTERVAL_MS / 1000}s`);
startBackend();
scheduleRender();

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('exit', cleanupPidFile);
process.on('unhandledRejection', (reason) => {
  log(`unhandled rejection: ${String(reason)}`);
  shutdown('unhandledRejection');
});
process.on('uncaughtException', (error) => {
  log(`uncaught exception: ${error.stack || error.message}`);
  shutdown('uncaughtException');
});
