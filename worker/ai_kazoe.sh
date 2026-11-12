#!/bin/bash
# AI の使われ方を日ごとに出す（3サイト）。使い方: bash ai_kazoe.sh
cd "$(dirname "$0")"
for e in sokuryo takken gyosei; do
  echo "== $e"
  opt=""; [ "$e" != sokuryo ] && opt="--env $e"
  npx wrangler kv key list --binding LIMITS $opt --remote --prefix stat: 2>/dev/null \
   | grep -o '"stat:[^"]*"' | tr -d '"' | while read k; do
      echo "$k $(npx wrangler kv key get "$k" --binding LIMITS $opt --remote 2>/dev/null)"
   done | sed 's/^stat://' | sort
done
