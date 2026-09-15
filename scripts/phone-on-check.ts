/** The switchboard reader on printed numbers, including the two it cut short on 2026-09-15: npx tsx scripts/phone-on-check.ts */
import { phoneOn } from '../src/lib/hiring-contacts';

let failed = 0;
const check = (text: string, want: string | null, what: string) => {
  const got = phoneOn({ text });
  const ok = got === want;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}${ok ? '' : ` — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`}`);
  if (!ok) failed++;
};

// Cut short on production: an en dash inside the number stopped the read at the area code.
check('E-Mail: info@kattner-stahlbau.de – Tel: +49 (0)3435 – 666 2-0 KATTNER STAHLBAU', '+49 (0)3435 – 666 2-0', 'Kattner: a number with an en dash in it is read whole');
// Daldrup's contact page, as printed: a slash inside the number stopped the read at "+49 (0) 25 93".
check('Ascheberg / Westfalen Germany Tel. : +49 (0) 25 93 / 95 93 - 0 Fax : +49 (0) 25 93 / 72 70 Business address', '+49 (0) 25 93 / 95 93 - 0', 'Daldrup: a number with a slash in it is read whole, and the fax after it is not joined on');
// Numbers that were already right stay exactly as printed.
check('Kontakt +49 30 818 700 140 Karriere', '+49 30 818 700 140', 'a spaced German number');
check('Tel. +40.21.387.48.31 office@generalturbo.ro', '+40.21.387.48.31', 'a dotted Romanian number');
check('Phone +49 (0) 5932 7254-0 info@berky.de', '+49 (0) 5932 7254-0', 'a number with a trunk prefix and an extension');
check('Växel +46 (0)8 739 50 00 Om oss', '+46 (0)8 739 50 00', 'a Swedish switchboard');
// A fragment is refused rather than stored: a recruiter would dial it.
check('Tel: +49 (0)3435 KATTNER', null, 'an area code with no subscriber number is refused');
check('Call +45 70 12', null, 'seven digits is too short to be a switchboard');
// The number stops where the number stops.
check('Tel +49 5407 805 20 Fax +49 5407 805 29', '+49 5407 805 20', 'a fax number printed right after is not joined on');
check('Tel +49 5407 805 20 – Mo–Fr 8–17 Uhr', '+49 5407 805 20', 'opening hours after a dash are not joined on');
check('Updated 2026-09-15 by the webmaster', null, 'a date is not a phone number');

console.log(failed ? `\n${failed} failed` : '\nphoneOn: all checks passed');
process.exitCode = failed ? 1 : 0;
