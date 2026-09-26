/**
 * Proves the same-contract rule against rows in the real database, then deletes them.
 *
 *   npx tsx --env-file=.env.local scripts/same-contract-probe.ts
 *
 * Everything it makes is marked: a workspace, company and leads flagged is_test; news articles on
 * https://example.invalid/ and notice articles under a ted.europa.eu path beginning "probe-" (the
 * source tag is read off the host, so a notice has to live there — and no real TED notice id starts
 * with a word). articles has no is_test column, so they are deleted by the ids this run created AND
 * one of those two URL shapes, never by anything that could match a real row. Exits 1 on failure.
 */
import { createClient } from '@supabase/supabase-js';
import { findSameContract, mergeSameContract, type SourceRecord } from '../src/lib/same-contract';
import { markTest, deleteTestRows, probeAdmin } from '../src/lib/test-data';
import { leadSource } from '../src/lib/lead-source';

const db = probeAdmin();
const RUN = Date.now();
const NEWS = 'https://example.invalid';
const TED = 'https://ted.europa.eu/en/notice/-/detail';

let failures = 0;
const check = (ok: boolean, what: string, detail = '') => {
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? ` — ${detail}` : ''}`);
};

const articleIds: string[] = [];
const leadIds: string[] = [];

(async () => {
  const { data: ws, error: wsErr } = await db.from('workspaces').insert({ name: 'Probe same-contract', slug: `probe-same-contract-${RUN}`, is_test: true }).select('id').single();
  if (wsErr) { console.error('could not create the probe workspace:', wsErr.message); process.exit(1); }
  const workspaceId = ws.id as string;
  try {
    const { data: co } = await db.from('companies').insert({ workspace_id: workspaceId, name: `Probe Contractor ${RUN} AS`, employer_type: 'unknown', is_test: true }).select('id').single();
    const companyId = co!.id as string;
    await markTest(db, 'companies', [companyId]);

    async function article(url: string, text: string, published_at: string | null = null) {
      const { data, error } = await db.from('articles').insert({ url, title: url.split('/').pop(), text, published_at, last_fetch_status: 'live', last_fetch_at: new Date().toISOString() }).select('id, url').single();
      if (error) throw new Error(`article ${url}: ${error.message}`);
      articleIds.push(data.id);
      return data as { id: string; url: string };
    }
    const newsArticle = (slug: string, text: string) => article(`${NEWS}/${slug}-${RUN}`, text);
    const noticeText = (published: string, buyer: string, title: string) =>
      `Contract award notice — TED probe\nPublished on TED: ${published}\nContracting authority: ${buyer}\nWinning company: Probe Contractor ${RUN} AS\nTitle (eng): ${title}`;
    async function notice(slug: string, published: string, buyer: string, title: string): Promise<{ id: string; record: SourceRecord }> {
      const text = noticeText(published, buyer, title);
      const a = await article(`${TED}/probe-${slug}-${RUN}`, text);
      return { id: a.id, record: { kind: 'tender', url: a.url, date: published, dateKnown: true, text, buyers: [buyer], title } };
    }
    async function lead(url: string, project: string, articleId: string) {
      const { data, error } = await db.from('leads').insert({ workspace_id: workspaceId, company_id: companyId, kind: 'won_work', project_name: project, source_url: url, is_test: true }).select('id').single();
      if (error) throw new Error(`lead ${project}: ${error.message}`);
      leadIds.push(data.id);
      await db.from('lead_articles').insert({ lead_id: data.id, article_id: articleId });
      return data.id as string;
    }

    check(leadSource(`${TED}/probe-x-${RUN}`) === 'tender' && leadSource(`${NEWS}/x`) === 'news', 'probe URLs read as the source kinds they stand for');

    // A news lead whose story names the buyer, with no captured date — Radar's situation today.
    const news = await newsArticle('news-quay', 'Probe Contractor has been awarded the quay extension by the Probe Harbour Authority. Work starts in May.');
    const newsLead = await lead(news.url, 'Quay extension', news.id);

    console.log('\nnews lead exists, award notice arrives:');
    const n1 = await notice('quay', '2026-01-10', 'Probe Harbour Authority AS', 'Quay extension works');
    const m1 = await findSameContract(db, { workspaceId, companyId, incoming: n1.record });
    check(m1.match && m1.leadId === newsLead, 'matched to the news lead on the buyer named in the story', m1.why);
    if (m1.match) {
      const r1 = await mergeSameContract(db, m1, n1.record, n1.id);
      const { data: after } = await db.from('leads').select('source_url, lead_articles(article_id)').eq('id', newsLead).single();
      check(r1.canonical === 'existing', 'news date not captured → canonical unchanged', r1.why);
      check(after!.source_url === news.url, 'lead still points at the news story');
      check((after!.lead_articles as any[]).length === 2, 'the notice is linked as a second source', `${(after!.lead_articles as any[]).length} articles on the lead`);
      const { count } = await db.from('leads').select('id', { count: 'exact', head: true }).eq('workspace_id', workspaceId);
      check(count === 1, 'still one lead for the contract', `${count} leads`);
    }

    console.log('\nnews story has its own date, later than a notice:');
    await db.from('articles').update({ published_at: '2026-02-01' }).eq('id', news.id);
    const n2 = await notice('quay-2', '2026-01-12', 'Probe Harbour Authority AS', 'Quay extension works, lot 2');
    const m2 = await findSameContract(db, { workspaceId, companyId, incoming: n2.record });
    check(m2.match && m2.leadId === newsLead, 'matched', m2.why);
    if (m2.match) {
      const r2 = await mergeSameContract(db, m2, n2.record, n2.id, { project_value: 'EUR 1,000 (total value of the notice)', country: 'NO', region: 'europe' });
      const { data: after } = await db.from('leads').select('source_url, project_value, country').eq('id', newsLead).single();
      check(r2.canonical === 'incoming', 'the earlier-dated notice becomes canonical', r2.why);
      check(after!.source_url === n2.record.url, 'lead now points at the notice');
      check(after!.project_value === 'EUR 1,000 (total value of the notice)' && after!.country === 'NO', 'empty fields filled from the notice');
    }

    console.log('\nnot the same contract:');
    const road: SourceRecord = { kind: 'tender', url: `${TED}/probe-road-${RUN}`, date: '2026-01-15', dateKnown: true, text: noticeText('2026-01-15', 'Probe Road Agency', 'Road resurfacing'), buyers: ['Probe Road Agency'], title: 'Road resurfacing' };
    const m3 = await findSameContract(db, { workspaceId, companyId, incoming: road });
    check(!m3.match, 'a different buyer does not match', m3.why);
    const far: SourceRecord = { ...n1.record, url: `${TED}/probe-far-${RUN}`, date: '2028-06-01' };
    const m4 = await findSameContract(db, { workspaceId, companyId, incoming: far });
    check(!m4.match, 'more than a year apart does not match', m4.why);

    console.log('\ntwo award notices:');
    const dam = await notice('dam', '2026-03-01', 'Probe Water Board', 'Dam gate refurbishment');
    const damLead = await lead(dam.record.url, 'Dam gate refurbishment', dam.id);
    const again: SourceRecord = { ...dam.record, url: `${TED}/probe-dam-again-${RUN}`, date: '2026-03-20' };
    const m5 = await findSameContract(db, { workspaceId, companyId, incoming: again });
    check(m5.match && m5.leadId === damLead, 'same buyer and same title → the notice republished', m5.why);
    const sluice: SourceRecord = { ...dam.record, url: `${TED}/probe-sluice-${RUN}`, date: '2026-03-20', title: 'Sluice painting', text: noticeText('2026-03-20', 'Probe Water Board', 'Sluice painting') };
    const m6 = await findSameContract(db, { workspaceId, companyId, incoming: sluice });
    check(!m6.match, 'same buyer, different title → a second contract, not merged', m6.why);

    console.log('\nambiguous:');
    const berthA = await newsArticle('news-berth-a', 'The Probe Harbour Authority has picked Probe Contractor for the ferry berth.');
    await lead(berthA.url, 'Ferry berth', berthA.id);
    const berthB = await newsArticle('news-berth-b', 'Probe Contractor starts the fuel pier for the Probe Harbour Authority.');
    await lead(berthB.url, 'Fuel pier', berthB.id);
    const berth: SourceRecord = { kind: 'tender', url: `${TED}/probe-berth-${RUN}`, date: '2026-01-20', dateKnown: true, text: noticeText('2026-01-20', 'Probe Harbour Authority AS', 'Harbour works'), buyers: ['Probe Harbour Authority AS'], title: 'Harbour works' };
    const m7 = await findSameContract(db, { workspaceId, companyId, incoming: berth });
    check(!m7.match && m7.ambiguous.length === 2, 'two news leads name the same buyer → nothing merged', m7.why);
  } catch (e: any) {
    failures++;
    console.log(`  FAIL  probe threw: ${e?.message ?? e}`);
  } finally {
    if (leadIds.length) await db.from('lead_articles').delete().in('lead_id', leadIds);
    if (articleIds.length) {
      await db.from('articles').delete().in('id', articleIds).like('url', `${NEWS}/%-${RUN}`);
      await db.from('articles').delete().in('id', articleIds).like('url', `${TED}/probe-%-${RUN}`);
    }
    await deleteTestRows(db, 'leads', 'workspace_id', workspaceId);
    await deleteTestRows(db, 'companies', 'workspace_id', workspaceId);
    await deleteTestRows(db, 'workspaces', 'id', workspaceId);
    const { count: leftA } = await db.from('articles').select('id', { count: 'exact', head: true }).in('id', articleIds.length ? articleIds : ['00000000-0000-0000-0000-000000000000']);
    const { count: leftL } = await db.from('leads').select('id', { count: 'exact', head: true }).eq('workspace_id', workspaceId);
    console.log(`\ncleaned up: ${leadIds.length} leads and ${articleIds.length} articles created; left behind: ${leftL ?? '?'} leads, ${leftA ?? '?'} articles`);
    if (leftA || leftL) failures++;
  }
  console.log(failures === 0 ? 'same-contract probe: all checks passed' : `same-contract probe: ${failures} check(s) failed`);
  process.exit(failures === 0 ? 0 : 1);
})();
