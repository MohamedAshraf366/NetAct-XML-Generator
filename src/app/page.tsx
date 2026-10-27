import Link from "next/link";
import ThemeToggle from "@/components/ThemeToggle";
import WorkflowCards from "@/components/WorkflowCards";

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

      <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6 sm:py-8 lg:py-12">
        <header className="mb-8 flex items-center justify-between gap-4 animate-fade-up sm:mb-10">
          <div className="flex min-w-0 items-center gap-3">
            <Logo />
            <div className="min-w-0 leading-tight">
              <p className="truncate font-semibold tracking-tight">NetAct XML Generator</p>
              <p className="truncate text-xs text-slate-500 dark:text-slate-400">Create XML or a NetAct dump</p>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Link href="/create-xml" className="btn-ghost hidden !px-3 !py-1.5 text-xs sm:inline-flex">
              Create XML
            </Link>
            <Link href="/fill" className="btn-primary hidden !px-3 !py-1.5 text-xs sm:inline-flex">
              Create dump
            </Link>
            <ThemeToggle />
          </div>
        </header>

        <section className="mb-6 max-w-3xl animate-fade-up sm:mb-7">
          <span className="inline-flex items-center gap-2 rounded-full border border-slate-200 bg-white/70 px-3 py-1 text-xs font-medium text-slate-600 backdrop-blur-xl dark:border-white/10 dark:bg-white/5 dark:text-slate-300">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
            Create change XML or a complete dump
          </span>
          <h1 className="mt-4 font-semibold tracking-tight text-3xl sm:text-4xl md:text-5xl">
            Create change XML or a ready <span className="text-gradient">NetAct dump</span>.
          </h1>
          <p className="mt-4 text-base leading-relaxed text-slate-600 dark:text-slate-400">
            Compare a CSV / Excel plan with the current database for a clean, change-only XML — or rebuild an empty
            Access template from a full RAML export.
          </p>
        </section>

        <div className="animate-fade-up [animation-delay:75ms]">
          <WorkflowCards />
        </div>

        <section aria-label="How it works" className="mt-8 grid gap-3 sm:grid-cols-3">
          {[
            {
              title: "Choose a workflow",
              body: "Create XML for a change plan, or Create dump for a complete Access database.",
            },
            {
              title: "Add your files",
              body: "A CSV / Excel plan with an optional database, or a full RAML export with the empty template.",
            },
            {
              title: "Download the result",
              body: "A change-only NetAct plan XML, or a ZIP with the ready-to-import .mdb.",
            },
          ].map((step, index) => (
            <div key={step.title} className="surface p-4">
              <span className="flex h-7 w-7 items-center justify-center rounded-full bg-brand-500/10 text-xs font-semibold text-brand-600 dark:bg-brand-400/10 dark:text-brand-300">
                {index + 1}
              </span>
              <h3 className="mt-3 text-sm font-semibold">{step.title}</h3>
              <p className="mt-1 text-xs leading-relaxed text-slate-500 dark:text-slate-400">{step.body}</p>
            </div>
          ))}
        </section>
      </div>
    </>
  );
}
