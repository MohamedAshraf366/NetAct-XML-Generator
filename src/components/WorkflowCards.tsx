import Link from "next/link";

function Arrow() {
  return (
    <svg
      viewBox="0 0 24 24"
      className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M5 12h14M13 6l6 6-6 6" />
    </svg>
  );
}

function FileIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      className="h-5 w-5"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <path d="M14 2v6h6M8 13h5M8 17h8" />
    </svg>
  );
}

function DumpIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      className="h-5 w-5"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <ellipse cx="12" cy="5" rx="8" ry="3" />
      <path d="M4 5v6c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 11v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6" />
    </svg>
  );
}

export default function WorkflowCards() {
  return (
    <section aria-label="Choose what to create" className="mb-6 grid gap-3 sm:grid-cols-2">
      <Link
        href="/create-xml"
        className="group surface flex flex-col justify-between gap-4 p-4 transition hover:-translate-y-0.5 hover:border-brand-300 hover:shadow-lg hover:shadow-brand-500/10 sm:p-5 dark:hover:border-brand-400/40"
      >
        <div className="flex items-start gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-brand-500/10 text-brand-600 dark:bg-brand-400/10 dark:text-brand-300">
            <FileIcon />
          </span>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="font-semibold tracking-tight">Create XML</h2>
              <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-slate-500 dark:bg-white/10 dark:text-slate-300">
                Change plan
              </span>
            </div>
            <p className="mt-1 text-xs leading-relaxed text-slate-500 dark:text-slate-400">
              Compare a CSV / Excel plan with the database. Only the cells that changed are exported.
            </p>
          </div>
        </div>
        <div className="flex items-center justify-between text-xs font-medium text-brand-600 dark:text-brand-300">
          <span>CSV / Excel → RAML XML</span>
          <span className="inline-flex items-center gap-1">
            Open <Arrow />
          </span>
        </div>
      </Link>

      <Link
        href="/fill"
        className="group relative flex flex-col justify-between gap-4 overflow-hidden rounded-2xl border border-white/10 bg-gradient-to-br from-brand-600 via-violet-600 to-fuchsia-600 p-4 text-white shadow-xl shadow-brand-500/20 transition hover:-translate-y-0.5 hover:shadow-brand-500/35 sm:p-5"
      >
        <span className="pointer-events-none absolute -right-8 -top-10 h-28 w-28 rounded-full bg-white/15 blur-2xl" aria-hidden="true" />
        <div className="relative flex items-start gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-white/15 text-white">
            <DumpIcon />
          </span>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="font-semibold tracking-tight">Create dump</h2>
              <span className="rounded-full bg-white/15 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-white/90">
                Full export
              </span>
            </div>
            <p className="mt-1 text-xs leading-relaxed text-white/80">
              Rebuild an empty NetAct template from a full RAML XML export — every object, parameter and nested list.
            </p>
          </div>
        </div>
        <div className="relative flex items-center justify-between text-xs font-medium text-white/90">
          <span>RAML XML → ready Access dump</span>
          <span className="inline-flex items-center gap-1">
            Open <Arrow />
          </span>
        </div>
      </Link>
    </section>
  );
}
