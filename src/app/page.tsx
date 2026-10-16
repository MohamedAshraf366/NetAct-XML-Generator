import Converter from "@/components/Converter";
import ThemeToggle from "@/components/ThemeToggle";
import { ALL_PARAM_NAMES, DEFAULT_NR_PARAM_NAMES, DEFAULT_PARAM_NAMES } from "@/lib/config";

function Logo() {
  return (
    <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-brand-600 to-violet-500 text-white shadow-lg shadow-brand-500/30">
      <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
        <path d="M14 2v6h6M9 15l2 2 4-4" />
      </svg>
    </span>
  );
}

export default function Home() {
  return (
    <>
      <div className="aurora-bg" aria-hidden="true">
        <div className="aurora-blob left-[-10%] top-[-10%] h-[36rem] w-[36rem] bg-brand-500/40" />
        <div className="aurora-blob right-[-15%] top-[10%] h-[32rem] w-[32rem] bg-fuchsia-500/30 [animation-delay:-4s]" />
        <div className="aurora-blob bottom-[-20%] left-[20%] h-[34rem] w-[34rem] bg-violet-500/30 [animation-delay:-8s]" />
      </div>

      <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6 lg:py-12">
        <header className="mb-10 flex items-center justify-between gap-4 animate-fade-up">
          <div className="flex items-center gap-3">
            <Logo />
            <div className="leading-tight">
              <p className="font-semibold tracking-tight">NetAct XML Generator</p>
              <p className="text-xs text-slate-500 dark:text-slate-400">CSV / Excel → NetAct XML</p>
            </div>
          </div>
          <ThemeToggle />
        </header>

        <section className="mb-10 max-w-3xl animate-fade-up">
          <span className="inline-flex items-center gap-2 rounded-full border border-slate-200 bg-white/70 px-3 py-1 text-xs font-medium text-slate-600 backdrop-blur-xl dark:border-white/10 dark:bg-white/5 dark:text-slate-300">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
            Only changed values are exported
          </span>
          <h1 className="mt-4 font-semibold tracking-tight text-4xl sm:text-5xl">
            Compare plans, ship only the <span className="text-gradient">deltas</span>.
          </h1>
          <p className="mt-4 text-base leading-relaxed text-slate-600 dark:text-slate-400">
            Upload your planned cell parameters and the current database. NetAct XML Generator writes only the values that actually changed
            into a clean NetAct plan XML — ready to import.
          </p>
        </section>

        <div className="animate-fade-up [animation-delay:100ms]">
          <Converter
            paramNames={ALL_PARAM_NAMES}
            defaultParams={[...DEFAULT_PARAM_NAMES, ...DEFAULT_NR_PARAM_NAMES]}
          />
        </div>
      </div>
    </>
  );
}
