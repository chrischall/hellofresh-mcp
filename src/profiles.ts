// Planner profiles: named, reusable descriptions of who a week's box feeds and
// how to rank its menu. Loaded from local config so nothing about a particular
// household lives in this repo:
//
//   1. HELLOFRESH_PROFILES       — an inline JSON array;
//   2. HELLOFRESH_PROFILES_FILE  — a JSON file (default ~/.config/hellofresh-mcp/profiles.json,
//                                   used only when it exists);
//   3. the generic built-ins     — "couple" and "family".
//
// Parsed once per process. A malformed config never stops the server booting
// (deferred-config-error pattern): it surfaces as a clear tool error, naming
// the variable or file, the first time a planner tool needs it.

import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { McpToolError, expandPath, readEnvVar, type EnvSource } from '@chrischall/mcp-utils';

export const PROFILES_ENV = 'HELLOFRESH_PROFILES';
export const PROFILES_FILE_ENV = 'HELLOFRESH_PROFILES_FILE';
export const DEFAULT_PROFILES_FILE = '~/.config/hellofresh-mcp/profiles.json';

const profileSchema = z.strictObject({
  name: z
    .string()
    .regex(/^[a-z0-9][a-z0-9_-]*$/, 'name must be a lowercase slug (a-z, 0-9, - and _)')
    .max(40),
  label: z.string().trim().min(1).max(60).optional(),
  people: z.union([z.literal(2), z.literal(3), z.literal(4), z.literal(6)]),
  meals: z.number().int().min(2).max(6).default(2),
  categories: z.array(z.string().trim().min(1)).min(1).optional(),
  kidFriendly: z.boolean().optional(),
  maxMinutes: z.number().int().positive().optional(),
  premiumCapCents: z.number().int().min(0),
  adventurous: z.boolean().optional(),
  avoidRepeatWeeks: z.number().int().min(0).max(12).default(4),
});

const profilesSchema = z.array(profileSchema).min(1, 'at least one profile is required');

export type Profile = z.output<typeof profileSchema>;

export interface LoadedProfiles {
  profiles: Profile[];
  /** Where they came from: the env var name, the file path as configured, or `built-in defaults`. */
  source: string;
}

export const BUILTIN_PROFILES: Profile[] = [
  { name: 'couple', people: 2, meals: 2, premiumCapCents: 1000, adventurous: true, avoidRepeatWeeks: 4 },
  { name: 'family', people: 4, meals: 2, kidFriendly: true, maxMinutes: 30, premiumCapCents: 500, avoidRepeatWeeks: 4 },
];

export class ProfileConfigError extends McpToolError {
  constructor(message: string) {
    super(message, {
      hint:
        `Fix ${PROFILES_ENV} (an inline JSON array) or the ${PROFILES_FILE_ENV} file (default ${DEFAULT_PROFILES_FILE}): ` +
        'each profile needs name, people (2/3/4/6) and premiumCapCents. Restart the server after editing.',
    });
    this.name = 'ProfileConfigError';
  }
}

function parse(text: string, source: string): Profile[] {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new ProfileConfigError(`Planner profiles from ${source} are not valid JSON.`);
  }
  const result = profilesSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
    throw new ProfileConfigError(`Planner profiles from ${source} are invalid — ${issues}`);
  }
  const seen = new Set<string>();
  for (const p of result.data) {
    if (seen.has(p.name)) throw new ProfileConfigError(`Planner profiles from ${source} are invalid — duplicate profile name "${p.name}".`);
    seen.add(p.name);
  }
  return result.data;
}

export interface LoadOptions {
  env?: EnvSource;
  readFile?: (path: string) => string;
}

const isMissing = (e: unknown) => (e as { code?: unknown } | null)?.code === 'ENOENT';

/** Load the profiles (env → file → built-ins). Throws {@link ProfileConfigError} on a bad config. */
export function loadProfiles({ env = process.env, readFile = (p) => readFileSync(p, 'utf8') }: LoadOptions = {}): LoadedProfiles {
  const inline = readEnvVar(PROFILES_ENV, { env });
  if (inline !== undefined) return { profiles: parse(inline, PROFILES_ENV), source: PROFILES_ENV };

  const configured = readEnvVar(PROFILES_FILE_ENV, { env });
  const path = configured ?? DEFAULT_PROFILES_FILE;
  let text: string;
  try {
    text = readFile(expandPath(path));
  } catch (e) {
    if (configured === undefined && isMissing(e)) return { profiles: BUILTIN_PROFILES, source: 'built-in defaults' };
    const why = e instanceof Error ? e.message : String(e);
    const via = configured === undefined ? path : `${PROFILES_FILE_ENV} (${path})`;
    throw new ProfileConfigError(`Could not read planner profiles from ${via}: ${why}`);
  }
  return { profiles: parse(text, path), source: path };
}

/** A load-once accessor: the first call loads, later calls return (or rethrow) the same result. */
export function createProfileStore(load: () => LoadedProfiles = () => loadProfiles()): () => LoadedProfiles {
  let cached: { ok: true; value: LoadedProfiles } | { ok: false; error: unknown } | undefined;
  return () => {
    if (!cached) {
      try {
        cached = { ok: true, value: load() };
      } catch (error) {
        cached = { ok: false, error };
      }
    }
    if (!cached.ok) throw cached.error;
    return cached.value;
  };
}

/** The named profile; an unknown name is a tool error listing the configured ones. */
export function resolveProfile(loaded: LoadedProfiles, name: string): Profile {
  const wanted = name.trim().toLowerCase();
  const found = loaded.profiles.find((p) => p.name === wanted);
  if (!found) {
    throw new McpToolError(`No profile "${name}". Configured profiles: ${loaded.profiles.map((p) => p.name).join(', ')}.`, {
      hint: 'hf_list_profiles shows each profile and where they were loaded from.',
    });
  }
  return found;
}

/** The display label: the configured one, else the capitalised name. */
export const profileLabel = (p: Profile): string => p.label ?? p.name.charAt(0).toUpperCase() + p.name.slice(1);

/** The box SKU a profile's week needs (`people` overrides the profile's). */
export const profileSku = (p: Profile, people: number = p.people): string => `US-CBU-${p.meals}-${people}-0`;
