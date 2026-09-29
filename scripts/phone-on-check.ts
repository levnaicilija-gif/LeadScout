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

// ---- NATIONAL FORMAT, with a trunk zero and no country code (item 37, 2026-09-28) -------------------
// Until now PHONE_RE required a leading + or 00, so a number printed the way a German, Danish or
// Norwegian company ordinarily prints its own was INVISIBLE. Schiffswerft Fischer is the worked example:
// discovery stored nothing for it while its imprint printed a landline and its home page a mobile.
check('Impressum Schiffswerft Fischer GmbH Telefon: 04692/20740 Telefax: 04692/20742', '04692/20740', "Fischer's imprint: a German landline in domestic format is read");
check('Werft Mobil 0172 4611282 Kontakt', '0172 4611282', "Fischer's home page: a German mobile in domestic format is read");
check('Ring oss på 22 33 44 55 66 i dag', null, 'a Norwegian number printed with NO trunk zero is not invented out of a digit run');
check('Tlf. 0047 22 33 44 55 Om oss', '0047 22 33 44 55', 'a 00-prefixed international number still reads as before');

// A FAX is never offered, whichever format it is in: a recruiter would dial it and reach a machine.
check('Telefax: 04692/20742 Impressum', null, 'a number introduced as a fax is refused outright, not stored as a switchboard');
check('Fax 04692/20742 Telefon 04692/20740', '04692/20740', 'and where both are printed, the phone is the one taken — whatever the order');
check('04692/20999 Telefon: 04692/20740', '04692/20740', 'a LABELLED number beats an unlabelled digit run earlier on the page');

// Things with the right number of digits that are not phone numbers.
check('USt-IdNr. DE 123456789 Handelsregister', null, 'a VAT number is not a phone number');
check('Auftragsnummer 0123456789012345678 vom Lager', null, 'a nineteen-digit order number is not a phone number — E.164 allows fifteen');
check('Konto 1004692207401 bei der Sparkasse', null, 'a trunk zero found INSIDE a longer digit run is not the start of a phone number');
check('28832 Achim, Am Osterfeld 35a', null, 'a postcode and a house number are not a phone number');

console.log(failed ? `\n${failed} failed` : '\nphoneOn: all checks passed');
process.exitCode = failed ? 1 : 0;
