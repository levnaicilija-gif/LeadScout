'use client';
import { useState } from 'react';
export function Help({ title, intro, rows = [] }: { title: string; intro: string; rows?: [string, string][] }) {
  const [on, setOn] = useState(false);
  return (<>
    <button onClick={() => setOn(!on)} aria-label="Explain" className={`ml-2 inline-grid place-items-center w-[22px] h-[22px] rounded-full border text-[12px] font-semibold align-middle ${on ? 'border-accent text-accent' : 'border-line text-ink3'}`}>?</button>
    {on && <div className="bg-panel border border-line border-l-[3px] border-l-accent rounded p-4 mb-4 text-[13px] leading-[1.55] max-w-[90ch]"><b className="block mb-1">{title}</b>{intro}
      {rows.length > 0 && <div className="grid grid-cols-[88px_minmax(0,1fr)] sm:grid-cols-[110px_1fr] gap-x-3 gap-y-1.5 mt-2">{rows.map(([k, v]) => <><span className="text-ink3">{k}</span><span>{v}</span></>)}</div>}</div>}
  </>);
}
