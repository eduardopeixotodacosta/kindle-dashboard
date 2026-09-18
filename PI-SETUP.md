# Raspberry Pi Setup (headless, no Electron)

Runs the dashboard 24/7 on a Raspberry Pi (or any Linux box) using the
standalone supervisor: plain Node backend + Chrome headless PNG render.
Phones use `/mobile`; the Kindle downloads `/dash.png` as usual.

Everything installs in user space — no `sudo` required.

## Requirements

- 64-bit OS (`uname -m` must print `aarch64`). Pi 3/4/5 with 64-bit
  Raspberry Pi OS or Debian.
- Node.js >= 24 (the backend uses `node:sqlite`).
- Chromium runtime libs (present on desktop images; on Lite images install
  Chromium via `sudo apt install chromium` instead of the Playwright shell).

## 1. Node.js (user space)

```bash
mkdir -p ~/opt ~/.local/bin
cd ~/opt
curl -fsSLO https://nodejs.org/dist/v24.18.0/node-v24.18.0-linux-arm64.tar.xz
tar -xf node-v24.18.0-linux-arm64.tar.xz && rm node-v24.18.0-linux-arm64.tar.xz
ln -sfn ~/opt/node-v24.18.0-linux-arm64 ~/opt/node
echo 'export PATH=$HOME/opt/node/bin:$HOME/.local/bin:$PATH' >> ~/.profile
```

## 2. Project

Copy the project to `~/kindle-dashboard` (git clone or rsync from the dev
machine). The backend and supervisor use only Node core modules — `npm
install` is NOT needed on the Pi.

## 3. Chromium (headless render)

```bash
npx -y playwright install chromium-headless-shell
```

The supervisor finds the Playwright headless shell automatically (it also
checks `/usr/bin/chromium*`; `CHROME=<path>` overrides).

## 4. Codex CLI

```bash
npm install -g @openai/codex
```

Auth: log in on the Pi itself with `codex login --device-auth` (prints a URL
and a one-time code; open the URL in any browser). Do NOT copy
`~/.codex/auth.json` from another machine: the refresh token is single-use
and rotating, so the first machine to refresh invalidates the other's copy
(OpenAI docs; openai/codex issues #15410, #15502).

The Codex collector reads local rollout files, so the Pi needs to run a
session periodically for fresh account-level rate limits. The
`codex-refresh.timer` unit does that every 3 hours with a minimal prompt.

## 5. Claude Code CLI

```bash
curl -fsSL https://claude.ai/install.sh | bash
claude   # complete the OAuth login once (URL + paste code)
```

Log in on the Pi itself (own OAuth grant). Do not keep long-term a
`.credentials.json` copied from another machine: when two machines refresh
the same grant, the tokens invalidate each other. The access token expires
after a few hours, so enable `claude-refresh.timer` (below) to keep it
renewed once the login is done.

## 6. systemd user units

```bash
mkdir -p ~/.config/systemd/user
cp ~/kindle-dashboard/scripts/pi/*.service ~/kindle-dashboard/scripts/pi/*.timer ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now kindle-dashboard.service codex-refresh.timer
# after `claude` login on the Pi:
systemctl --user enable --now claude-refresh.timer
loginctl enable-linger $USER   # start at boot without an open session (may prompt for auth)
```

`kindle-dashboard.service` sets `RENDER_LANG=pt-BR` for the PNG language;
edit the unit to change it. Render interval: `RENDER_INTERVAL` (seconds,
default 60). Chrome capture timeout: `RENDER_TIMEOUT` (seconds, default 30; a
hung Chrome is killed so the next render is not blocked). Port: `PORT`
(default 8787).

## 7. Verify

```bash
curl http://<IP_DO_PI>:8787/api/ping
curl http://<IP_DO_PI>:8787/api/usage
curl -o /tmp/dash.png http://<IP_DO_PI>:8787/dash.png
```

- iPhone/Android: `http://<IP_DO_PI>:8787/mobile`
- Kindle: point `DASHBOARD_URL` to `http://<IP_DO_PI>:8787/dash.png`
  (see [KINDLE-INSTALLATION.md](KINDLE-INSTALLATION.md)).

Logs:

```bash
systemctl --user status kindle-dashboard.service
tail -f ~/kindle-dashboard/out/supervisor.log
```
