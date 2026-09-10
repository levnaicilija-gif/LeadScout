/**
 * When are two company rows the same company?
 *
 * This is deliberately cautious, because a wrong merge is worse than a duplicate: it moves
 * another company's leads and contacts onto the survivor, and there is no way back. Shell,
 * Shell Energy and Shell Lubricants are three companies. Hitachi Energy Norway and Hitachi
 * Energy Denmark are two. Equinor and Equinor ASA are one, and so are AF Gruppen ASA and
 * AF Gruppen Norge AS.
 *
 * So only two things count as the same company:
 *   1. the names match once legal form, punctuation and accents are stripped;
 *   2. the domains match AND one name is the other with a country or legal qualifier added.
 *
 * Descriptive words are never stripped. "Energy" is not noise — it is what separates Shell from
 * Shell Energy.
 */

/** Legal forms only. Nothing that could be part of a company's actual identity. */
const LEGAL = /\b(a\/s|aps|as|asa|ab|oy|oyj|gmbh|mbh|b\.?v\.?|n\.?v\.?|ltd|limited|llc|inc|plc|s\.?a\.?|sas|s\.?p\.?a\.?|sp\.? z o\.?o\.?|s\.?l\.?|ag|kg|kft|d\.?o\.?o\.?|a\.?s\.?)\b/gi;

export const canonCompany = (name: string) =>
  name.toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/\s*\([^)]*\)/g, '')
    .replace(LEGAL, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/** The domain, in one spelling. */
export const canonDomain = (d?: string | null) =>
  (d ?? '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');

/** Words that qualify a brand rather than change it — a country, or a national arm. */
const QUALIFIER = /^(norge|norway|sverige|sweden|danmark|denmark|suomi|finland|nederland|netherlands|deutschland|germany|uk|gb|britain|ireland|espana|spain|france|italia|italy|polska|poland|belgie|belgium|europe|nordic|international|group|holding|holdings)$/;

/**
 * Same company, or not. `why` is recorded on the merge so the decision can be read back.
 */
export function sameCompany(
  a: { name: string; domain?: string | null },
  b: { name: string; domain?: string | null },
): { same: boolean; why: string } {
  const ca = canonCompany(a.name);
  const cb = canonCompany(b.name);
  if (!ca || !cb) return { same: false, why: 'no usable name' };

  if (ca === cb) return { same: true, why: 'same name once legal form and punctuation are removed' };

  const da = canonDomain(a.domain);
  const dbm = canonDomain(b.domain);
  if (!da || !dbm || da !== dbm) return { same: false, why: 'different names, and no shared domain to link them' };

  // Same domain: one name may be the other plus a country or a group word.
  const [shorter, longer] = ca.length <= cb.length ? [ca, cb] : [cb, ca];
  if (!longer.startsWith(`${shorter} `)) return { same: false, why: `same domain ${da}, but the names are not one a qualified form of the other` };

  const extra = longer.slice(shorter.length + 1).split(' ').filter(Boolean);
  if (extra.every((w) => QUALIFIER.test(w))) {
    return { same: true, why: `same domain ${da}, and one name is the other plus "${extra.join(' ')}"` };
  }
  return { same: false, why: `same domain ${da}, but "${extra.join(' ')}" may be a different part of the business` };
}
