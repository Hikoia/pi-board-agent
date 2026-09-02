# pi-board-agent — autonomous board executor container.
#
# Runs pi headless with the board-agent extension loaded. The extension
# auto-starts the loop when config.auto_start is true: the loop's setInterval
# keeps the pi process alive after the --print prompt completes.
#
# Build:    docker build -t pi-board-agent .
# Run:      docker compose up -d   (see docker-compose.yml)
# Docs:     docs/docker.md
#
# Base image follows the official pi containerization pattern
# (node:24-bookworm-slim) with git/ripgrep for tooling and the GitHub CLI
# for the board operations. gh is downloaded for the build platform
# (amd64/arm64) so the image works on the Raspberry Pi too.

FROM node:24-bookworm-slim

# Build-time arch detection (amd64 | arm64) for the gh binary.
ARG TARGETARCH

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    bash ca-certificates git ripgrep curl jq \
  && rm -rf /var/lib/apt/lists/*

# GitHub CLI (same version strategy as the pi docs: binary install).
RUN ARCH="$${TARGETARCH:-amd64}"; \
  case "$$ARCH" in \
    arm64) GH_ARCH="arm64" ;; \
    amd64) GH_ARCH="amd64" ;; \
    *) GH_ARCH="amd64" ;; \
  esac; \
  curl -sL -o /tmp/gh.tar.gz "https://github.com/cli/cli/releases/latest/download/gh_2.97.0_linux_$${GH_ARCH}.tar.gz" \
  && tar xzf /tmp/gh.tar.gz -C /usr/local --strip-components=2 gh_2.97.0_linux_$${GH_ARCH}/bin/gh \
  && rm -f /tmp/gh.tar.gz \
  && gh --version

# Pi coding agent.
RUN npm install -g --ignore-scripts @earendil-works/pi-coding-agent

# Local Pi packages are not dependency-installed automatically.
COPY . /app/pi-board-agent
RUN npm ci --omit=dev --prefix /app/pi-board-agent \
  && pi install /app/pi-board-agent

WORKDIR /workspace
COPY entrypoint.sh /usr/local/bin/board-agent-entrypoint
RUN chmod +x /usr/local/bin/board-agent-entrypoint

ENTRYPOINT ["board-agent-entrypoint"]
