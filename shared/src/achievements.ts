// Achievements manifest (`achievements.json`) shipped by the studio per edition.
// Common denominator of Steamworks + EOS so existing definitions port with a
// near 1:1 field mapping — see docs/achievements.md. Pure, no dependencies.

export const ACHIEVEMENTS_SCHEMA_VERSION = 1;

/** BCP-47 locale -> text. Must contain the manifest's defaultLocale. */
export type LocalizedText = Record<string, string>;

export type StatType = "int" | "float";

/**
 * How ticketd folds an ingested value into the stored stat (EOS model):
 * sum = counter, max = best score, min = best time, latest = last value.
 */
export type StatAggregation = "sum" | "max" | "min" | "latest";

export interface StatDefinition {
  /** API name, shared verbatim with Steam/EOS: [A-Za-z0-9_]{1,64} */
  id: string;
  type: StatType;
  aggregation: StatAggregation;
  displayName?: LocalizedText;
  defaultValue?: number;
  /** Ingested values outside [minValue, maxValue] are rejected (Steam "Min/Max Value") */
  minValue?: number;
  maxValue?: number;
  /** Largest amount one ingest may add to a "sum" stat (Steam "Max Change") */
  maxChange?: number;
  /** Negative ingests on a "sum" stat are rejected (Steam "Increment Only") */
  incrementOnly?: boolean;
}

export interface StatThreshold {
  stat: string;
  /** Met when value >= threshold, or value <= threshold for "min" stats */
  value: number;
}

export type UnlockRule =
  /** The game unlocks it explicitly (Steam SetAchievement, EOS UnlockAchievements) */
  | { type: "direct" }
  /** Unlocks when ALL thresholds are met (Steam Progress Stat, EOS StatThresholds) */
  | { type: "stat"; thresholds: StatThreshold[] };

export type AchievementGrade = "bronze" | "silver" | "gold";

export interface AchievementDefinition {
  /** API name, shared verbatim with Steam/EOS: [A-Za-z0-9_]{1,64} */
  id: string;
  name: LocalizedText;
  /** Shown once unlocked (or always, if lockedDescription is absent) */
  description: LocalizedText;
  /** Shown while locked (EOS LockedDescription, Apple pre-earned, Xbox locked) */
  lockedDescription?: LocalizedText;
  /** Hidden achievements show a placeholder until unlocked */
  hidden?: boolean;
  /** Relative path inside the manifest bundle, or ipfs:// URI */
  icon: string;
  iconLocked?: string;
  unlock: UnlockRule;
  grade?: AchievementGrade;
  /** Integer 0..200 per achievement, 1000 total (Xbox / Apple / Epic convention) */
  points?: number;
  /** Display order while locked (Google Play "List Order") */
  order?: number;
}

export interface AchievementsManifest {
  schemaVersion: typeof ACHIEVEMENTS_SCHEMA_VERSION;
  defaultLocale: string;
  stats: StatDefinition[];
  achievements: AchievementDefinition[];
}

export type ValidationResult =
  | { ok: true; errors: []; manifest: AchievementsManifest }
  | { ok: false; errors: string[] };

const ID_RE = /^[A-Za-z0-9_]{1,64}$/;
const LOCALE_RE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;
const MAX_NAME = 100;
const MAX_DESCRIPTION = 500;
const MAX_POINTS = 200;
const MAX_TOTAL_POINTS = 1000;

type Json = Record<string, unknown>;

const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const isFiniteNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

// Unknown keys are errors (catches typos); "x-" keys are free-form extensions.
function checkKeys(o: Json, allowed: readonly string[], path: string, errors: string[]): void {
  for (const k of Object.keys(o)) {
    if (!allowed.includes(k) && !k.startsWith("x-")) errors.push(`${path}: unknown field "${k}"`);
  }
}

function checkLocalized(
  v: unknown,
  path: string,
  defaultLocale: string,
  maxLen: number,
  errors: string[],
): void {
  if (!isObject(v)) {
    errors.push(`${path}: must be an object of locale -> text`);
    return;
  }
  for (const [locale, text] of Object.entries(v)) {
    if (!LOCALE_RE.test(locale)) errors.push(`${path}.${locale}: invalid locale tag`);
    if (typeof text !== "string" || text.trim() === "") {
      errors.push(`${path}.${locale}: must be a non-empty string`);
    } else if (text.length > maxLen) {
      errors.push(`${path}.${locale}: longer than ${maxLen} characters`);
    }
  }
  if (!(defaultLocale in v)) errors.push(`${path}: missing default locale "${defaultLocale}"`);
}

function checkIcon(v: unknown, path: string, errors: string[]): void {
  if (typeof v !== "string" || v === "") {
    errors.push(`${path}: must be a non-empty string`);
    return;
  }
  if (v.startsWith("ipfs://")) return;
  if (!/^[A-Za-z0-9_./-]+$/.test(v) || v.startsWith("/") || v.split("/").includes("..")) {
    errors.push(`${path}: must be a relative path inside the bundle or an ipfs:// URI`);
  }
}

function checkStat(s: unknown, path: string, defaultLocale: string, errors: string[]): void {
  if (!isObject(s)) {
    errors.push(`${path}: must be an object`);
    return;
  }
  checkKeys(
    s,
    ["id", "type", "aggregation", "displayName", "defaultValue", "minValue", "maxValue", "maxChange", "incrementOnly"],
    path,
    errors,
  );
  if (typeof s.id !== "string" || !ID_RE.test(s.id)) errors.push(`${path}.id: must match ${ID_RE}`);
  if (s.type !== "int" && s.type !== "float") errors.push(`${path}.type: must be "int" or "float"`);
  if (!["sum", "max", "min", "latest"].includes(s.aggregation as string)) {
    errors.push(`${path}.aggregation: must be one of sum, max, min, latest`);
  }
  if (s.displayName !== undefined) checkLocalized(s.displayName, `${path}.displayName`, defaultLocale, MAX_NAME, errors);

  for (const k of ["defaultValue", "minValue", "maxValue", "maxChange"] as const) {
    const v = s[k];
    if (v === undefined) continue;
    if (!isFiniteNumber(v)) errors.push(`${path}.${k}: must be a finite number`);
    else if (s.type === "int" && !Number.isInteger(v)) errors.push(`${path}.${k}: must be an integer for an int stat`);
  }
  const { minValue, maxValue, defaultValue, maxChange } = s;
  if (isFiniteNumber(minValue) && isFiniteNumber(maxValue) && minValue > maxValue) {
    errors.push(`${path}: minValue must be <= maxValue`);
  }
  if (isFiniteNumber(defaultValue)) {
    if (isFiniteNumber(minValue) && defaultValue < minValue) errors.push(`${path}.defaultValue: below minValue`);
    if (isFiniteNumber(maxValue) && defaultValue > maxValue) errors.push(`${path}.defaultValue: above maxValue`);
  }
  if (maxChange !== undefined) {
    if (s.aggregation !== "sum") errors.push(`${path}.maxChange: only meaningful for "sum" stats`);
    else if (isFiniteNumber(maxChange) && maxChange <= 0) errors.push(`${path}.maxChange: must be > 0`);
  }
  if (s.incrementOnly !== undefined) {
    if (typeof s.incrementOnly !== "boolean") errors.push(`${path}.incrementOnly: must be a boolean`);
    else if (s.aggregation !== "sum") errors.push(`${path}.incrementOnly: only meaningful for "sum" stats`);
  }
}

function checkUnlock(u: unknown, path: string, stats: ReadonlyMap<string, Json>, errors: string[]): void {
  if (!isObject(u)) {
    errors.push(`${path}: must be an object`);
    return;
  }
  if (u.type === "direct") {
    checkKeys(u, ["type"], path, errors);
    return;
  }
  if (u.type !== "stat") {
    errors.push(`${path}.type: must be "direct" or "stat"`);
    return;
  }
  checkKeys(u, ["type", "thresholds"], path, errors);
  if (!Array.isArray(u.thresholds) || u.thresholds.length === 0) {
    errors.push(`${path}.thresholds: must be a non-empty array`);
    return;
  }
  const seen = new Set<string>();
  u.thresholds.forEach((t: unknown, i: number) => {
    const tp = `${path}.thresholds[${i}]`;
    if (!isObject(t)) {
      errors.push(`${tp}: must be an object`);
      return;
    }
    checkKeys(t, ["stat", "value"], tp, errors);
    if (!isFiniteNumber(t.value)) errors.push(`${tp}.value: must be a finite number`);
    if (typeof t.stat !== "string") {
      errors.push(`${tp}.stat: must be a string`);
      return;
    }
    if (seen.has(t.stat)) errors.push(`${tp}.stat: "${t.stat}" listed twice`);
    seen.add(t.stat);
    const stat = stats.get(t.stat);
    if (!stat) {
      errors.push(`${tp}.stat: unknown stat "${t.stat}"`);
      return;
    }
    // Same restriction as EOS: "latest" is not monotonic, so it cannot gate an unlock.
    if (stat.aggregation === "latest") errors.push(`${tp}.stat: "latest" stats cannot drive an unlock`);
    if (isFiniteNumber(t.value)) {
      if (stat.type === "int" && !Number.isInteger(t.value)) errors.push(`${tp}.value: must be an integer for an int stat`);
      if (isFiniteNumber(stat.minValue) && t.value < stat.minValue) errors.push(`${tp}.value: below the stat's minValue`);
      if (isFiniteNumber(stat.maxValue) && t.value > stat.maxValue) errors.push(`${tp}.value: above the stat's maxValue`);
    }
  });
}

function checkAchievement(
  a: unknown,
  path: string,
  defaultLocale: string,
  stats: ReadonlyMap<string, Json>,
  errors: string[],
): void {
  if (!isObject(a)) {
    errors.push(`${path}: must be an object`);
    return;
  }
  checkKeys(
    a,
    ["id", "name", "description", "lockedDescription", "hidden", "icon", "iconLocked", "unlock", "grade", "points", "order"],
    path,
    errors,
  );
  if (typeof a.id !== "string" || !ID_RE.test(a.id)) errors.push(`${path}.id: must match ${ID_RE}`);
  checkLocalized(a.name, `${path}.name`, defaultLocale, MAX_NAME, errors);
  checkLocalized(a.description, `${path}.description`, defaultLocale, MAX_DESCRIPTION, errors);
  if (a.lockedDescription !== undefined) {
    checkLocalized(a.lockedDescription, `${path}.lockedDescription`, defaultLocale, MAX_DESCRIPTION, errors);
  }
  if (a.hidden !== undefined && typeof a.hidden !== "boolean") errors.push(`${path}.hidden: must be a boolean`);
  checkIcon(a.icon, `${path}.icon`, errors);
  if (a.iconLocked !== undefined) checkIcon(a.iconLocked, `${path}.iconLocked`, errors);
  checkUnlock(a.unlock, `${path}.unlock`, stats, errors);
  if (a.grade !== undefined && !["bronze", "silver", "gold"].includes(a.grade as string)) {
    errors.push(`${path}.grade: must be bronze, silver or gold`);
  }
  if (a.points !== undefined && !(Number.isInteger(a.points) && (a.points as number) >= 0 && (a.points as number) <= MAX_POINTS)) {
    errors.push(`${path}.points: must be an integer in 0..${MAX_POINTS}`);
  }
  if (a.order !== undefined && !(Number.isInteger(a.order) && (a.order as number) >= 0)) {
    errors.push(`${path}.order: must be a non-negative integer`);
  }
}

export function validateManifest(json: unknown): ValidationResult {
  const errors: string[] = [];
  if (!isObject(json)) return { ok: false, errors: ["manifest: must be a JSON object"] };

  checkKeys(json, ["schemaVersion", "defaultLocale", "stats", "achievements"], "manifest", errors);
  if (json.schemaVersion !== ACHIEVEMENTS_SCHEMA_VERSION) {
    errors.push(`schemaVersion: must be ${ACHIEVEMENTS_SCHEMA_VERSION}`);
  }
  const defaultLocale = typeof json.defaultLocale === "string" ? json.defaultLocale : "";
  if (!LOCALE_RE.test(defaultLocale)) errors.push("defaultLocale: must be a BCP-47 tag such as \"fr\" or \"en-US\"");

  const stats = new Map<string, Json>();
  if (!Array.isArray(json.stats)) {
    errors.push("stats: must be an array (possibly empty)");
  } else {
    json.stats.forEach((s: unknown, i: number) => {
      checkStat(s, `stats[${i}]`, defaultLocale, errors);
      if (isObject(s) && typeof s.id === "string") {
        if (stats.has(s.id)) errors.push(`stats[${i}].id: duplicate "${s.id}"`);
        stats.set(s.id, s);
      }
    });
  }

  if (!Array.isArray(json.achievements)) {
    errors.push("achievements: must be an array");
  } else {
    const ids = new Set<string>();
    let totalPoints = 0;
    json.achievements.forEach((a: unknown, i: number) => {
      checkAchievement(a, `achievements[${i}]`, defaultLocale, stats, errors);
      if (!isObject(a)) return;
      if (typeof a.id === "string") {
        if (ids.has(a.id)) errors.push(`achievements[${i}].id: duplicate "${a.id}"`);
        ids.add(a.id);
      }
      if (isFiniteNumber(a.points)) totalPoints += a.points;
    });
    if (totalPoints > MAX_TOTAL_POINTS) errors.push(`achievements: points total ${totalPoints} exceeds ${MAX_TOTAL_POINTS}`);
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, errors: [], manifest: json as unknown as AchievementsManifest };
}

function thresholdMet(stat: StatDefinition, value: number, threshold: number): boolean {
  return stat.aggregation === "min" ? value <= threshold : value >= threshold;
}

/**
 * Stat-driven achievements whose thresholds are all met by `stats`.
 * A stat absent from `stats` was never reported and meets nothing (matters
 * for "min" stats, where a default of 0 would otherwise unlock instantly).
 * Direct-unlock achievements are never returned: only the game grants them.
 */
export function evaluateUnlocks(
  manifest: AchievementsManifest,
  stats: Readonly<Record<string, number>>,
  alreadyUnlocked: ReadonlySet<string> = new Set(),
): string[] {
  const defs = new Map(manifest.stats.map((s) => [s.id, s]));
  const unlocked: string[] = [];
  for (const a of manifest.achievements) {
    if (a.unlock.type !== "stat" || alreadyUnlocked.has(a.id)) continue;
    const met = a.unlock.thresholds.every((t) => {
      const def = defs.get(t.stat);
      const value = Object.hasOwn(stats, t.stat) ? stats[t.stat] : undefined;
      return def !== undefined && value !== undefined && Number.isFinite(value) && thresholdMet(def, value, t.value);
    });
    if (met) unlocked.push(a.id);
  }
  return unlocked;
}

/**
 * Server-side fold of one client-reported value into a stored stat (EOS-style
 * ingest: the client never sets the authoritative value). Returns the new value,
 * or an error string when the ingest violates the stat's declared guards.
 */
export function applyStatIngest(
  stat: StatDefinition,
  current: number | undefined,
  amount: number,
): { ok: true; value: number } | { ok: false; error: string } {
  if (!Number.isFinite(amount)) return { ok: false, error: `${stat.id}: non-finite amount` };
  if (stat.type === "int" && !Number.isInteger(amount)) return { ok: false, error: `${stat.id}: int stat got ${amount}` };

  let next: number;
  switch (stat.aggregation) {
    case "sum":
      if (stat.incrementOnly && amount < 0) return { ok: false, error: `${stat.id}: increment-only stat got ${amount}` };
      if (stat.maxChange !== undefined && Math.abs(amount) > stat.maxChange) {
        return { ok: false, error: `${stat.id}: change ${amount} exceeds maxChange ${stat.maxChange}` };
      }
      next = (current ?? stat.defaultValue ?? 0) + amount;
      break;
    case "max":
      next = current === undefined ? amount : Math.max(current, amount);
      break;
    case "min":
      next = current === undefined ? amount : Math.min(current, amount);
      break;
    case "latest":
      next = amount;
      break;
  }
  // Bounds apply to the resulting value (the running total, for sum).
  if (stat.minValue !== undefined && next < stat.minValue) return { ok: false, error: `${stat.id}: ${next} below minValue` };
  if (stat.maxValue !== undefined && next > stat.maxValue) return { ok: false, error: `${stat.id}: ${next} above maxValue` };
  return { ok: true, value: next };
}
