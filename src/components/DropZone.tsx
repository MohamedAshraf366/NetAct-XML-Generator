"use client";

import { useRef, useState } from "react";

type Props = {
  label: string;
  title?: string;
  hint: string;
  accept: string;
  multiple?: boolean;
  files: File[];
  onChange: (files: File[]) => void;
};

export const sizeLabel = (n: number) =>
  n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;

export default function DropZone({ label, title, hint, accept, multiple, files, onChange }: Props) {
  const ref = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);

  const take = (list: FileList | null) => {
    if (!list || list.length === 0) return;
    const next = Array.from(list);
    onChange(multiple ? [...files, ...next] : next.slice(0, 1));
  };

  return (
    <div>
      {label && <p className="mb-1.5 text-sm font-semibold text-slate-800 dark:text-slate-200">{label}</p>}
      <div
        role="button"
        tabIndex={0}
        onClick={() => ref.current?.click()}
        onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && ref.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          take(e.dataTransfer.files);
        }}
        className={`flex cursor-pointer flex-col items-center justify-center rounded-2xl border-2 border-dashed px-4 py-8 text-center transition ${
          over
            ? "border-brand-500 bg-brand-500/10"
            : "border-slate-300 bg-white/60 hover:border-brand-400 hover:bg-brand-500/5 dark:border-white/15 dark:bg-white/[0.02] dark:hover:border-brand-400/60"
        }`}
      >
        <span className="mb-3 flex h-11 w-11 items-center justify-center rounded-xl bg-gradient-to-br from-brand-600 to-violet-500 text-white shadow-lg shadow-brand-500/25">
          <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12" />
          </svg>
        </span>
        <p className="text-sm text-slate-700 dark:text-slate-200">
          {title ?? "Drop your file here"} or <span className="font-semibold text-brand-600 dark:text-brand-400">browse</span>
        </p>
        <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">{hint}</p>
        <input
          ref={ref}
          type="file"
          accept={accept}
          multiple={multiple}
          className="hidden"
          onChange={(e) => {
            take(e.target.files);
            e.target.value = "";
          }}
        />
      </div>

      {files.length > 0 && (
        <ul className="mt-3 space-y-1.5">
          {files.map((f, i) => (
            <li
              key={`${f.name}-${i}`}
              className="flex items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white/70 px-3 py-2 text-sm backdrop-blur-xl dark:border-white/10 dark:bg-white/5"
            >
              <span className="flex min-w-0 items-center gap-2">
                <svg viewBox="0 0 24 24" className="h-4 w-4 shrink-0 text-brand-500" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                  <path d="M14 2v6h6" />
                </svg>
                <span className="truncate text-slate-700 dark:text-slate-200">
                  {f.name} <span className="text-xs text-slate-400 dark:text-slate-500">· {sizeLabel(f.size)}</span>
                </span>
              </span>
              <button
                type="button"
                onClick={() => onChange(files.filter((_, j) => j !== i))}
                className="shrink-0 rounded-lg px-2 py-1 text-xs text-slate-400 transition hover:bg-red-500/10 hover:text-red-600 dark:hover:text-red-400"
                aria-label={`Remove ${f.name}`}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
