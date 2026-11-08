/* global process, fetch */
import { readFileSync } from 'node:fs';
const base = process.argv[2] || 'http://127.0.0.1:8790';
const expected = JSON.parse(readFileSync('/app/package.json', 'utf8')).version;
function check(ok, label) { if (!ok) throw new Error(label); }
let r = await fetch(base + '/');
check(r.status === 200, 'homepage HTTP ' + r.status);
const html = await r.text();
for (const path of [...html.matchAll(/(?:src|href)="(\/assets\/[^" ]+)"/g)].map(x => x[1])) {
  r = await fetch(base + path); check(r.status === 200, 'asset ' + path);
}
r = await fetch(base + '/api/info');
const info = await r.json();
check(info.version === expected && info.auth && info.ffmpeg && !info.loggedIn, 'app info');
r = await fetch(base + '/api/books'); check(r.status === 401, 'anonymous API');
r = await fetch(base + '/api/login', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ password: process.env.APP_PASSWORD }),
});
check(r.status === 200, 'login HTTP ' + r.status);
const cookie = r.headers.get('set-cookie');
check(cookie?.includes('HttpOnly'), 'HttpOnly cookie');
if (base.startsWith('https:')) check(cookie.includes('Secure'), 'Secure cookie');
for (const path of ['/api/books', '/api/settings', '/api/jobs', '/api/library/stats']) {
  r = await fetch(base + path, { headers: { cookie: cookie.split(';')[0] } });
  check(r.status === 200, 'authenticated ' + path); await r.json();
}
console.log(`OK ${base} version=${info.version}: assets, login, protected APIs, ffmpeg`);
