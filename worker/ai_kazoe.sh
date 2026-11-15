#!/bin/bash
# AI の使われ方と加入の動きを日ごとに出す（3サイト）。使い方: bash ai_kazoe.sh
# free_q/paid_q=AI の回数 free_u/paid_u=人数 grade=採点 checkout=支払い画面へ進んだ回数 joined=加入した数
cd "$(dirname "$0")"
for e in sokuryo takken gyosei; do
  echo "== $e"
  opt=""; [ "$e" != sokuryo ] && opt="--env $e"
  npx wrangler kv key list --binding LIMITS $opt --remote --prefix stat: 2>/dev/null \
   | grep -o '"stat:[^"]*"' | tr -d '"' | while read k; do
      echo "$k $(npx wrangler kv key get "$k" --binding LIMITS $opt --remote 2>/dev/null)"
   done | sed 's/^stat://' | sort
done
