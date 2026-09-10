/**
 * Who the email actually goes to.
 *
 * The person quoted in a contract-award article is almost always the CEO, because that is who
 * newspapers quote. A CEO does not book welders. The quote is still the reason we are writing —
 * it is the hook — but the letter belongs to whoever runs resourcing, the yard or the project.
 *
 * Nobody is invented here: the alternative has to already exist as a contact on the lead or a
 * person attached to the company from an attendee list. If there is no ops-level name, the
 * email goes to the quoted person and says so.
 */
export type Person = { id?: string; name?: string | null; title?: string | null; email?: string | null; source?: string | null };

/** Titles that mean "runs the company", not "runs the work". */
const C_LEVEL = /\b(ceo|cfo|coo|cto|cio|chief\b|president|chair(man|woman|person)?\b|managing director|group director|founder|owner|board member|executive vice president|evp)\b/i;

/** Titles that mean "decides who turns up on site". */
const OPS = /\b(resourc|recruit|talent|staffing|manpower|crewing|personnel|hr\b|human resources|fabricat|yard|site manager|site lead|project manager|project director|construction manager|operations manager|ops manager|superintendent|foreman|discipline lead|planner|procurement|supply chain|contracts? manager|subcontract|maintenance manager|shutdown|turnaround|commissioning)\b/i;

export const isCLevel = (title?: string | null) => !!title && C_LEVEL.test(title);
export const isOps = (title?: string | null) => !!title && OPS.test(title);

export type Recipient = {
  /** Who the email is addressed to. */
  to: Person;
  /** Whose words open it — the quoted person, whether or not they are the recipient. */
  hook: Person | null;
  /** One line for the "why" field, explaining the choice to the recruiter. */
  why: string;
  /** True when we deliberately moved off the quoted person. */
  redirected: boolean;
};

/**
 * @param quoted   the contact carrying the quote from the article
 * @param others   other contacts on the lead
 * @param people   attendee-list / company-site people attached to the company
 */
export function chooseRecipient(quoted: Person | null, others: Person[], people: Person[]): Recipient {
  const pool = [...others, ...people].filter((p) => p?.name && p.name !== quoted?.name);

  if (!quoted) {
    const ops = pool.find((p) => isOps(p.title));
    if (ops) return { to: ops, hook: null, why: `No one is quoted in the article, so this is addressed to ${ops.name} (${ops.title}), who is the operational contact on file.`, redirected: false };
    const anyone = pool[0];
    if (anyone) return { to: anyone, hook: null, why: `No one is quoted in the article; ${anyone.name} is the only contact we hold for this company.`, redirected: false };
    return { to: {}, hook: null, why: 'No named contact on this lead — send to the company address.', redirected: false };
  }

  if (!isCLevel(quoted.title)) {
    return { to: quoted, hook: quoted, why: `Addressed to ${quoted.name}, who is quoted in the article and is close enough to the work to answer.`, redirected: false };
  }

  // Quoted person is C-level. Prefer a named ops person; a titled one over an untitled one.
  const ops = pool.find((p) => isOps(p.title));
  if (ops) {
    return {
      to: ops,
      hook: quoted,
      why: `${quoted.name} is ${quoted.title} and does not book trades, so this is addressed to ${ops.name} (${ops.title})${ops.source ? ` from ${ops.source}` : ''}. The quote is kept as the opening because it is the reason for writing.`,
      redirected: true,
    };
  }

  return {
    to: quoted,
    hook: quoted,
    why: `${quoted.name} is ${quoted.title}, which is above the level that books trades, but we hold no operational contact at this company — worth finding one before sending, or asking them to point you at the resourcing lead.`,
    redirected: false,
  };
}
