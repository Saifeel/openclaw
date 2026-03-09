#!/usr/bin/env bash
set -euo pipefail

BASE="${BASE:-http://127.0.0.1:18789}"
AUTH="${AUTH:?set AUTH (gateway bearer token)}"
TOKEN="${TOKEN:?set TOKEN (research shared token)}"
TOPIC="${TOPIC:-portable dog water bottle market}"
LABEL="${LABEL:-vps-smoke}"
LIMIT="${LIMIT:-5}"

auth_headers=(
  -H "authorization: Bearer ${AUTH}"
  -H "x-openclaw-research-token: ${TOKEN}"
)

echo "[1/5] health"
curl -sS "${auth_headers[@]}" "${BASE}/research/health"
echo
echo

echo "[2/5] submit"
submit_json="$(curl -sS -X POST "${BASE}/research/submit" \
  "${auth_headers[@]}" \
  -H "content-type: application/json" \
  -d "{\"topic\":\"${TOPIC}\",\"label\":\"${LABEL}\"}")"
echo "${submit_json}"
echo

job_id="$(echo "${submit_json}" | sed -n 's/.*"job_id":"\([^"]*\)".*/\1/p')"
if [[ -z "${job_id}" ]]; then
  echo "Failed to parse job_id from submit response"
  exit 1
fi

sleep 2
echo "[3/5] status (${job_id})"
curl -sS "${auth_headers[@]}" "${BASE}/research/status/${job_id}"
echo
echo

echo "[4/5] jobs (limit=${LIMIT})"
curl -sS "${auth_headers[@]}" "${BASE}/research/jobs?limit=${LIMIT}"
echo
echo

echo "[5/5] result (${job_id})"
curl -sS "${auth_headers[@]}" "${BASE}/research/result/${job_id}"
echo
