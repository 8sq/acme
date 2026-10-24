# Dev Container

Includes everything needed to work on the project, and keeps compromised
dependencies away from the rest of your environment.

Open the repo in VS Code and accept the prompt, or run
"Dev Containers: Reopen in Container".

The repo is mounted at the same path as on the host, so git worktrees made
outside the container keep working inside the container.

`sudo` needs no password. Installed packages are lost on rebuild unless added
to the Dockerfile or `user/build.sh`.

## Per-user customizations

Files in `user/` are gitignored and optional:

- `user/id`: `uid:gid` for the container user. On Linux, set it to your host
  ids to skip the slow uid sync on every rebuild:
  `echo "$(id -u):$(id -g)" > .devcontainer/user/id`
- `user/build.sh`: runs as the container user at image build, e.g. to install
  dotfiles. Changes to it require a rebuild.
