import React from 'react';
import { Document, Page, Text, View, StyleSheet } from '@react-pdf/renderer';

/**
 * The INTERNAL CV: everything RFBT holds, including the name and contact details. It is
 * marked internal on every page precisely because it is the document that must never reach a
 * client — the client version is ClientCv, which carries none of this.
 */
const C = { ink: '#141B26', ink2: '#4F5966', ink3: '#8590A0', line: '#E3E7EC', rail: '#0E1A2B', bad: '#B23A3A', ok: '#1E7F4F', warn: '#B7791F' };

const s = StyleSheet.create({
  page: { paddingTop: 38, paddingBottom: 52, paddingHorizontal: 44, fontSize: 9, lineHeight: 1.5, color: C.ink, fontFamily: 'Helvetica' },
  banner: { backgroundColor: C.bad, color: '#FFFFFF', fontSize: 8, fontFamily: 'Helvetica-Bold', padding: 5, marginBottom: 12, textAlign: 'center' },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', borderBottomWidth: 1.5, borderBottomColor: C.ink, paddingBottom: 10, marginBottom: 12 },
  name: { fontSize: 15, fontFamily: 'Helvetica-Bold' },
  ref: { fontSize: 8.5, color: C.ink3, marginTop: 3 },
  h: { fontFamily: 'Helvetica-Bold', fontSize: 9.5, marginTop: 10, marginBottom: 4 },
  row: { flexDirection: 'row', borderBottomWidth: 0.5, borderBottomColor: C.line, paddingVertical: 3.5 },
  td: { fontSize: 8.5, color: C.ink2, paddingRight: 6 },
  foot: { position: 'absolute', bottom: 26, left: 44, right: 44, borderTopWidth: 0.5, borderTopColor: C.line, paddingTop: 7, fontSize: 7.5, color: C.bad, textAlign: 'center' },
});

export type InternalCvData = {
  referenceCode: string;
  fullName?: string | null;
  trade: string;
  trades: string[];
  phone?: string | null;
  email?: string | null;
  dob?: string | null;
  preparedOn: string;
  certificates: { name: string; number?: string | null; checkedWhere?: string | null; checkedAt?: string | null; validUntil?: string | null; result: string }[];
  claimed: string[];
  experience: { years: string; what: string; employer?: string | null; rotation?: string | null }[];
  skills: string[];
  languages: string[];
  availability?: string | null;
  agencyLine: string;
};

const date = (d?: string | null) => (d ? new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '—');
const statusColour = (r: string) => (r === 'valid' || r === 'consistent_with_test_report' ? C.ok : r === 'pending' ? C.warn : C.bad);

const Cell = ({ w, children, colour }: { w: string; children: React.ReactNode; colour?: string }) => (
  <Text style={[s.td, { width: w, ...(colour ? { color: colour } : {}) }] as any}>{children}</Text>
);

export function InternalCv(d: InternalCvData) {
  return (
    <Document title={`INTERNAL — ${d.referenceCode}`} author={d.agencyLine} subject="Internal candidate record — not for clients">
      <Page size="A4" style={s.page}>
        <Text style={s.banner} fixed>INTERNAL — CONTAINS PERSONAL DATA — DO NOT SEND TO A CLIENT</Text>

        <View style={s.header}>
          <View>
            <Text style={s.name}>{d.fullName || '(name not read from the CV)'}</Text>
            <Text style={s.ref}>{d.trade}{d.trades.length ? ` · ${d.trades.join(', ')}` : ''}</Text>
            <Text style={s.ref}>Reference {d.referenceCode} · prepared {date(d.preparedOn)}</Text>
          </View>
        </View>

        <Text style={s.h}>Contact</Text>
        <View style={s.row}><Cell w="22%">Phone</Cell><Cell w="78%">{d.phone || '—'}</Cell></View>
        <View style={s.row}><Cell w="22%">Email</Cell><Cell w="78%">{d.email || '—'}</Cell></View>
        <View style={s.row}><Cell w="22%">Date of birth</Cell><Cell w="78%">{d.dob || '—'}</Cell></View>

        <Text style={s.h}>Certificates — checked</Text>
        {d.certificates.length === 0 && <Text style={s.td}>None verified yet.</Text>}
        {d.certificates.map((c, i) => (
          <View key={i} style={s.row} wrap={false}>
            <Cell w="26%">{c.name}</Cell>
            <Cell w="16%">{c.number || '—'}</Cell>
            <Cell w="24%">{c.checkedWhere ? new URL(c.checkedWhere).hostname.replace(/^www\./, '') : '—'}</Cell>
            <Cell w="14%">{date(c.checkedAt)}</Cell>
            <Cell w="12%">{date(c.validUntil)}</Cell>
            <Cell w="8%" colour={statusColour(c.result)}>{c.result}</Cell>
          </View>
        ))}

        <Text style={s.h}>Certificates claimed on the CV</Text>
        {d.claimed.map((c, i) => <Text key={i} style={s.td}>· {c}</Text>)}

        <Text style={s.h}>Experience</Text>
        {d.experience.map((e, i) => (
          <View key={i} style={s.row} wrap={false}>
            <Cell w="14%">{e.years}</Cell>
            <Cell w="52%">{e.what}</Cell>
            <Cell w="22%">{e.employer || '—'}</Cell>
            <Cell w="12%">{e.rotation || '—'}</Cell>
          </View>
        ))}

        <Text style={s.h}>Profile</Text>
        <View style={s.row}><Cell w="22%">Skills</Cell><Cell w="78%">{d.skills.join(', ') || '—'}</Cell></View>
        <View style={s.row}><Cell w="22%">Languages</Cell><Cell w="78%">{d.languages.join(', ') || '—'}</Cell></View>
        <View style={s.row}><Cell w="22%">Availability</Cell><Cell w="78%">{d.availability || '—'}</Cell></View>

        <Text style={s.foot} fixed>{d.agencyLine} · internal record for {d.referenceCode} · not for client distribution</Text>
      </Page>
    </Document>
  );
}
