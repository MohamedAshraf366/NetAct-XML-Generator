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
export type ParamDef = { cls: string; suffix: string; defaultOn: boolean };

export const PARAMS: Record<string, ParamDef> = {
  angle: { cls: "NOKLTE:LNCEL", suffix: "", defaultOn: true },
  dlRsBoost: { cls: "NOKLTE:LNCEL_FDD", suffix: "/LNCEL_FDD-0", defaultOn: true },
  dlSectorBFWeightProfName: { cls: "NOKLTE:LNCEL_TDD", suffix: "/LNCEL_TDD-0", defaultOn: true },
  mMimoSectorBFProfName: { cls: "NOKLTE:LNCEL_TDD", suffix: "/LNCEL_TDD-0", defaultOn: true },
  phyCellId: { cls: "NOKLTE:LNCEL", suffix: "", defaultOn: true },
  tac: { cls: "NOKLTE:LNCEL", suffix: "", defaultOn: true },
  pMax: { cls: "NOKLTE:LNCEL", suffix: "", defaultOn: true },
};

export const PARAM_NAMES = Object.keys(PARAMS);
export const DEFAULT_PARAM_NAMES = PARAM_NAMES.filter((p) => PARAMS[p].defaultOn);

/** Classes the database loader keeps. */
export const RELEVANT_CLASSES = new Set(Object.values(PARAMS).map((p) => p.cls));

/** Used when the database object carries no version attribute. */
export const DEFAULT_VERSION = "xL24R3_2413_110";
