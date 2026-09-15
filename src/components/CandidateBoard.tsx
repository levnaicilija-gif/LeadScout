'use client';
import { useEffect, useState } from 'react';
import { STAGES, STAGE_LABEL, PREFERENCE_LABEL, type Stage, type Preference } from '@/lib/candidate-stages';
import { StageSelect, useStageMove } from './CandidateStage';

/**
 * The pool as a kanban — New / Screening / Presented / Placed / Bench (owner's stages, item 24). The same rows as the
 * table, so a search or a filter shows the same people in both views.
 *
 * Drag a card to another column on a desktop; on a touch screen, which cannot drag, every card has the same stage picker
 * as the table. Either way the move goes through useStageMove, so Placed always asks for the client and the date, and
 * leaving Placed asks when the placement ended.
 */
export type BoardCard = {
  id: string; label: string; reference: string | null; name: string | null; trade: string | null; country: string | null;
  preference: Preference | null; stage: Stage; certificates: number; placedAt: string | null; href?: string;
};
type Dropped = { id: string; stage: Stage; at: number };

export function CandidateBoard({ cards: initial, enabled }: { cards: BoardCard[]; enabled: boolean }) {
  const [cards, setCards] = useState(initial);
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<Stage | null>(null);
  // The column a card was dropped on. The card itself runs the move, so its Placed prompt belongs to it.
  const [dropped, setDropped] = useState<Dropped | null>(null);
  useEffect(() => setCards(initial), [initial]);
  const moved = (id: string, stage: Stage) => setCards((cs) => cs.map((c) => (c.id === id ? { ...c, stage } : c)));

  return (
    <div className="overflow-x-auto pb-2" data-kanban>
      <div className="grid grid-flow-col auto-cols-[minmax(240px,1fr)] gap-3 min-w-[1240px] xl:min-w-0">
        {STAGES.map((stage) => {
          const column = cards.filter((c) => c.stage === stage);
          return (
            <section
              key={stage}
              data-kanban-column={stage}
              onDragOver={(e) => { if (!enabled || !dragging) return; e.preventDefault(); e.dataTransfer.dropEffect = 'move'; setOver(stage); }}
              onDragLeave={() => setOver((o) => (o === stage ? null : o))}
              onDrop={(e) => {
                e.preventDefault();
                setOver(null);
                const id = e.dataTransfer.getData('text/candidate-id') || dragging;
                setDragging(null);
                if (id && enabled) setDropped({ id, stage, at: Date.now() });
              }}
              className={`bg-panel border rounded-card p-2.5 min-h-[160px] ${over === stage ? 'border-accent' : 'border-line'}`}
            >
              <header className="flex items-baseline justify-between px-1 pb-2">
                <b className="text-[13px]">{STAGE_LABEL[stage]}</b>
                <span className="text-ink3 text-[12px]" data-kanban-count={stage}>{column.length}</span>
              </header>
              <div className="grid gap-2">
                {column.map((c) => (
                  <Card
                    key={c.id} card={c} enabled={enabled}
                    dropped={dropped?.id === c.id ? dropped : null}
                    onDragStart={() => setDragging(c.id)} onDragEnd={() => setDragging(null)}
                    onMoved={(s) => moved(c.id, s)}
                  />
                ))}
                {column.length === 0 && <div className="text-ink3 text-[12px] px-1 py-3">Nobody here</div>}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}

function Card({ card, enabled, dropped, onDragStart, onDragEnd, onMoved }: {
  card: BoardCard; enabled: boolean; dropped: Dropped | null; onDragStart: () => void; onDragEnd: () => void; onMoved: (s: Stage) => void;
}) {
  const move = useStageMove({ id: card.id, name: card.name, stage: card.stage, placedAt: card.placedAt }, onMoved);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (dropped) move.request(dropped.stage); }, [dropped?.at]);
  return (
    <article
      data-kanban-card={card.id}
      draggable={enabled}
      onDragStart={(e) => { e.dataTransfer.setData('text/candidate-id', card.id); e.dataTransfer.effectAllowed = 'move'; onDragStart(); }}
      onDragEnd={onDragEnd}
      className={`border border-line rounded px-3 py-2.5 bg-[#FAFBFC] text-[13px] ${enabled ? 'cursor-grab active:cursor-grabbing' : ''}`}
    >
      {card.href
        ? <a href={card.href} className="font-semibold text-ink hover:text-accent">{card.label} · {card.name ?? 'name not printed'}</a>
        : <b className="font-semibold">{card.label} · {card.name ?? 'name not printed'}</b>}
      <div className="text-ink3 text-[11px]">{card.reference}</div>
      <div className="text-ink2 text-[12px] mt-0.5">{[card.trade, card.country, card.preference ? PREFERENCE_LABEL[card.preference] : null].filter(Boolean).join(' · ') || '—'}</div>
      <div className="text-ink3 text-[12px] mt-0.5">{card.certificates} certificate{card.certificates === 1 ? '' : 's'}{card.placedAt ? ` · placed at ${card.placedAt}` : ''}</div>
      <div className="mt-2"><StageSelect candidate={{ id: card.id, name: card.name, stage: card.stage, placedAt: card.placedAt }} disabled={!enabled} onMoved={onMoved} /></div>
      {move.err && !move.dialog && <div className="text-bad text-[12px] mt-1">{move.err}</div>}
      {move.dialog}
    </article>
  );
}
