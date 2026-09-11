import React from 'react';
import { Document, Page, Text, View, StyleSheet } from '@react-pdf/renderer';

/**
 * The client-facing CV. Layout follows design/leadscout.html #pdfwrap: rule under the
 * header, reference line, then Certificates / Experience / Profile tables and a footer
 * with the public verification link.
 *
 * This document is only ever given anonymised input — see ClientCvData. It carries no name,
 * phone, email, address, photo, date of birth or employer name, and /api/anonymize refuses
 * to save it if the PII check finds any.
 */
const C = { ink: '#141B26', ink2: '#4F5966', ink3: '#8590A0', line: '#E3E7EC', rail: '#0E1A2B', ok: '#1E7F4F', warn: '#B7791F', bad: '#B23A3A' };

const s = StyleSheet.create({
  page: { paddingTop: 38, paddingBottom: 46, paddingHorizontal: 44, fontSize: 9, lineHeight: 1.5, color: C.ink, fontFamily: 'Helvetica' },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', borderBottomWidth: 1.5, borderBottomColor: C.ink, paddingBottom: 10, marginBottom: 14 },
  trade: { fontSize: 15, fontFamily: 'Helvetica-Bold' },
  ref: { fontSize: 8.5, color: C.ink3, marginTop: 3 },
  mark: { width: 26, height: 26, borderRadius: 4, backgroundColor: C.rail, color: '#FFFFFF', fontSize: 12, fontFamily: 'Helvetica-Bold', textAlign: 'center', paddingTop: 7 },

  summary: { marginBottom: 10 },
  summaryLine: { fontSize: 9.5, marginBottom: 2 },
  scope: { fontSize: 7.5, color: C.ink3, marginTop: 1 },
  bullets: { marginBottom: 12 },
  bullet: { flexDirection: 'row', marginBottom: 3 },
  dot: { width: 10, color: C.ink3 },

  h: { fontFamily: 'Helvetica-Bold', fontSize: 9.5, marginTop: 4, marginBottom: 5 },
  row: { flexDirection: 'row', borderBottomWidth: 0.5, borderBottomColor: C.line, paddingVertical: 4 },
  head: { flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: C.line, paddingBottom: 4, marginBottom: 1 },
  th: { fontSize: 7.5, color: C.ink3, fontFamily: 'Helvetica-Bold', textTransform: 'uppercase' },
  td: { fontSize: 8.5, color: C.ink2, paddingRight: 6 },
  tableGap: { marginBottom: 12 },

  foot: { position: 'absolute', bottom: 26, left: 44, right: 44, borderTopWidth: 0.5, borderTopColor: C.line, paddingTop: 7, flexDirection: 'row', justifyContent: 'space-between', fontSize: 7.5, color: C.ink3 },
});

const statusColour = (r: string) => (r === 'valid' || r === 'consistent_with_test_report' ? C.ok : r === 'pending' ? C.warn : C.bad);
const statusLabel = (r: string) =>
  r === 'valid' ? 'Valid' : r === 'consistent_with_test_report' ? 'Consistent with test report' : r === 'pending' ? 'Checking with issuer' : r === 'invalid' ? 'Expired' : r === 'not_found' ? 'Not found' : 'Not verified';

const date = (d?: string | null) => (d ? new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '—');

export type ClientCvData = {
  referenceCode: string;
  trade: string;
  preparedOn: string;
  /** Two lines at the top: what they are, how long, and where. */
  summary: string[];
  bullets: string[];
  gaps: { from: string; to: string; months: number }[];
  certificates: { name: string; number?: string | null; checkedWhere?: string | null; checkedAt?: string | null; validUntil?: string | null; result: string }[];
  /** Employer names are already stripped — type + country only. */
  experience: { years: string; what: string; scope?: string | null; rotation?: string | null }[];
  skills: string[];
  languages: string[];
  availability?: string | null;
  publicUrl: string;
  agencyLine: string;
};

/** The exact text the client PDF shows, for the PII gate to review. */
export const clientCvText = (d: ClientCvData) =>
  [
    d.bullets.join('\n'),
    d.experience.map((e) => `${e.years} ${e.what} ${e.scope ?? ''} ${e.rotation ?? ''}`.trim()).join('\n'),
    d.skills.join(', '),
    d.languages.join(', '),
    d.availability ?? '',
    d.certificates.map((c) => `${c.name} ${c.number ?? ''}`.trim()).join('\n'),
  ].join('\n');

/**
 * Values we deliberately print and that must never block the PDF: certificate names and
 * numbers (both alone and as the line they appear on), the agency line, the public URL.
 */
/**
 * What this document deliberately prints, so the PII gate does not flag our own content.
 *
 * The experience lines belong here: they are the anonymised profile's own project descriptions,
 * already stripped of employers, and are the point of the summary. Without them the review
 * blocked a real candidate's PDF over "Danube Bridge infrastructure work in Romania" — a public
 * works project employing thousands, which identifies nobody.
 */
export const clientCvAllowed = (d: ClientCvData) => [
  ...d.certificates.flatMap((c) => [c.name, c.number ?? '', `${c.name} ${c.number ?? ''}`.trim()]),
  // Not the bullets: those are written by the model and are exactly where a leaked name would
  // show, so they stay subject to the check.
  ...d.experience.flatMap((e) => [e.what, e.scope ?? '', `${e.what} ${e.years ?? ''}`.trim(), e.years ?? '']),
  ...d.skills,
  ...d.languages,
  d.trade,
  d.agencyLine,
  d.publicUrl,
].filter(Boolean);

const Cell = ({ w, children, colour }: { w: string; children: React.ReactNode; colour?: string }) => (
  <Text style={[s.td, { width: w, ...(colour ? { color: colour } : {}) }] as any}>{children}</Text>
);

export function ClientCv(d: ClientCvData) {
  return (
    <Document title={`${d.referenceCode} — ${d.trade}`} author={d.agencyLine} subject="Anonymised candidate summary">
      <Page size="A4" style={s.page}>
        <View style={s.header}>
          <View>
            <Text style={s.trade}>{d.trade}</Text>
            <Text style={s.ref}>
              Reference {d.referenceCode} · prepared {date(d.preparedOn)} · full profile released on client confirmation
            </Text>
          </View>
          <Text style={s.mark}>R</Text>
        </View>

        {d.summary.length > 0 && (
          <View style={s.summary}>
            {d.summary.map((line, i) => <Text key={i} style={s.summaryLine}>{line}</Text>)}
          </View>
        )}

        {d.bullets.length > 0 && (
          <View style={s.bullets}>
            {d.bullets.map((b, i) => (
              <View key={i} style={s.bullet}>
                <Text style={s.dot}>·</Text>
                <Text style={{ flex: 1 }}>{b}</Text>
              </View>
            ))}
          </View>
        )}

        <Text style={s.h}>Certificates — verified by the agency</Text>
        <View style={s.head}>
          <Text style={[s.th, { width: '26%' }] as any}>Certificate</Text>
          <Text style={[s.th, { width: '15%' }] as any}>Number</Text>
          <Text style={[s.th, { width: '24%' }] as any}>Checked where</Text>
          <Text style={[s.th, { width: '13%' }] as any}>Checked</Text>
          <Text style={[s.th, { width: '13%' }] as any}>Valid until</Text>
          <Text style={[s.th, { width: '9%' }] as any}>Status</Text>
        </View>
        {d.certificates.length === 0 && <Text style={[s.td, { paddingVertical: 4 }] as any}>No verified certificates on file.</Text>}
        {d.certificates.map((c, i) => (
          <View key={i} style={s.row} wrap={false}>
            <Cell w="26%">{c.name}</Cell>
            <Cell w="15%">{c.number || '—'}</Cell>
            <Cell w="24%">{c.checkedWhere ? new URL(c.checkedWhere).hostname.replace(/^www\./, '') : 'Document on file'}</Cell>
            <Cell w="13%">{date(c.checkedAt)}</Cell>
            <Cell w="13%">{date(c.validUntil)}</Cell>
            <Cell w="9%" colour={statusColour(c.result)}>{statusLabel(c.result)}</Cell>
          </View>
        ))}
        <View style={s.tableGap} />

        <Text style={s.h}>Experience</Text>
        {d.experience.length === 0 && <Text style={[s.td, { paddingVertical: 4 }]}>No work history on file — ask the candidate.</Text>}
        {d.experience.map((e, i) => (
          <View key={i} style={s.row} wrap={false}>
            <Cell w="14%">{e.years}</Cell>
            <View style={{ width: '72%' }}>
              <Text style={s.td}>{e.what}</Text>
              {e.scope ? <Text style={s.scope}>{e.scope}</Text> : null}
            </View>
            <Cell w="14%">{e.rotation || 'not stated'}</Cell>
          </View>
        ))}

        {d.gaps.length > 0 && (
          <View style={{ marginTop: 6 }}>
            <Text style={s.scope}>
              Not accounted for on the CV: {d.gaps.map((g) => `${g.from}–${g.to}`).join(', ')} — asked at screening.
            </Text>
          </View>
        )}
        <View style={s.tableGap} />

        <Text style={s.h}>Profile</Text>
        <View style={s.row}>
          <Cell w="20%">Skills</Cell>
          <Cell w="80%">{d.skills.join(', ') || '—'}</Cell>
        </View>
        <View style={s.row}>
          <Cell w="20%">Languages</Cell>
          <Cell w="80%">{d.languages.join(', ') || '—'}</Cell>
        </View>
        <View style={s.row}>
          <Cell w="20%">Availability</Cell>
          <Cell w="80%">{d.availability || '—'}</Cell>
        </View>

        <View style={s.foot} fixed>
          <Text>{d.agencyLine}</Text>
          <Text>Verify this summary: {d.publicUrl}</Text>
        </View>
      </Page>
    </Document>
  );
}
