import { Logo } from '@/components/Logo';

/**
 * The two-panel sign-in from design/leadscout-design-v4.html.
 *
 * The left panel says what the product does and backs it with three live numbers; the right
 * holds the form. The numbers are counted from the database on each load — a login screen is
 * the last place to put a figure that was true once. If a count cannot be read it is left out
 * rather than rounded to something plausible.
 *
 * Below 980px the panels stack and the left one is dropped: on a phone the form is the screen.
 */
export function AuthShell({ stats, title, hint, children }: {
  stats: { n: string; label: string }[];
  title: string;
  hint: string;
  children: React.ReactNode;
}) {
  return (
    <main className="min-h-screen grid grid-cols-1 lg:grid-cols-[1.1fr_1fr]">
      <div className="hidden lg:flex bg-rail text-railink px-14 py-12 flex-col justify-between relative overflow-hidden">
        <div className="absolute -right-[180px] -bottom-[180px] w-[520px] h-[520px] rounded-full border-[80px] border-tool-radar/20" />
        <div className="absolute -right-[60px] -bottom-[60px] w-[280px] h-[280px] rounded-full border-[40px] border-tool-leads/25" />
        <div className="relative z-10"><Logo light /></div>
        <div className="relative z-10">
          <h2 className="font-display text-white text-[34px] leading-[1.15] tracking-[-.6px] m-0 mb-3.5 max-w-[16ch]">
            Know who needs people before the job is posted.
          </h2>
          <p className="max-w-[44ch] text-[#AEB9C8] text-[15px]">
            Every morning LeadScout reads the industry, finds the companies that just won work, names the person to call — and has your verified, anonymized candidates ready to send.
          </p>
          <div className="grid grid-cols-3 gap-3 mt-6">
            {stats.map((s) => (
              <div key={s.label} className="bg-white/[.06] border border-white/10 rounded-[12px] px-3.5 py-3">
                <b className="block font-display text-white text-[22px] font-extrabold">{s.n}</b>
                <span className="text-[12px] text-raildim">{s.label}</span>
              </div>
            ))}
          </div>
        </div>
        <div className="text-[12px] text-raildim relative z-10">Built with RFBT Recruitment · London · Beograd</div>
      </div>

      <div className="grid place-items-center p-6 sm:p-10">
        <div className="w-full max-w-[400px]">
          <a href="/"><Logo /></a>
          <h1 className="font-display mt-[22px] mb-1 text-[24px] font-extrabold tracking-[-.4px]">{title}</h1>
          <p className="text-ink3 text-[13px] m-0 mb-[18px]">{hint}</p>
          {children}
        </div>
      </div>
    </main>
  );
}
