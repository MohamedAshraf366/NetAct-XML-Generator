/**
 * Which CSV column maps to which managed-object class.
 *
 * `suffix` is appended to the LNCEL distName.
 * `defaultOn` = compared unless the user unticks it.
 *
 * Verified from the reference XMLs (700 / 1800 FDD and 2600 TDD):
 *   angle                      -> LNCEL
 *   dlRsBoost                  -> LNCEL_FDD-0
 *   dlSectorBFWeightProfName   -> LNCEL_TDD-0
 *   mMimoSectorBFProfName      -> LNCEL_TDD-0
 *   phyCellId                  -> LNCEL                       (PCI jobs: pci700 / pci1800 / pci2600)
 * tac / pMax are assumed to be LNCEL parameters; they have not appeared in any reference XML yet.
 *
 * Every column found in the uploaded file is compared; untick a parameter in the UI to leave it out.
 */
export type Tech = "LTE" | "NR";

export type ParamDef = {
  cls: string;
  suffix: string;
  defaultOn: boolean;
  /** When set, the object id is taken from this CSV column instead of `suffix` (e.g. LNREL). */
  idColumn?: string;
  /** Prefix for that id, e.g. "LNREL-" -> "…/LNCEL-1/LNREL-361". */
  idPrefix?: string;
  tech?: Tech;
  group?: string;
  dbColumn?: string;
};

const NRCELL_CLS = "com.nokia.srbts.nrbts:NRCELL";

export const LTE_PARAMS: Record<string, ParamDef> = {
  angle: { cls: "NOKLTE:LNCEL", suffix: "", defaultOn: true, tech: "LTE" },
  dlRsBoost: { cls: "NOKLTE:LNCEL_FDD", suffix: "/LNCEL_FDD-0", defaultOn: true, tech: "LTE" },
  dlSectorBFWeightProfName: { cls: "NOKLTE:LNCEL_TDD", suffix: "/LNCEL_TDD-0", defaultOn: true, tech: "LTE" },
  mMimoSectorBFProfName: { cls: "NOKLTE:LNCEL_TDD", suffix: "/LNCEL_TDD-0", defaultOn: true, tech: "LTE" },
  phyCellId: { cls: "NOKLTE:LNCEL", suffix: "", defaultOn: true, tech: "LTE" },
  tac: { cls: "NOKLTE:LNCEL", suffix: "", defaultOn: true, tech: "LTE" },
  pMax: { cls: "NOKLTE:LNCEL", suffix: "", defaultOn: true, tech: "LTE" },
  // Random access (RACH) - LNCEL
  raNondedPreamb: { cls: "NOKLTE:LNCEL", suffix: "", defaultOn: true, tech: "LTE" },
  raPreGrASize: { cls: "NOKLTE:LNCEL", suffix: "", defaultOn: true, tech: "LTE" },
  raSmallVolUl: { cls: "NOKLTE:LNCEL", suffix: "", defaultOn: true, tech: "LTE" },
  raMsgPoffGrB: { cls: "NOKLTE:LNCEL", suffix: "", defaultOn: true, tech: "LTE" },
  prachCS: { cls: "NOKLTE:LNCEL_FDD", suffix: "/LNCEL_FDD-0", defaultOn: false, tech: "LTE" },
  // Neighbour handover relations (LNREL)
  amleAllowed: { cls: "NOKLTE:LNREL", suffix: "", defaultOn: true, idColumn: "lnRelId", idPrefix: "LNREL-", tech: "LTE" },
  handoverAllowed: { cls: "NOKLTE:LNREL", suffix: "", defaultOn: true, idColumn: "lnRelId", idPrefix: "LNREL-", tech: "LTE" },
  removeAllowed: { cls: "NOKLTE:LNREL", suffix: "", defaultOn: true, idColumn: "lnRelId", idPrefix: "LNREL-", tech: "LTE" },
};

export const NR_PARAMS: Record<string, ParamDef> = {
  // Base NRCELL
  angle: { cls: NRCELL_CLS, suffix: "", defaultOn: true, tech: "NR" },
  dlQam256PowerBackoffSub6: { cls: NRCELL_CLS, suffix: "", defaultOn: true, tech: "NR" },
  ssPbchBlockPower: { cls: NRCELL_CLS, suffix: "", defaultOn: true, tech: "NR" },
  // beamSet group
  basicBeamSet: { cls: NRCELL_CLS, suffix: "", defaultOn: true, tech: "NR", group: "beamSet", dbColumn: "beamSet_basicBeamSet" },
  beamSetInUse: { cls: NRCELL_CLS, suffix: "", defaultOn: true, tech: "NR", group: "beamSet", dbColumn: "beamSet_beamSetInUse" },
  externalAntennaType: { cls: NRCELL_CLS, suffix: "", defaultOn: true, tech: "NR", group: "beamSet", dbColumn: "beamSet_externalAntennaType" },
  leftEdgeAngle: { cls: NRCELL_CLS, suffix: "", defaultOn: true, tech: "NR", group: "beamSet", dbColumn: "beamSet_leftEdgeAngle" },
  lowerEdgeAngle: { cls: NRCELL_CLS, suffix: "", defaultOn: true, tech: "NR", group: "beamSet", dbColumn: "beamSet_lowerEdgeAngle" },
  nrBtsBeamRefinementP2: { cls: NRCELL_CLS, suffix: "", defaultOn: true, tech: "NR", group: "beamSet", dbColumn: "beamSet_nrBtsBeamRefinementP2" },
  rightEdgeAngle: { cls: NRCELL_CLS, suffix: "", defaultOn: true, tech: "NR", group: "beamSet", dbColumn: "beamSet_rightEdgeAngle" },
  tiltOffset: { cls: NRCELL_CLS, suffix: "", defaultOn: true, tech: "NR", group: "beamSet", dbColumn: "beamSet_tiltOffset" },
  upperEdgeAngle: { cls: NRCELL_CLS, suffix: "", defaultOn: true, tech: "NR", group: "beamSet", dbColumn: "beamSet_upperEdgeAngle" },
  // periodicCsiAcquisition group
  csiReportPeriodicity: { cls: NRCELL_CLS, suffix: "", defaultOn: true, tech: "NR", group: "periodicCsiAcquisition", dbColumn: "pCA_csiReportPeriodicity" },
  csirsNumberWithinReportPeriod_Set1: { cls: NRCELL_CLS, suffix: "", defaultOn: true, tech: "NR", group: "periodicCsiAcquisition", dbColumn: "pCA_csirsNumberWithinReportPeriod_Set1" },
  csirsPower: { cls: NRCELL_CLS, suffix: "", defaultOn: true, tech: "NR", group: "periodicCsiAcquisition", dbColumn: "pCA_csirsPower" },
  maxCsirsNumber: { cls: NRCELL_CLS, suffix: "", defaultOn: true, tech: "NR", group: "periodicCsiAcquisition", dbColumn: "pCA_maxCsirsNumber" },
  scramblingIdStep: { cls: NRCELL_CLS, suffix: "", defaultOn: true, tech: "NR", group: "periodicCsiAcquisition", dbColumn: "pCA_scramblingIdStep" },
};

export const PARAMS: Record<string, ParamDef> = LTE_PARAMS;

export function paramsFor(tech: Tech): Record<string, ParamDef> {
  return tech === "NR" ? NR_PARAMS : LTE_PARAMS;
}

export const PARAM_NAMES = Object.keys(LTE_PARAMS);
export const DEFAULT_PARAM_NAMES = PARAM_NAMES.filter((p) => LTE_PARAMS[p].defaultOn);

export const NR_PARAM_NAMES = Object.keys(NR_PARAMS);
export const DEFAULT_NR_PARAM_NAMES = NR_PARAM_NAMES.filter((p) => NR_PARAMS[p].defaultOn);

export const ALL_PARAM_NAMES = Array.from(new Set([...PARAM_NAMES, ...NR_PARAM_NAMES]));

export function paramNamesFor(tech: Tech): string[] {
  return tech === "NR" ? NR_PARAM_NAMES : PARAM_NAMES;
}

export function defaultParamNamesFor(tech: Tech): string[] {
  return tech === "NR" ? DEFAULT_NR_PARAM_NAMES : DEFAULT_PARAM_NAMES;
}

/** Classes the database loader keeps. */
export const RELEVANT_CLASSES = new Set<string>([...Object.values(LTE_PARAMS).map((p) => p.cls), ...Object.values(NR_PARAMS).map((p) => p.cls)]);

/** Used when the database object carries no version attribute. */
export const DEFAULT_VERSION = "xL24R3_2413_110";
export const DEFAULT_NR_VERSION = "NRBTSCL24R3_2413_120";
