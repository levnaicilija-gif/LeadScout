#!/usr/bin/env bash
# Walk the priority sources on production one batch at a time, with the chain switched off, so
# every batch's report comes back here rather than disappearing into a fire-and-forget request.
set -u
cd "$(dirname "$0")/.."
SECRET=$(grep '^CRON_SECRET=' .env.local | cut -d= -f2- | tr -d '"\r\n ')
HOSTS=$(tail -1 prio.txt)
BASE=https://leadscout-rfbt.vercel.app/api/jobs/radar
mkdir -p .cache/prio-run
for c in $(seq 0 3 45); do
  echo "--- cursor $c ---"
  curl -s --max-time 320 -X POST "$BASE?batch=3&chain=0&cursor=$c&only=$HOSTS" -H "x-cron-secret: $SECRET" > ".cache/prio-run/$c.json"
  node -e "
    const j=require('./.cache/prio-run/$c.json');
    if(!j.tally){console.log('  no tally:',JSON.stringify(j).slice(0,200));process.exit(0)}
    console.log('  '+JSON.stringify(j.tally));
    (j.audit||[]).forEach(a=>console.log('   src '+String(a.links).padStart(2)+' links via '+a.via+'  '+a.source));
    (j.report||[]).filter(r=>r.lead).forEach(r=>console.log('   LEAD '+r.company+' — '+(r.people||[]).join('; ')));
    if(j.tally.sources===0) console.log('   (end of the list)');
  "
  if node -e "process.exit(require('./.cache/prio-run/$c.json').tally?.sources ? 1 : 0)"; then break; fi
done
echo "=== done ==="
