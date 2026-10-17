export type Row = Record<string, string>;

export type ParamChange = { name: string; old: string; new: string; group?: string; filler?: boolean; derived?: boolean };

export type Change = {
  distName: string;
  cls: string;
  version: string;
  mrbts: number;
  cel: number;
  params: ParamChange[];
};

export type ConvertStats = {
  inputRows: number;
  comparedParams: string[];
  dbFiles: number;
  dbObjectsScanned: number;
  dbObjectsMatched: number;
  changedObjects: number;
  changedValues: number;
  unchangedValues: number;
};

export type DbSource = { name: string; bytes: number; from: "upload" | "link" };

export type ConvertResponse = {
  dbSources: DbSource[];
  xml: string;
  fileName: string;
  planName: string;
  stats: ConvertStats;
  changes: Change[];
  warnings: string[];
};
