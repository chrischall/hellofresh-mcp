import { describe, expect, it } from 'vitest';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  BUILTIN_PROFILES,
  DEFAULT_PROFILES_FILE,
  ProfileConfigError,
  createProfileStore,
  loadProfiles,
  profileLabel,
  profileSku,
  resolveProfile,
} from '../src/profiles.js';

const enoent = () => {
  throw Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' });
};

describe('built-in profiles', () => {
  it('are generic: a couple and a family', () => {
    expect(BUILTIN_PROFILES.map((p) => p.name)).toEqual(['couple', 'family']);
    expect(BUILTIN_PROFILES[0]).toEqual({
      name: 'couple',
      people: 2,
      meals: 2,
      premiumCapCents: 1000,
      adventurous: true,
      avoidRepeatWeeks: 4,
    });
    expect(BUILTIN_PROFILES[1]).toEqual({
      name: 'family',
      people: 4,
      meals: 2,
      kidFriendly: true,
      maxMinutes: 30,
      premiumCapCents: 500,
      avoidRepeatWeeks: 4,
    });
  });
});

describe('loadProfiles', () => {
  it('falls back to the built-ins when nothing is configured and the default file is absent', () => {
    const seen: string[] = [];
    const loaded = loadProfiles({ env: {}, readFile: (p) => (seen.push(p), enoent()) });
    expect(loaded.profiles).toEqual(BUILTIN_PROFILES);
    expect(loaded.source).toBe('built-in defaults');
    expect(seen).toEqual([join(homedir(), '.config/hellofresh-mcp/profiles.json')]);
    expect(DEFAULT_PROFILES_FILE).toBe('~/.config/hellofresh-mcp/profiles.json');
  });

  it('reads inline JSON from HELLOFRESH_PROFILES first, filling defaults', () => {
    const loaded = loadProfiles({
      env: {
        HELLOFRESH_PROFILES: JSON.stringify([{ name: 'solo', people: 2, premiumCapCents: 0, categories: ['Seafood'] }]),
        HELLOFRESH_PROFILES_FILE: '/never/read.json',
      },
      readFile: () => {
        throw new Error('must not read a file');
      },
    });
    expect(loaded.source).toBe('HELLOFRESH_PROFILES');
    expect(loaded.profiles).toEqual([
      { name: 'solo', people: 2, meals: 2, premiumCapCents: 0, categories: ['Seafood'], avoidRepeatWeeks: 4 },
    ]);
  });

  it('reads HELLOFRESH_PROFILES_FILE (with ~ expanded)', () => {
    const seen: string[] = [];
    const loaded = loadProfiles({
      env: { HELLOFRESH_PROFILES_FILE: '~/hf.json' },
      readFile: (p) => {
        seen.push(p);
        return JSON.stringify([{ name: 'big', label: 'Big crew', people: 6, meals: 3, premiumCapCents: 300, avoidRepeatWeeks: 2 }]);
      },
    });
    expect(seen).toEqual([join(homedir(), 'hf.json')]);
    expect(loaded.source).toBe('~/hf.json');
    expect(loaded.profiles[0]).toMatchObject({ name: 'big', label: 'Big crew', people: 6, meals: 3, avoidRepeatWeeks: 2 });
  });

  it('reads the default file when present', () => {
    const loaded = loadProfiles({ env: {}, readFile: () => '[{"name":"x","people":3,"premiumCapCents":100}]' });
    expect(loaded.source).toBe(DEFAULT_PROFILES_FILE);
    expect(loaded.profiles.map((p) => p.name)).toEqual(['x']);
  });

  it('a missing explicitly-configured file is a config error naming the variable and path', () => {
    expect(() => loadProfiles({ env: { HELLOFRESH_PROFILES_FILE: '/nope.json' }, readFile: enoent })).toThrow(
      /HELLOFRESH_PROFILES_FILE.*\/nope\.json.*ENOENT/,
    );
  });

  it('an unreadable default file (other than missing) is a config error', () => {
    const err = (() => {
      try {
        loadProfiles({
          env: {},
          readFile: () => {
            throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
          },
        });
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(ProfileConfigError);
    expect((err as Error).message).toMatch(/~\/\.config\/hellofresh-mcp\/profiles\.json.*EACCES/);
  });

  it('a non-Error read failure is still reported', () => {
    expect(() =>
      loadProfiles({
        env: { HELLOFRESH_PROFILES_FILE: '/x.json' },
        readFile: () => {
          throw 'disk on fire';
        },
      }),
    ).toThrow(/\/x\.json\): disk on fire/);
  });

  it('malformed JSON, a bad shape and duplicate names are config errors naming the source', () => {
    expect(() => loadProfiles({ env: { HELLOFRESH_PROFILES: '{nope' } })).toThrow(/HELLOFRESH_PROFILES.*not valid JSON/);
    expect(() => loadProfiles({ env: { HELLOFRESH_PROFILES: '[]' } })).toThrow(/HELLOFRESH_PROFILES/);
    expect(() =>
      loadProfiles({ env: { HELLOFRESH_PROFILES: '[{"name":"x","people":5,"premiumCapCents":0}]' } }),
    ).toThrow(/HELLOFRESH_PROFILES.*people/);
    expect(() =>
      loadProfiles({ env: { HELLOFRESH_PROFILES: '[{"name":"Bad Name","people":2,"premiumCapCents":0}]' } }),
    ).toThrow(/name/);
    expect(() =>
      loadProfiles({ env: { HELLOFRESH_PROFILES: '[{"name":"x","people":2,"premiumCapCents":0,"typo":1}]' } }),
    ).toThrow(/typo/);
    expect(() =>
      loadProfiles({
        env: { HELLOFRESH_PROFILES: '[{"name":"x","people":2,"premiumCapCents":0},{"name":"x","people":4,"premiumCapCents":0}]' },
      }),
    ).toThrow(/duplicate profile name "x"/);
    expect(() => loadProfiles({ env: {}, readFile: () => 'nope' })).toThrow(/profiles\.json.*not valid JSON/);
  });

  it('reads process.env and the real filesystem by default', () => {
    const saved = { a: process.env.HELLOFRESH_PROFILES, b: process.env.HELLOFRESH_PROFILES_FILE };
    process.env.HELLOFRESH_PROFILES = '[{"name":"env","people":2,"premiumCapCents":0}]';
    try {
      expect(loadProfiles().profiles[0]!.name).toBe('env');
      delete process.env.HELLOFRESH_PROFILES;
      process.env.HELLOFRESH_PROFILES_FILE = join(import.meta.dirname, 'fixtures', 'does-not-exist.json');
      expect(() => loadProfiles()).toThrow(/ENOENT/);
    } finally {
      for (const [k, v] of [['HELLOFRESH_PROFILES', saved.a], ['HELLOFRESH_PROFILES_FILE', saved.b]] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});

describe('createProfileStore', () => {
  it('loads once and caches the result', () => {
    let calls = 0;
    const store = createProfileStore(() => (calls++, { profiles: BUILTIN_PROFILES, source: 'built-in defaults' }));
    store();
    store();
    expect(calls).toBe(1);
  });

  it('caches a config error too, rethrowing it on every call', () => {
    let calls = 0;
    const store = createProfileStore(() => {
      calls++;
      throw new ProfileConfigError('bad');
    });
    expect(() => store()).toThrow('bad');
    expect(() => store()).toThrow('bad');
    expect(calls).toBe(1);
  });

  it('defaults to loadProfiles', () => {
    expect(createProfileStore()().profiles.length).toBeGreaterThan(0);
  });
});

describe('resolveProfile and helpers', () => {
  const loaded = { profiles: BUILTIN_PROFILES, source: 'built-in defaults' };

  it('finds a profile by name, case-insensitively', () => {
    expect(resolveProfile(loaded, 'Family').name).toBe('family');
  });

  it('an unknown name is an error listing the configured names', () => {
    expect(() => resolveProfile(loaded, 'nobody')).toThrow(/No profile "nobody".*couple, family/);
  });

  it('labels and SKUs', () => {
    expect(profileLabel(BUILTIN_PROFILES[1]!)).toBe('Family');
    expect(profileLabel({ ...BUILTIN_PROFILES[1]!, label: 'Crew' })).toBe('Crew');
    expect(profileSku(BUILTIN_PROFILES[1]!)).toBe('US-CBU-2-4-0');
    expect(profileSku(BUILTIN_PROFILES[1]!, 6)).toBe('US-CBU-2-6-0');
  });
});
