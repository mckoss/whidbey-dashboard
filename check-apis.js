import fetch from 'node-fetch';

const w = await fetch('http://localhost:3000/api/weather').then(r => r.json());
console.log('WEATHER keys:', Object.keys(w));
console.log('current:', JSON.stringify(w.current).slice(0, 300));
console.log('daily.time[0]:', w.daily?.time?.[0]);
console.log('');

const t = await fetch('http://localhost:3000/api/tides').then(r => r.json());
console.log('TIDES keys:', Object.keys(t));
console.log('first 300 chars:', JSON.stringify(t).slice(0, 300));
