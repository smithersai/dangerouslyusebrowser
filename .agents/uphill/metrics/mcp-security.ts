import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { emit, ROOT } from './_lib.ts';

// 1. Loopback default + non-loopback token requirement + timingSafeEqual
const httpSrc = existsSync(join(ROOT, 'src/http.ts')) ? readFileSync(join(ROOT, 'src/http.ts'), 'utf8') : '';
const authSrc = existsSync(join(ROOT, 'src/auth.ts')) ? readFileSync(join(ROOT, 'src/auth.ts'), 'utf8') : '';
const combinedAuth = `${httpSrc}\n${authSrc}`;

const hasLoopback = httpSrc.includes("'127.0.0.1'") && httpSrc.includes('isLoopback');
const hasTimingSafe = combinedAuth.includes('timingSafeEqual');
const hasOriginCheck = httpSrc.includes('Origin not allowed') && httpSrc.includes('Host not allowed');
emit('loopback-and-timing-safe', hasLoopback && hasTimingSafe && hasOriginCheck ? 'pass' : 'fail', {
  item: 'http-mcp-boundary',
  note: !hasLoopback
    ? 'Missing loopback default'
    : !hasTimingSafe
      ? 'Missing timingSafeEqual token verification'
      : !hasOriginCheck
        ? 'Missing Host/Origin boundary check'
        : undefined,
});

// 2. One-time sandbox/agent authentication tokens
const hasOneTimeTokens =
  existsSync(join(ROOT, 'src/auth.ts')) &&
  authSrc.includes('mintOneTimeToken') &&
  authSrc.includes('redeemOneTimeToken') &&
  authSrc.includes('sha256') &&
  httpSrc.includes('/auth/exchange');
emit('one-time-sandbox-auth', hasOneTimeTokens ? 'pass' : 'fail', {
  item: 'sandbox-ott',
  note: hasOneTimeTokens ? undefined : 'Implement single-use one-time sandbox auth tokens in src/auth.ts and src/http.ts',
});

// 3. Protected factory paths and maintainer trust policy
const factoryPath = join(ROOT, '.smithers/FACTORY.ts');
const factorySrc = existsSync(factoryPath) ? readFileSync(factoryPath, 'utf8') : '';
const hasProtected =
  factorySrc.includes('protectedPaths') &&
  factorySrc.includes('maintainers') &&
  factorySrc.includes('chromium/patches') &&
  factorySrc.includes('.smithers');
emit('protected-factory-paths', hasProtected ? 'pass' : 'fail', {
  item: '.smithers/FACTORY.ts',
  note: hasProtected ? undefined : 'Declare maintainers and protectedPaths in .smithers/FACTORY.ts',
});

// 4. Untrusted vs trusted CI cache isolation
const ciPath = join(ROOT, '.github/workflows/ci.yml');
const ciSrc = existsSync(ciPath) ? readFileSync(ciPath, 'utf8') : '';
const hasUntrustedIsolation =
  ciSrc.includes('SMITHERS_CACHE_READ_TOKEN') &&
  ciSrc.includes('SMITHERS_CACHE_WRITE_TOKEN') &&
  (ciSrc.includes('pull_request_target') === false) &&
  /if:.*(?:push|main|trusted)/i.test(ciSrc);
emit('untrusted-cache-isolation', hasUntrustedIsolation ? 'pass' : 'fail', {
  item: '.github/workflows/ci.yml',
  note: hasUntrustedIsolation
    ? undefined
    : 'Separate read-only cache access for untrusted PRs from write access on trusted maintainer/main runs',
});
