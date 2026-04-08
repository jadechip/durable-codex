FROM docker.io/cloudflare/sandbox:0.8.0

RUN apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    python3-venv \
    python-is-python3 \
  && rm -rf /var/lib/apt/lists/*
