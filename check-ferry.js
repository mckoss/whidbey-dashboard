import fetch from 'node-fetch';

const f = await fetch('http://localhost:3000/api/ferry').then(r => r.json());
console.log('Ferry response type:', typeof f, Array.isArray(f) ? 'array' : '');
console.log('Ferry keys:', f && typeof f === 'object' ? Object.keys(f) : 'n/a');
console.log('First 500 chars:', JSON.stringify(f).slice(0, 500));
