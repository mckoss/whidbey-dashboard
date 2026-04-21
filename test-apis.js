import fetch from 'node-fetch';

const BASE = 'http://localhost:3000';

async function test() {
  console.log('Testing weather...');
  const w = await fetch(`${BASE}/api/weather`).then(r => r.json());
  console.log(`  ✓ Weather: ${w.current?.temperature_2m}°F, ${w.daily?.time?.[0]}`);

  console.log('Testing tides...');
  const t = await fetch(`${BASE}/api/tides`).then(r => r.json());
  const preds = t.predictions || [];
  console.log(`  ✓ Tides: ${preds.length} predictions, next: ${preds[0]?.t} ${preds[0]?.type} ${preds[0]?.v}ft`);

  console.log('Testing ferry...');
  const f = await fetch(`${BASE}/api/ferry`).then(r => r.json());
  console.log(`  Ferry: ${f.error || JSON.stringify(f).slice(0, 80)}`);
}

test().catch(console.error);
