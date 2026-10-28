# Self-host Relay on a Linux VM

This guide sets up your own Relay server with Docker workspaces, persistent storage, and private browser access through Tailscale. Use a Linux VM from your preferred provider, including Oracle Cloud, or a Linux server you already own. You supply and maintain the server and sign into your own GitHub and Codex accounts. The browser is a task inbox and review tool; server setup and Codex sign-in happen through SSH.

## Prerequisites

Use a supported Linux VM with Node.js 22.16 or newer, npm, Git, Docker Engine, Python 3, and C/C++ build tools (for `node-pty`). The workspace image installs its own Node/Git/build tools for project code. Build the image on the target machine so Docker selects the native architecture.

Start with a provisioned VM and working SSH access. Confirm its actual CPU, RAM, and disk allocation before choosing limits. If using a provider's free tier, check the current allowance and available capacity in your account. Keep access private with SSH forwarding or Tailscale; Relay defaults to loopback port 8080.

## First manual launch

Transfer this implemented checkout to the VM, including its lockfile. Do not transfer `.relay-data`, `.env`, `node_modules`, or the old-code backup unless deliberately restoring protected state.

```sh
npm ci
docker build -f infrastructure/Dockerfile.workspace -t relay-workspace:0.1.0 .
cp .env.example .env
npm run build
npm start
```

Run the server as a regular user with access to Docker. Do not run two Relay processes against the same data directory.

Relay opens directly without an access token. Local processes and anyone allowed to reach its Tailscale Serve endpoint have full control. Keep `RELAY_HOST=127.0.0.1`; Relay rejects other bind addresses. Old access-token files and `RELAY_ACCESS_TOKEN` environment settings are ignored.

For initial access, an SSH tunnel is sufficient:

```sh
ssh -L 8080:127.0.0.1:8080 your-user@your-vm
```

Open `http://127.0.0.1:8080` locally. For everyday access from your other devices, configure Tailscale below.

## Access from anywhere with Tailscale

Install [Tailscale on the Linux VM](https://tailscale.com/download/linux) and on each laptop, phone, or tablet you want to use. Connect them to the same personal Tailscale network. On the VM, authenticate through the link printed by:

```sh
sudo tailscale up
tailscale status
```

Once Relay is running on the VM, configure private HTTPS forwarding:

```sh
sudo tailscale serve --bg http://127.0.0.1:8080
tailscale serve status
```

Follow the HTTPS enablement link if prompted, then rerun the command if needed. Copy the actual `https://...ts.net` address from its output. Serve makes Relay accessible to devices allowed by your Tailscale access rules. The `--bg` configuration resumes after a reboot when Tailscale starts. [Serve documentation](https://tailscale.com/docs/features/tailscale-serve), [command reference](https://tailscale.com/docs/reference/tailscale-cli/serve).

Edit the VM checkout's `.env`, replacing the example hostname with that actual address:

```dotenv
RELAY_HOST=127.0.0.1
RELAY_PORT=8080
RELAY_PUBLIC_ORIGIN=https://your-vm.your-tailnet.ts.net
```

Use no trailing slash or path. Keep the other settings, especially `RELAY_DATA_DIR`. Restart Relay: restart `npm start` for a manual launch, or run `sudo systemctl restart relay` if you installed the service below. Relay checks this host and origin for HTTP requests and WebSocket connections.

On your other device, connect Tailscale and open that HTTPS URL. The task inbox opens directly: Tailscale controls remote access, and Relay has no additional login screen. GitHub and Codex still require their own logins. Restrict the service to your intended devices/users through your Tailscale access rules.

Daily use is now: connect Tailscale, open your saved Relay URL, and work. The VM and Relay must remain running. Tailscale must be connected on the viewing device. Enable the Relay systemd service below for startup after reboot.

Check access from a second network, then open a task and verify that its updates appear. If requests or sockets fail, check the exact `RELAY_PUBLIC_ORIGIN` and restart Relay. If the URL cannot be reached, check both devices in `tailscale status`, your Tailscale access rules, and `tailscale serve status`. If Serve reports a backend error, check that Relay is running on port 8080.

## First workspace and Codex login

Create a project from an HTTPS Git URL, an existing server-authorized `git@host:owner/repo.git` URL, or an empty repository. Private Git access uses the server user's Git/SSH setup. Never put an access token into the repository URL.

Sign into Codex once on the server as the same OS user that runs Relay. Set `DATA_DIR` to the absolute `RELAY_DATA_DIR` from your `.env` (`/var/lib/relay` with the supplied service unit, or the checkout's `.relay-data` for a manual launch), then run:

```sh
DATA_DIR=/var/lib/relay
mkdir -p "$DATA_DIR/codex"
docker run --rm -it --user "$(id -u):$(id -g)" \
  --mount "type=bind,src=$DATA_DIR/codex,dst=/codex" \
  -e CODEX_HOME=/codex -e HOME=/codex \
  relay-workspace:0.1.0 codex login --device-auth
```

Complete the displayed device login. If your account does not permit device authentication, use another supported Codex login method with the same mounted home. Relay does not implement its own OAuth flow. New environments share this login while keeping separate source directories and thread IDs. Keep the data directory private because it contains credentials.

Use **New task** to give Codex work in an isolated copy. Choose **Compare two attempts** to start two copies from the same snapshot. The inbox shows live runs and decisions that need you. Open a finished run, inspect the changed files, and apply its result when ready. Relay does not commit or push the applied files.

The browser has no editor or terminal. Use SSH and `docker exec` for manual repository setup, dependency installation, or Git commands. Dependency directories are not copied into attempts; install them in each attempt when needed, or ask the agent to do so.

## Install as a service

The supplied unit expects `/opt/relay` as the checkout, `/var/lib/relay` as persistent data, a `relay` account, and `/usr/bin/node`. Adapt those paths if your Node installation uses another location.

After placing the checkout in `/opt/relay`, prepare the service account and storage as an administrator:

```sh
sudo useradd --create-home --shell /bin/bash relay
sudo usermod -aG docker relay
sudo chown -R relay:relay /opt/relay
sudo install -d -o relay -g relay -m 700 /var/lib/relay
```

Skip account creation if that account already exists. As the `relay` user, install dependencies, build the application, build the workspace image, and configure `/opt/relay/.env`. Set `RELAY_DATA_DIR=/var/lib/relay` there so it matches the service unit. Ensure your origin is correct.

```sh
sudo cp /opt/relay/infrastructure/relay.service /etc/systemd/system/relay.service
sudo systemctl daemon-reload
sudo systemctl enable --now relay
sudo systemctl status relay
```

The Docker group gives the trusted backend host-level infrastructure access. Workload containers receive no Docker socket. If using rootless Docker, adapt the service group/environment to its socket rather than using this default unit unchanged.

Useful operations:

```sh
sudo journalctl -u relay -f
sudo systemctl restart relay
sudo systemctl stop relay
docker ps --filter label=relay.installation
```

## VM acceptance checklist

The local test suite does not replace these real-infrastructure checks:

1. Build and start the image on the VM's actual architecture. Check `node --version`, `git --version`, and `codex --version` with `docker run --rm relay-workspace:0.1.0 <command>`.
2. Log into Codex through the mounted home above. Ask it to create a small file and run a command. Verify the activity and changed file in Review.
3. Close all browser tabs while a task runs; reconnect and inspect the same run and its retained output.
4. Stop and restart a workspace. Verify files and the saved Codex login survive.
5. Create an isolated task from a dirty primary workspace. Verify its copied changes and check that the primary is unchanged before applying.
6. Launch two parallel tasks. Verify separate files/threads and observe their resource limits using `docker stats`. If testing a larger batch through the API, confirm extra tasks queue and completed workers free capacity.
7. Cancel one task that has a long-running shell command. Verify its container stops and its sibling continues.
8. Review and apply one result. Then create another result, modify the primary, and verify stale promotion is rejected.
9. Restart the backend during a task. Verify the old run is interrupted, queued work is retained, and no duplicate task is launched. Continue its conversation with a new prompt.
10. Reboot the VM. Verify the service starts, files/history survive, and interrupted tasks are not silently reported as running.

## Backup and cleanup

For a simple consistent backup, stop Relay and its remaining managed containers, then back up the entire data directory and `.env` to protected storage outside this VM. The directory contains source code, Git data, SQLite files, login credentials, and conversation history. Restart Relay afterward. Restore under the same OS ownership and rebuild the pinned image before starting workloads.

Discard temporary workspaces through the UI after retaining desired changes. This removes their containers/source trees and retains SQLite task history and stored proposals. Primary deletion and automatic expiry are intentionally unavailable in V1. Monitor disk usage: persistent event history and the shared Codex home currently have no automatic retention policy.

## Troubleshooting

- **Docker unavailable:** check the daemon and the backend user's Docker access. Existing task history remains available.
- **Image unavailable:** run the image build command; allow up to 15 seconds for the UI status to refresh.
- **Queued tasks do not start:** inspect idle primary/experiment containers and stop one, or adjust limits to fit the host. Parallel worker containers stop automatically when done.
- **Codex authentication failure:** repeat the mounted-home login command above as the Relay service user. You can replace `login --device-auth` with `login status` to inspect it.
- **Request origin rejected:** match `RELAY_PUBLIC_ORIGIN` to the exact browser origin and restart the backend.
- **Snapshot rejected:** remove unsupported symlinks/submodules or exclude generated output. Limits are 20,000 entries and 128 MiB of eligible source.
- **Interrupted promotion:** inspect the primary files and the SQLite operation record marked `needs-review`; do not assume the patch is unapplied. Resolve manually and take a fresh snapshot.
