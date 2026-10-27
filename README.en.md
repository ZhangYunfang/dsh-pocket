<p align="center">
  <img src="docs/banner.jpg" alt="DSH Pocket" width="100%">
</p>

<h1 align="center">DSH Pocket</h1>

<p align="center"><a href="README.en.md">English</a> | <a href="README.md">中文</a></p>

<p align="center">
  <a href="https://www.npmjs.com/package/dsh-pocket"><img alt="npm" src="https://img.shields.io/npm/v/dsh-pocket?color=4d6bfe&label=npm"></a>
  <a href="https://www.npmjs.com/package/dsh-pocket"><img alt="downloads" src="https://img.shields.io/npm/dm/dsh-pocket?color=4d6bfe"></a>
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-GPL--2.0-red.svg"></a>
  <a href="https://github.com/daha1216/dsh-pocket/stargazers"><img alt="GitHub stars" src="https://img.shields.io/github/stars/daha1216/dsh-pocket"></a>
  <a href="https://awesome-dsh-plugin.com"><img alt="Awesome DSH Plugin" src="https://awesome-dsh-plugin.com/badge.svg"></a>
</p>

> Put **DeepSeek Harness in your pocket**: one package, one settings tab — scan a QR code on the same Wi-Fi to see your computer's UI live. For access from elsewhere, configure your own Cloudflare fixed hostname and Tunnel Token first.

> **This is a personal fork (clean-merge edition)**: a clean merge of the latest [shaobeichen/dsh-pocket](https://github.com/shaobeichen/dsh-pocket) (GPL-2.0) and the mobile-layer upstream [mexiaosqwq/dsh-web-mobile](https://github.com/mexiaosqwq/dsh-web-mobile) (MIT) — no extra self-use features, only upstream syncs and compatibility fixes; maintained by **daha1216 (大哈)**. For upstream features, updates and releases see the [upstream repo](https://github.com/shaobeichen/dsh-pocket).

<p align="center">
  ⭐ A Star would make daha1216's day &nbsp;·&nbsp; <a href="https://github.com/daha1216/dsh-pocket">Star it on GitHub</a>
</p>

## What is this

**You want to use DeepSeek Harness on your computer, even when you're not at the computer.**

- On your way home, the agent is running a task on your computer — pull out your phone and see where it is, what it produced.
- Out and about, you want the agent on your computer to look something up or write a snippet — no remote desktop, no SSH.
- The computer is at home or in the office, you're elsewhere, and you want to **drive your DeepSeek Harness from your phone** — send tasks, watch the output, tap approvals.

That's what DSH Pocket does: **install it, scan a QR code on the same Wi-Fi, and your phone shows and controls the DeepSeek Harness UI in real time.** Public access requires your own Cloudflare fixed hostname and Tunnel Token. Without that configuration, public access stays off and LAN access works as usual.

What it looks like — the phone shows the exact same UI as your computer, live:

<p align="center">
  <img src="docs/interface.jpg" alt="DSH UI on the phone" width="100%">
</p>

## ✨ Features

| Feature                      | Description                                                                                                                                                                                                                                                                       |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 📶 LAN QR access             | Works out of the box: Settings → Phone access — scan the LAN QR on the same Wi-Fi (auto-detects the LAN IP; **under WSL it picks the Windows host's physical NIC IP**)                                                                                                            |
| 🚪 LAN switch                | **Turn LAN access off/on with one click** in Settings (a confirmation dialog shows each time): off kills the LAN QR code and link instantly; public access is unaffected                                                                                                          |
| 🌐 Public QR (from anywhere) | Configure your own Cloudflare fixed hostname + Tunnel Token, accept the disclaimer, then enable public access to scan from another network; **stays off until configured** |
| 🏷️ Fixed public hostname     | Only user-configured **Cloudflare named tunnels** are supported; no random public addresses. The hostname stays fixed, and **saving does not start public access** |
| 🔐 Access PIN                | The plugin uses a random **8-character public PIN** by default, unchanged by public-access stops/starts or DSH restarts. LAN has its own random **8-character PIN** (on by default; switchable off in Settings for direct LAN access) |
| 🔑 Custom PINs               | Set the public and LAN PINs to **8–64 letters and digits in Settings**; manage them yourself and change them if they leak |
| 🧘 Session persistence       | Enter the PIN once and you're set for a long time (login is tied to the computer's dsh web process: as long as it stays up, the phone won't ask again; **after a dsh web restart/update, enter it once more**)                                                                    |
| ⚡ Real-time sync            | Streaming output passes through WebSocket untouched — what the computer renders, the phone renders live; fully interactive both ways; built-in WS heartbeat keep-alive (defeats silent NAT/battery link drops with auto-reconnect)                                                |
| 📱 Mobile-adaptive layout    | Narrow screens get a drawer layout automatically (ported from dsh-web-mobile, MIT): sidebar drawer, full-width conversation, safe-area insets, touch optimizations                                                                                                                |
| 🧭 Optional right sidebar    | Shows the native right-sidebar entry on mobile; disable it for a compact phone header or keep it available alongside the terminal dock on an unfolded display                                                                                                                     |
| 📏 Mobile font size          | Defaults to "Follow desktop", so desktop font changes also affect the phone. Choose a **specific size (12–22px)** for independent mobile text sizing without changing the desktop setting |
| 📁 File browser              | The mobile "Files" entries need a host-side explorer panel (a dsh-web-ui component); on stock DSH without it the entries are auto-hidden instead of doing nothing                                                                                                                 |
| 🗜️ Transfer compression      | Large JSON responses are gzip/brotli'd on the fly (17MB session history → ~1MB; brotli quality 6: fast and bandwidth-friendly) — faster loads, less mobile data                                                                                                                   |
| 🔁 Tunnel auto-restore       | Only previously enabled, fully configured named tunnels are restored. Old Quick Tunnel markers do not restore random tunnels; public access stays off without configuration |
| 🧩 Single-package install    | One npm package, one settings tab — no core/adapter split. LAN needs no public configuration; public access requires your own Cloudflare account, domain and Tunnel Token |

## 🚀 Usage

**Where the entry is**: after installing and restarting `dsh web`, open **Settings** — the left sidebar shows **"Phone access"** at the top level (same level as General / Models):

<p align="center">
  <img src="docs/entry.jpg" alt="Phone access entry" width="70%">
</p>

**Prerequisite**: [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) installed. If your terminal says `dsh: command not found`, install it first:

```sh
npm install -g @deepseek-ai/dsh     # global install; verify: dsh --version
# No global install? Prefix every command with: npx @deepseek-ai/dsh
```

```sh
# 1. Install the plugin (everything in one package)
dsh plugin --profile web add github:daha1216/dsh-pocket -w

# 2. Restart dsh web
npx @deepseek-ai/dsh web
```

> **Which package is this**: this repository is a fork of [dsh-pocket](https://github.com/shaobeichen/dsh-pocket). The `dsh-pocket` package on npm belongs to the upstream author (currently 2.12.0) and is **not** this 3.x line. Install with the GitHub address shown above.
>
> **Compatibility**: `engines.dsh` declares `^0.2.0-rc.1`, i.e. **DSH 0.2.0-rc.1 up to (but not including) 0.3.0**. On an unsupported runtime the plugin manager refuses with `incompatible-version`; add a one-off exemption with `dsh plugin allow-version` if you really need to try it elsewhere. Once DSH reaches 0.3.x this plugin needs a new release to widen the range.

### LAN (same Wi-Fi)

Settings → **Phone access** → scan the "📶 LAN" QR code → enter the **LAN PIN** (shown in the LAN block; hit **Refresh** to roll a new one, or **Customize** to set an 8–64-character alphanumeric PIN) → the phone opens the exact same DSH, in real time.

> The "**LAN access**" switch is **on by default** and can be **turned off/on with one click** (a confirmation dialog shows each time). Off kills the LAN QR code and link instantly (phones can't open them); **public access is unaffected**. Tap "On" to restore it.
>
> The LAN PIN is **on by default** (security-first). If you're the only user and find typing it every time annoying, flip "LAN access PIN" to **Off** in the LAN block — LAN scans then connect directly with no PIN (LAN-only devices; the **public tunnel always requires a PIN**, unaffected).
>
> After logging in once, the phone **won't ask again**: as long as the computer's dsh web keeps running, reopening the phone needs no PIN (**a dsh web restart/update asks for it once more**).
>
> Advanced option: auto-detection may not pick a reachable address for Tailscale/VPN setups. You can select a detected IP from the "LAN address" dropdown; normally no change is needed.

### Public access (your own fixed hostname only)

**This plugin does not provide a ready-made public address and no longer supports random hostnames / Quick Tunnel.** You need your own **Cloudflare account, domain and named-tunnel Token**. Public access stays off until the configuration is complete; **LAN access needs none of this configuration**.

1. In [Cloudflare Zero Trust](https://one.dash.cloudflare.com/) → **Networks → Tunnels**, create a named tunnel and copy its **Tunnel Token**.
2. Add your own **Public Hostname** route to that tunnel (e.g. `pocket.example.com`). Set its **Service to the actual local proxy port**, usually `http://127.0.0.1:3081`. If you changed the port, use that port instead. Do not point it at the original DSH Web port (usually 3080), which would bypass Pocket's access controls.
3. In Settings → Phone access → Public configuration, click "**Configure public access**", enter the fixed hostname and Tunnel Token, and save. **Saving only stores the configuration; it does not start public access.** If you change an active configuration, turn public access off and on again to apply it.
4. Click "**Enable anywhere**" → **read and accept the security disclaimer on every manual enable** (on a corporate/classified network, confirm compliance first) → wait for the tunnel (the first run downloads cloudflared) → scan the public QR code and enter the access PIN to connect from another network.

The public address is your configured hostname and **does not change on restart**. The plugin's public PIN defaults to a random **8-character PIN**, customizable to **8–64 letters and digits**. **Neither generated nor custom PINs rotate automatically when public access stops/starts or DSH restarts.** Use a strong PIN and change it yourself if it leaks. The Tunnel Token is stored locally only (`$DSH_HOME/dsh-pocket/settings.json`, readable by your user only) and is never echoed back in the UI.

**Upgrade compatibility:** old Quick Tunnel enable/restore markers do not restore random tunnels; public access stays off without configuration. Complete existing Named Tunnel hostname/Token configurations remain usable. Only a previously enabled named tunnel with a restore marker and complete configuration auto-restores after a DSH restart. A factory reset stops public access and clears the hostname, Token and restore marker; public access stays off until configured again.

> Upgrading: re-run the `add` command above (the GitHub address carries no tag, so it installs the latest commit on the default branch). To pin a version, write `github:daha1216/dsh-pocket#v3.0.4` instead, and re-`add` with the new tag when you want to move.

### CLI public access

Running `dsh-pocket` without `--public` provides LAN access only. Before using `dsh-pocket --public`, save your own fixed hostname and Tunnel Token in Settings. **The CLI must use the same `DSH_HOME` as the DSH instance used to save that configuration.** Missing configuration does not create a public tunnel.

The Cloudflare hostname route's **Service must target the CLI's actual listening port** (3081 by default; for example, `dsh-pocket --public --port 3082` requires `http://127.0.0.1:3082`). Do not let the plugin proxy and CLI compete for the same port, or route to the original DSH Web port. The CLI PIN is separate from the plugin's settings: it is generated per run by default; set your own with `--pin <value>` or `DSH_POCKET_PIN=<value>`.

## ⚠️ Security (read first)

- **DSH can execute code on your computer.** **LAN** QR/URL plus its own **8-character PIN** is the key (PIN **on by default**, switchable off — then LAN scans connect directly, same-network devices only) — **never share the LAN QR, URL or PIN**.
- **Read and accept the security disclaimer every time you manually enable public access in Settings** (the server enforces acceptance for start requests): public access exposes a code-executing DSH to the internet — use a strong PIN, turn it off when done, never use it on classified networks. Named tunnels may auto-restore after a restart; turn access off manually if you do not want it restored.
- **Plugin public access** uses a random **8-character PIN** by default, customizable to **8–64 letters and digits**. **Generated and custom PINs do not rotate on public-access stops/starts or DSH restarts.** If the address and PIN leak, turn public access off immediately and change the PIN yourself; restarting does not invalidate it.
- Phone login state is tied to the computer's dsh web process: **no re-entry while dsh web stays up; one re-entry after a restart/update**.
- **Login rate limiting** (anti brute-force): **5** consecutive wrong PINs from the same IP lock it for **60s**; a global failure threshold briefly locks everyone (blocks distributed IP-rotation scans); a successful login resets the counter.
- Your own Cloudflare hostname and named-tunnel route determine the public address; **restarts do not change it**. A fixed hostname is a persistent scanning target. Protect both the Tunnel Token and access PIN, and turn access off when done.
- **Public detection is fail-closed** (issue #66): everything except loopback and private LAN addresses is treated as **public and PIN-gated** — including any self-hosted tunnel / reverse proxy pointing at the local port with its own hostname. There is no "change the domain to bypass the PIN" hole.
- LAN mode exposes nothing publicly; only devices on the same network can reach it.
- Built for personal use; the plugin's public PIN lives in `$DSH_HOME/dsh-pocket/token` (not rotated on stop/start or restart), the LAN PIN in `$DSH_HOME/dsh-pocket/token-lan` (refreshed manually in Settings), and switches, custom flags and public configuration in `$DSH_HOME/dsh-pocket/settings.json`.
- **CLI mode (`dsh-pocket`) also requires a PIN by default**: a random 8-digit PIN is printed in the terminal and embedded in the QR code; manual address entry requires the PIN, while loopback access is exempt. Use `--pin <value>` or `DSH_POCKET_PIN=<value>` to set it yourself (at least 6 characters). `--no-auth` disables protection and is **not recommended**: anyone who can reach the port could operate a code-executing DSH.

## 💻 DSH Desktop

- In the desktop app, **QR screen-mirroring works**; **update/restart are managed by the desktop app** (auto-disabled here).
- ⚠️ The desktop **advanced mode** doesn't support phone access yet (it disables the web layout; the phone gets no layout service → blank screen). Switch back to **compatibility** mode and restart; phones opening an advanced-mode page will see a clear notice overlay.

## 🩹 Troubleshooting (traps users step on)

| Symptom                                                                         | Cause & fix                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dsh: command not found` / "DSH is not defined"                                 | dsh CLI missing: `npm install -g @deepseek-ai/dsh`, or prefix commands with `npx @deepseek-ai/dsh`                                                                                                                                                                                                                                                                                                                               |
| `ERR_PNPM_ADDING_TO_ROOT`                                                       | pnpm 9 workspace-root restriction: append `-w` (`--workspace-root`) to install/update commands                                                                                                                                                                                                                                                                                                                                   |
| Nothing changed after install/update                                            | **You must restart `dsh web`**; the running process still loads the old code                                                                                                                                                                                                                                                                                                                                                     |
| `listen EADDRINUSE ... :3081`                                                   | A stale dsh-pocket process holds the port: macOS/Linux `lsof -ti :3081 \| xargs kill -9`; Windows `netstat -ano \| findstr :3081` (find the LISTENING PID) → `taskkill /PID <PID> /F`, then retry                                                                                                                                                                                                                                |
| Want a different port (issue #70)                                               | Plugin mode: write `"proxyPort": 3082` into `$DSH_HOME/dsh-pocket/settings.json` and restart `dsh web`. CLI mode: `dsh-pocket --port 3082`. If the port is taken you'll get `EADDRINUSE` — kill the old process or pick another one                                                                                                                                                                                              |
| Issue a temporary PIN to a guest                                                | Not available: the temporary access PIN feature (issue #69) was removed in 2.6.x (it crashed on revoke). To share access, send the main PIN or a `?token=<main PIN>` link, then hit "Refresh" in Settings once the guest is done                                                                                                                                                                                                 |
| cloudflared install fails on a remote Linux server (issue #45)                  | If all CDN sources (GitHub / ghproxy / gh.ddlc / gh-proxy) are unreachable on a remote Linux host, install `cloudflared` yourself (e.g. `apt install cloudflared`, `dnf install cloudflared`, or download the tgz and unpack it), then add `"cloudflaredPath": "/path/to/cloudflared"` into `$DSH_HOME/dsh-pocket/settings.json` and restart `dsh web`. The plugin will then use that binary directly and skip the auto-download |
| Install fails with `incompatible-version`                                       | This plugin requires DSH **0.2.0-rc.1 – 0.2.x**: check `dsh --version`, upgrade DSH, or add a one-off exemption with `dsh plugin allow-version`                                                                                                                                                                                                                                                                                   |
| Public `error 1033`                                                             | See "Public tunnel troubleshooting" below — usually a local proxy/VPN (Clash etc. TUN mode) killing the tunnel                                                                                                                                                                                                                                                                                                                   |
| After "Restart dsh web", the page says the process is running in the background | The new process from in-page self-restart is a detached background process (not attached to your terminal) — that's the standard way to apply updates in-page; stop it: macOS/Linux `lsof -ti :3080 \| xargs kill -9`; Windows `netstat -ano \| findstr :3080` → `taskkill /PID <PID> /F` (logs under `$DSH_HOME` as `dsh-pocket-restart-*.log`)                                                                                 |

## ⚠️ Public tunnel troubleshooting (read first)

**Symptom**: after clicking "Enable anywhere", the public URL shows `error 1033` (Tunnel error) on the phone.

**Most common cause: a local proxy/VPN (Clash, Surge, v2ray, sing-box, etc., especially in TUN mode).**
Such tools take over all traffic and often cut cloudflared's tunnel-edge connections
(`*.argotunnel.com`, Cloudflare edge IPs), so the tunnel registers but the data plane never connects.

**Fix (try in order, lightest first)**:

1. First **just turn off the proxy's TUN mode** — no need to quit the proxy; this is enough in most cases:
   - Clash: turn off the "**TUN mode**" toggle in Settings (or right-click the menu-bar icon → uncheck TUN mode)
   - Surge: turn off "**Enhanced mode**"; v2ray/sing-box: turn off "**virtual NIC / route takeover**"
   - Then go back to the settings page and click "Enable anywhere" again
2. If that's not enough, temporarily **fully quit the proxy** (not just close the window: quit Clash from the menu-bar icon; if a
   background service is installed, stop it in the service manager and confirm with `ps aux | grep clash`), then retry.
3. Add **DIRECT rules** to the proxy for the tunnel domains and Cloudflare edge (Clash example):
   ```yaml
   - DOMAIN-SUFFIX,argotunnel.com,DIRECT
   - IP-CIDR,198.41.192.0/24,DIRECT,no-resolve
   ```
4. If the network really can't reach the tunnel, use **LAN mode**: turn on the phone hotspot → connect the computer to it → scan the LAN QR. Same experience, from anywhere.

**Other causes**: corporate firewalls / campus networks blocking outbound — ask IT to allow it, or use a hotspot.

**First run: "Downloading cloudflared" fails or hangs**:

- **macOS/Linux**: the plugin first downloads from the **Tsinghua mirror** (measured ~3MB/s, done in seconds); falls back to official GitHub + acceleration mirrors if it fails.
- **Windows**: no Tsinghua mirror (Homebrew doesn't support Windows) — downloads the ~50MB exe from GitHub directly; **single-threaded, so it's slower — that's expected**, wait a few minutes, or use a proxy.
- If all sources fail, the settings page shows a hint. Alternatives (any one):

1. Install the `cloudflared` command and retry (the plugin then uses the PATH binary, no download):
   - macOS: `brew install cloudflared`; Linux: `sudo apt install cloudflared` or from the official site
   - Windows: `winget install cloudflared` or from the official site
   - Any platform: `npm i -g cloudflared`
2. Enable a proxy (system proxy / Clash etc.) and click "Enable anywhere" again
3. Manually download the binary into `$DSH_HOME/dsh-pocket/bin/` (`$DSH_HOME` is usually `~/.dsh`, on Windows `%USERPROFILE%\.dsh`; name it `cloudflared` (add `.exe` on Windows) **or** the release asset name — both are recognized)

## 🗂 Architecture (single package)

| File                 | Purpose                                                                                                                                                                                                                      |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lib/index.js`       | Plugin entry: auto-start proxy + register RPC + PIN management (public: 8 characters, not rotated on stop/start or restart; LAN: separate 8 characters, manually refreshable / switchable) + LAN access switch + DSH Desktop detection |
| `lib/settings.mjs`   | Settings persistence: LAN access switch (on by default) + LAN-PIN switch (on by default) stored in `$DSH_HOME/dsh-pocket/settings.json`                                                                                      |
| `lib/service.mjs`    | Service: proxy lifecycle (port auto-fallback), user-configured named tunnel (restore requires complete configuration and a valid marker), status snapshot (with QR data URLs) |
| `lib/proxy.mjs`      | Header-rewriting reverse proxy: Host/Origin → loopback, HTTP + WebSocket passthrough + polyfill injection + gzip/brotli compression + per-host token auth (public always; LAN per switch) + blocks LAN Hosts when LAN is off |
| `lib/tunnel.mjs`     | cloudflared: multi-mirror download (Tsinghua first) / adaptive parallel / start a named tunnel with the user's Tunnel Token (HTTP/2) |
| `lib/web-rpc.js`     | Loopback RPC: `status` / `tunnel.start` / `tunnel.stop` / `lan.setEnabled` / `version` / `update` / `restart`                                                                                                                |
| `client/`            | "Phone access" settings tab + mobile adaptation (dsh-web-mobile port)                                                                                                                                                        |
| `bin/dsh-pocket.mjs` | CLI: LAN/public modes, prints URL + QR                                                                                                                                                                                       |

## 🛠 Development

```sh
npm install
node client/build.mjs   # rebuild after editing client/
npm test                # proxy / auth / compression / tunnel / service / RPC / settings (109 tests)
```

**Want to try your changes locally without publishing?** Point the installed plugin at your local checkout with a symlink and restart dsh web. Full steps (including switching back to the npm release) are in [LOCAL-DEV.md](./LOCAL-DEV.md).

## 🤝 Credits

- Mobile adaptation ported from [mexiaosqwq/dsh-web-mobile](https://github.com/mexiaosqwq/dsh-web-mobile) (MIT)
- Public tunnel powered by [cloudflared](https://github.com/cloudflare/cloudflared)

## 📄 License

[GPL-2.0](LICENSE) — copyleft: free to use, modify, and redistribute, but **derivatives must stay GPL** and keep the copyright notice; commercial use included.

> Note: the mobile-adaptation portion is ported from [dsh-web-mobile](https://github.com/mexiaosqwq/dsh-web-mobile) (MIT, GPL-compatible); its copyright notice stays in `client/mobile/LICENSE.dsh-web-mobile`.

---

**Questions? Feedback welcome**: bugs, ideas, or feature requests — open an issue at [GitHub Issues](https://github.com/shaobeichen/dsh-pocket/issues) 🙏
