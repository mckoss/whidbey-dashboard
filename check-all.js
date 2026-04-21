import fetch from 'node-fetch';

const BASE = 'http://localhost:3000';

const w = await fetch(`${BASE}/api/weather`).then(r => r.json());
console.log(`✓ Weather: ${w.current?.temperature_2m}°F, code ${w.current?.weather_code}, wind ${w.current?.wind_speed_10m}mph`);

const t = await fetch(`${BASE}/api/tides`).then(r => r.json());
const preds = t.predictions || [];
console.log(`✓ Tides: ${preds.length} predictions`);
preds.slice(0, 4).forEach(p => console.log(`  ${p.t} ${p.type === 'H' ? 'High' : 'Low '} ${p.v}ft`));

const f = await fetch(`${BASE}/api/ferry`).then(r => r.json());
const times = f.TerminalCombos?.[0]?.Times || [];
const now = Date.now();
const upcoming = times
  .map(s => { const ms = (s.DepartingTime||'').match(/\/Date\((\d+)/); return ms ? new Date(parseInt(ms[1])) : null; })
  .filter(t => t && t.getTime() > now)
  .slice(0, 5);
console.log(`✓ Ferry: ${times.length} sailings today, next ${upcoming.length} upcoming:`);
upcoming.forEach(t => console.log(`  ${t.toLocaleTimeString('en-US', {hour:'numeric',minute:'2-digit',hour12:true})}`));
