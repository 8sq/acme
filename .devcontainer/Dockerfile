FROM node:24.22.1-trixie

# pnpm switches itself to the version pinned in package.json
RUN npm install -g pnpm

RUN apt-get update -y \
  && apt-get install -y sudo curl locales build-essential git \
  && echo 'en_US.UTF-8 UTF-8' > /etc/locale.gen \
  && locale-gen \
  && rm -rf /var/lib/apt/lists/*

ARG USERNAME=dev

# Use uid:gid from .devcontainer/user/id if it exists.
# The [d] makes that path a glob, skipping it if it does not exist.
COPY .devcontainer/user/.gitignore .devcontainer/user/i[d] /tmp/user/
RUN uid=1000 gid=1000 \
  && { [ ! -f /tmp/user/id ] || IFS=: read -r uid gid < /tmp/user/id; } \
  && rm -rf /tmp/user \
  && getent passwd "$uid" | cut -d: -f1 | xargs -r userdel -r \
  && { getent group "$gid" > /dev/null || groupadd -g "$gid" $USERNAME; } \
  && useradd -m -u "$uid" -g "$gid" -s /bin/bash $USERNAME

# Make the default user a passwordless sudo-er
RUN usermod -aG sudo $USERNAME \
  && echo "$USERNAME ALL=(ALL) NOPASSWD: ALL" > /etc/sudoers.d/$USERNAME

USER $USERNAME

# Silence the sudo hint on login
RUN touch /home/$USERNAME/.sudo_as_admin_successful

# Fetch the pinned pnpm into the image instead of on first use
COPY --chown=$USERNAME:$USERNAME package.json pnpm-lock.yaml /tmp/workspace/
RUN cd /tmp/workspace/ \
  && pnpm --version \
  && rm -rf /tmp/workspace

# Optional per-user setup (gitignored), e.g. dotfiles
COPY --chown=$USERNAME:$USERNAME .devcontainer/user /tmp/user
RUN [ ! -f /tmp/user/build.sh ] || bash /tmp/user/build.sh
