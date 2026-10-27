import Link from "next/link";
import Filler from "@/components/Filler";
import ThemeToggle from "@/components/ThemeToggle";

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

export const metadata = {
  title: "Create NetAct dump · NetAct XML Generator",
  description: "Create a ready-to-import NetAct Access dump from a full RAML XML export.",
};

export default function FillPage() {
  return (
    <>
      <div className="aurora-bg" aria-hidden="true">
        <div className="aurora-blob left-[-10%] top-[-10%] h-[36rem] w-[36rem] bg-brand-500/40" />
        <div className="aurora-blob right-[-15%] top-[10%] h-[32rem] w-[32rem] bg-fuchsia-500/30 [animation-delay:-4s]" />
        <div className="aurora-blob bottom-[-20%] left-[20%] h-[34rem] w-[34rem] bg-violet-500/30 [animation-delay:-8s]" />
      </div>

      <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6 sm:py-8 lg:py-12">
        <header className="mb-8 flex items-center justify-between gap-4 animate-fade-up sm:mb-10">
          <Link href="/" className="flex min-w-0 items-center gap-3">
            <Logo />
            <div className="min-w-0 leading-tight">
              <p className="truncate font-semibold tracking-tight">NetAct XML Generator</p>
              <p className="truncate text-xs text-slate-500 dark:text-slate-400">RAML XML → ready Access dump</p>
            </div>
          </Link>
          <div className="flex shrink-0 items-center gap-2">
            <Link href="/create-xml" className="btn-ghost hidden !px-3 !py-1.5 text-xs sm:inline-flex">
              Create XML
            </Link>
            <ThemeToggle />
          </div>
        </header>

        <section className="mb-8 max-w-3xl animate-fade-up sm:mb-10">
          <span className="inline-flex items-center gap-2 rounded-full border border-slate-200 bg-white/70 px-3 py-1 text-xs font-medium text-slate-600 backdrop-blur-xl dark:border-white/10 dark:bg-white/5 dark:text-slate-300">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
            Full export, streamed in the background
          </span>
          <h1 className="mt-4 font-semibold tracking-tight text-3xl sm:text-4xl md:text-5xl">
            Create a ready-to-import <span className="text-gradient">NetAct dump</span>.
          </h1>
          <p className="mt-4 text-base leading-relaxed text-slate-600 dark:text-slate-400">
            Upload the full NetAct XML export and the empty template. Every object, parameter and nested list is
            created in the template tables, then returned as a ZIP with the ready <code>.mdb</code>.
          </p>
          <p className="mt-3 text-sm text-slate-500 dark:text-slate-400">
            Need a change plan instead?{" "}
            <Link href="/create-xml" className="font-medium text-brand-600 hover:text-brand-500 dark:text-brand-300 dark:hover:text-brand-200">
              Create XML
            </Link>
          </p>
        </section>

        <div className="animate-fade-up [animation-delay:100ms]">
          <Filler />
        </div>
      </div>
    </>
  );
}
