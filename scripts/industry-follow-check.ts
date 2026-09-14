/**
 * The industry-follow rules the routes check before 0032's trigger checks them again — proved offline.
 *
 *   npx tsx scripts/industry-follow-check.ts
 */
import { checkFollow, followedIndustries, inFollowed, mustChooseIndustries, canFollowAll, FOLLOW_IDS } from '../src/lib/industry-follow';
import { FOLLOW_OPTIONS } from '../src/lib/industry';
import fs from 'fs';

let failed = 0;
const check = (ok: boolean, what: string, detail?: unknown) => {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${what}${ok || detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`);
  if (!ok) failed++;
};

check(checkFollow(['wind', 'grid'], 2).ok, 'two industries on an account allowed two');
check(!checkFollow(['wind', 'grid', 'oil_gas'], 2).ok, 'three on an account allowed two is refused');
check(checkFollow(['wind', 'grid', 'oil_gas', 'ccs', 'solar'], null).ok, 'any number when there is no cap');
check(checkFollow(['all'], null).ok, '"all" when there is no cap');
check(!checkFollow(['all'], 5).ok, '"all" under any cap is refused');
check(!checkFollow(['all', 'wind'], null).ok, '"all" is a choice of its own');
check(!checkFollow([], null).ok, 'nothing chosen is refused');
check(!checkFollow(['wind', 'wind'], null).ok, 'the same industry twice is refused');
check(!checkFollow(['offshore_wind'], null).ok, 'Offshore Wind alone is not offered — Wind is');
check(!checkFollow('wind', null).ok && !checkFollow([1, 2], null).ok, 'anything but a list of names is refused');

check(JSON.stringify(followedIndustries(['wind'])) === '["offshore_wind","onshore_wind"]', 'following Wind covers Offshore and Onshore Wind');
check(followedIndustries(['all']) === 'all' && followedIndustries(null) === 'all', '"all" and no choice both read as everything');
check(inFollowed(['onshore_wind'], followedIndustries(['wind'])) && !inFollowed(['grid'], followedIndustries(['wind'])), 'an onshore wind lead belongs to Wind; a grid lead does not');
check(inFollowed([], followedIndustries(['wind'])), 'a lead not yet classified is shown, not hidden');

check(mustChooseIndustries({ industry_follow: null }) && !mustChooseIndustries({ industry_follow: ['all'] }), 'an account with nothing chosen must choose; one with a choice does not');
check(!mustChooseIndustries({ role: 'senior' }), 'before 0032 (no column on the row) nobody is sent to onboarding');
check(canFollowAll(null) && !canFollowAll(3), 'all industries is offered only without a cap');

// The trigger's list and the app's options must be the same list.
const sql = fs.readFileSync('supabase/migrations/0032_industry_follow.sql', 'utf8');
const inTrigger = new Set([...(sql.match(/allowed constant text\[\] := array\[([\s\S]*?)\]/)?.[1] ?? '').matchAll(/'([a-z_]+)'/g)].map((m) => m[1]));
check(inTrigger.size === FOLLOW_IDS.size && [...FOLLOW_IDS].every((id) => inTrigger.has(id)), "0032's trigger allows exactly the options the app offers", { trigger: [...inTrigger].sort(), app: [...FOLLOW_IDS].sort() });
check(FOLLOW_OPTIONS.length === 16, 'sixteen choices: Wind plus the other fifteen categories');

console.log(failed ? `industry follow check: ${failed} failed` : 'industry follow check: all passed');
process.exit(failed ? 1 : 0);
