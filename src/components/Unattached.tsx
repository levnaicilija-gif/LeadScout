'use client';
import { useState } from 'react';
import { AttachChoice } from './AttachChoice';

/**
 * Documents in the workspace that belong to nobody.
 *
 * These are not a failure of intake: a certificate is not allowed to open a record by itself,
 * so a ticket for someone who is not in the pool correctly waits here for a decision. What was
 * missing is any way to take that decision after the drop — a file that missed its person on
 * the day it arrived had nowhere to go afterwards, and seven of them simply sat.
 *
 * Collapsed by default, because on a good day it is empty and a permanent empty panel trains
 * people to stop reading the screen.
 */
export type Orphan = {
  id: string;
  type: string;
  cert_body?: string | null;
  holder?: string | null;
  file?: string | null;
  uploaded_at?: string | null;
};

export function Unattached({ docs }: { docs: Orphan[] }) {
  const [open, setOpen] = useState(false);
  const [settled, setSettled] = useState<Record<string, string>>({});
  const left = docs.filter((d) => !settled[d.id]);

  if (!docs.length) return null;

  return (
    <div className="bg-panel border border-line rounded-card mb-4">
      <button onClick={() => setOpen(!open)} className="w-full text-left px-[18px] py-3 flex items-center justify-between gap-3">
        <span className="flex items-center gap-2.5">
          <span className={`w-2.5 h-2.5 rounded-full ${left.length ? 'bg-warn' : 'bg-ok'}`} />
          <b className="font-semibold">
            {left.length ? `${left.length} document${left.length === 1 ? '' : 's'} attached to nobody` : 'All documents are attached to someone'}
          </b>
          <span className="text-ink3 text-[12px]">
            {left.length ? 'each one is a real document about a real person — say who' : 'nothing waiting'}
          </span>
        </span>
        <span className="text-ink3 text-[12px]">{open ? 'Hide' : 'Show'}</span>
      </button>

      {open && (
        <div className="px-[18px] pb-4 border-t border-line2 pt-3 grid gap-3">
          {left.length === 0 && <div className="text-ink3 text-[13px]">Nothing left — every document has a person.</div>}
          {left.map((d) => (
            <div key={d.id} className="border border-line rounded-card p-3">
              <div className="text-[14px] font-semibold">
                {d.type === 'certificate' ? `Certificate — ${d.cert_body ?? 'body not stated'}` : d.type.charAt(0).toUpperCase() + d.type.slice(1)}
                {d.holder ? <span className="text-ink2 font-normal"> · {d.holder}</span> : <span className="text-ink3 font-normal"> · no holder name read</span>}
              </div>
              <div className="text-ink3 text-[12px] mt-0.5">
                {d.file ?? 'file name not stored'}{d.uploaded_at ? ` · dropped ${new Date(d.uploaded_at).toLocaleDateString('en-GB')}` : ''}
              </div>
              <AttachChoice
                documentId={d.id}
                holder={d.holder}
                onDone={(r) => setSettled((s) => ({ ...s, [d.id]: r.reference }))}
              />
            </div>
          ))}
          {Object.keys(settled).length > 0 && (
            <div className="text-[12px] text-ok">
              Settled this session: {Object.entries(settled).map(([, ref]) => ref).join(', ')}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
