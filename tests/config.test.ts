import { describe, expect, it } from 'vitest';
import { DEFAULT_WS_PORT, readWsPort } from '../src/config.js';

describe('readWsPort', () => {
  it('defaults to the fleet-shared concentrator port', () => {
    expect(DEFAULT_WS_PORT).toBe(37_149);
    expect(readWsPort({})).toBe(37_149);
  });

  it('honours HELLOFRESH_WS_PORT', () => {
    expect(readWsPort({ HELLOFRESH_WS_PORT: '41000' })).toBe(41_000);
  });

  it('falls back on a junk or unsubstituted value', () => {
    expect(readWsPort({ HELLOFRESH_WS_PORT: 'nope' })).toBe(37_149);
    expect(readWsPort({ HELLOFRESH_WS_PORT: '${user_config.hellofresh_ws_port}' })).toBe(37_149);
  });

  it('reads process.env by default', () => {
    const saved = process.env.HELLOFRESH_WS_PORT;
    delete process.env.HELLOFRESH_WS_PORT;
    try {
      expect(readWsPort()).toBe(37_149);
    } finally {
      if (saved !== undefined) process.env.HELLOFRESH_WS_PORT = saved;
    }
  });
});
