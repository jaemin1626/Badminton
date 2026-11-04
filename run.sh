#!/usr/bin/env bash
# Smash Score 서버 실행.  사용: ./run.sh [포트] [GPU 번호]
cd "$(dirname "$0")"
PORT=${1:-8000}
export BADMINTON_GPU=${2:-0}
exec .venv/bin/uvicorn app.main:app --host 0.0.0.0 --port "$PORT"
