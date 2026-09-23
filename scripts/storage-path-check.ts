/**
 * Two different files with the same name never land on the same key.
 *
 *   npx tsx scripts/storage-path-check.ts
 *
 * Pure: no database, no network, no model call. In the release gate.
 *
 * WHAT THIS IS FOR. The path's leaf used to be `digest(original file name)`, on the reasoning that a
 * stable key stops a re-upload becoming a second object. A digest of the NAME identifies the name,
 * not the file — so two DIFFERENT files called `CV.pdf` resolved to one key, and the upload's
 * `upsert: true` destroyed the first. It has already happened to three real documents, whose rows
 * survive with no object behind them.
 *
 * The fixture below is therefore built so that the OLD rule fails it: every assertion turns on two
 * files that share a name and differ in nothing the old path could see.
 */
import { documentPath, pathLooksNamed, newDocumentId } from '../src/lib/storage-path';

let failures = 0;
const check = (ok: boolean, what: string, detail = '') => {
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? ` — ${detail}` : ''}`);
};

const WS = 'ws-1111';
const A = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const B = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';

console.log('--- the same file name, two documents ---');
const unattachedA = documentPath({ workspaceId: WS, type: 'cv', documentId: A, filename: 'CV.pdf' });
const unattachedB = documentPath({ workspaceId: WS, type: 'cv', documentId: B, filename: 'CV.pdf' });
check(unattachedA !== unattachedB, 'two UNATTACHED uploads called "CV.pdf" get different keys — the case that destroyed three real files', `${unattachedA.split('/').pop()} vs ${unattachedB.split('/').pop()}`);

const onSameCandidate = (id: string) => documentPath({ workspaceId: WS, type: 'cv', documentId: id, filename: 'CV.pdf', candidateId: 'cand-1' });
check(onSameCandidate(A) !== onSameCandidate(B), 'and so do two called "CV.pdf" dropped on the SAME candidate — the half nobody had noticed');

const sameEverything = documentPath({ workspaceId: WS, type: 'certificate', documentId: A, filename: 'ticket.pdf', candidateId: 'cand-1' });
check(sameEverything === documentPath({ workspaceId: WS, type: 'certificate', documentId: A, filename: 'ticket.pdf', candidateId: 'cand-1' }),
  'the same document always gets the same key, so a retry overwrites itself rather than duplicating');

console.log('\n--- the name never reaches the path ---');
const named = documentPath({ workspaceId: WS, type: 'cv', documentId: A, filename: 'Bertescu_Dumitrel_CV_Final_Readable.pdf', candidateId: 'cand-1' });
check(!/bertescu|dumitrel/i.test(named), 'a candidate\'s name in the file name does not appear in the key', named);
check(named.endsWith(`${A}.pdf`), 'the leaf is the document id and its extension, nothing else', named.split('/').pop());
check(!pathLooksNamed(named), 'and the audit agrees the key carries no name');

console.log('\n--- the extension still comes off the name, because nothing else knows it ---');
check(documentPath({ workspaceId: WS, type: 'cv', documentId: A, filename: 'x.DOCX' }).endsWith('.docx'), 'lower-cased');
check(documentPath({ workspaceId: WS, type: 'cv', documentId: A, filename: 'noext', contentType: 'application/pdf' }).endsWith('.pdf'), 'taken from the content type when the name has none');
check(documentPath({ workspaceId: WS, type: 'cv', documentId: A, filename: 'noext' }).endsWith('.bin'), 'and falls back to .bin rather than inventing one');

console.log('\n--- a path that could collide is refused, never defaulted ---');
let threw = '';
try { documentPath({ workspaceId: WS, type: 'cv', documentId: '', filename: 'CV.pdf' }); } catch (e: any) { threw = e.message; }
check(/document id/i.test(threw), 'no id means no path — the caller is refused rather than handed a colliding key', threw.slice(0, 70));
let threw2 = '';
try { documentPath({ workspaceId: WS, type: 'cv', documentId: undefined as any, filename: 'CV.pdf' }); } catch (e: any) { threw2 = e.message; }
check(!!threw2, 'and an id left off entirely is refused too');

console.log('\n--- the folder layout is unchanged, because other things read it ---');
check(unattachedA.startsWith(`${WS}/cv/unattached/`), 'an unattached document still sits under /unattached/', unattachedA);
check(onSameCandidate(A).startsWith(`${WS}/cv/cand-1/`), 'and an attached one under its candidate');

console.log('\n--- the audit accepts the old shape too, until the migration has moved everything ---');
check(!pathLooksNamed(`${WS}/cv/unattached/0592625a70b5.pdf`), 'a legacy twelve-hex digest carries no name either', 'still on 15 stored objects');
check(pathLooksNamed(`${WS}/cv/unattached/Bertescu_CV.pdf`), 'but a real name is still caught');

console.log('\n--- ids are unique ---');
const ids = new Set(Array.from({ length: 500 }, () => newDocumentId()));
check(ids.size === 500, 'five hundred generated ids, no repeats', `${ids.size}`);

console.log(failures ? `\nstorage path: ${failures} FAILED` : '\nstorage path: all checks passed');
process.exitCode = failures ? 1 : 0;
