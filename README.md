# Relay

Relay is a small, self-hosted control room for coding agents. Give Codex a task from your phone or desktop, leave it running on your server, and return to see what happened. You can answer approval requests, continue a run, compare two attempts, and review changes before applying them to your project.

The interface has a task inbox and a focused detail view. On desktop they sit side by side; on mobile you open one task at a time. Relay does not include a browser IDE or terminal.

## How it works

- Add a project from a Git URL or start with an empty repository.
- Start one isolated attempt or two approaches from the same source snapshot.
- Follow live activity and approvals. Runs continue when the browser closes.
- Review changed files and explicitly apply one result to the primary project. Relay does not commit or push the result.

Runs and events are stored in SQLite. Project files and the shared Codex login are stored in the Relay data directory. Relay currently supports one owner, trusted repositories, and Codex. Access is controlled by localhost or Tailscale Serve; there is no separate Relay login.

## Set up

See the [Linux VM setup guide](docs/vm_setup.md) for setup. You'll need a Linux VM or server, Docker, Node.js, and your own Codex account. The guide includes requirements, service setup, first-workspace instructions, and troubleshooting.

Once configured, connect Tailscale on your device and open your server's Relay URL. Your server hosts the platform and stores your work.

Relay is intended for one owner working on trusted repositories. Remote access is controlled by Tailscale; there is no separate Relay login. Future plans for this project include allowing for multiple owners to access without need tailscale. Seperate auth is WIP tho. 

## Note

this is a cleaned up-version of the prior repo, other repo is deprecated now.
