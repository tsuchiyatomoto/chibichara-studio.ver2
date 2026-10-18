#!/usr/bin/env bash
set -Eeuo pipefail
exec /usr/bin/python3 /opt/chibichara/docker/bootstrap.py "$@"
