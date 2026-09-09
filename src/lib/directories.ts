/**
 * Industry directories, as sources of company DOMAINS.
 *
 * The attendee list gives 5,461 employer names and not one website, and a careers page cannot
 * be found without a domain. Member directories are the cheapest honest way to close that gap:
 * an association publishes its members and links to their sites.
 *
 * Each entry records what was actually observed on 2026-09-09, because most of these lists are
 * not where their name suggests:
 *   mode 'direct'  the list page links straight out to member websites
 *   mode 'profile' the list links to internal member pages; the website is one hop further in
 *   status         'ok' confirmed working, anything else explains what blocks it
 */
export type DirectoryMode = 'direct' | 'profile';

export type Directory = {
  key: string;
  name: string;
  url: string;
  country?: string;
  mode: DirectoryMode;
  browser?: boolean;
  /** For 'profile' mode: which internal links are member pages. */
  profilePattern?: RegExp;
  status: 'ok' | 'needs_work' | 'login' | 'not_found';
  note: string;
};

export const DIRECTORIES: Directory[] = [
  {
    key: 'nedzero', name: 'NedZero (formerly NWEA)', url: 'https://nedzero.nl/nl/members', country: 'NL',
    mode: 'direct', status: 'ok',
    note: '223 member websites linked directly from the list page, plain HTTP. NWEA renamed to NedZero.',
  },
  {
    key: 'norwegian_offshore_wind', name: 'Norwegian Offshore Wind', url: 'https://www.norwegianoffshorewind.no/members/directory', country: 'NO',
    mode: 'profile', browser: true, profilePattern: /^\/members\/member-\d+$/, status: 'ok',
    note: 'Directory renders client-side, so the list needs a browser; the 276 member profiles at /members/member-<id> are plain HTML and carry the member website.',
  },
  {
    key: 'windeurope', name: 'WindEurope', url: 'https://windeurope.org/membership/', country: undefined,
    mode: 'direct', status: 'login',
    note: 'Public pages sell membership; the member list itself is behind /members-area/ (login).',
  },
  {
    key: 'energy_cluster_dk', name: 'Energy Cluster Denmark', url: 'https://app.energycluster.dk/en/members', country: 'DK',
    mode: 'direct', browser: true, status: 'login',
    note: 'Member app returns zero links even with a browser — an authenticated SPA.',
  },
  {
    key: 'danske_maritime', name: 'Danske Maritime', url: 'https://danskemaritime.dk/members-of-danish-maritime-2026-2/', country: 'DK',
    mode: 'direct', status: 'needs_work',
    note: 'Page loads over plain HTTP (73 KB) but lists members as text with no outbound links; names are usable, domains are not.',
  },
  {
    key: 'eic', name: 'EIC (Energy Industries Council)', url: 'https://www.the-eic.com/Membership', country: 'GB',
    mode: 'direct', status: 'login',
    note: 'EICDataStream member directory requires an account.',
  },
  {
    key: 'nho', name: 'NHO', url: 'https://www.nho.no/medlemskap/', country: 'NO',
    mode: 'direct', status: 'needs_work',
    note: 'A federation of federations — its outbound links are the 19 member associations, not companies.',
  },
  {
    key: 'norsk_industri', name: 'Norsk Industri', url: 'https://www.norskindustri.no/medlemskap-og-fordeler/', country: 'NO',
    mode: 'direct', status: 'needs_work',
    note: 'Same shape as NHO: links to sister associations rather than member companies.',
  },
  {
    key: 'renewableuk', name: 'RenewableUK', url: 'https://www.renewableuk.com/membership/', country: 'GB',
    mode: 'direct', status: 'needs_work',
    note: 'Membership page loads but carries no member links; the directory is elsewhere and /our-members/ is a 404.',
  },
  {
    key: 'oeuk', name: 'Offshore Energies UK', url: 'https://oeuk.org.uk/', country: 'GB',
    mode: 'direct', status: 'not_found',
    note: 'Both /members/ and /membership/our-members/ are 404; the list URL still has to be found.',
  },
  {
    key: 'seaeurope', name: 'SeaEurope', url: 'https://www.seaeurope.eu/', country: undefined,
    mode: 'direct', status: 'not_found',
    note: '/members/ and /about-us/members are both 404.',
  },
  {
    key: 'blue_cluster_be', name: 'Blue Cluster / Offshore Energy Cluster (BE)', url: 'https://www.blauwecluster.be/', country: 'BE',
    mode: 'direct', status: 'not_found',
    note: 'beluga-cluster.be does not resolve; blauwecluster.be/members is a 404. Correct entry point still unknown.',
  },
];

/** Hosts that are never a member company. */
export const NOT_A_MEMBER = /(facebook|twitter|linkedin|youtube|instagram|x\.com|vimeo|flickr|google|goo\.gl|bit\.ly|mailto|tel:|wordpress|cookiebot|cloudflare|jquery|gstatic|googleapis|w3\.org|schema\.org|europa\.eu|issuu)/i;
