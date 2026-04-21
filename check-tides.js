import fetch from 'node-fetch';

// Reproduce exactly what server.js does
const NOAA_STATION = '9445526';
const today = new Date();
const begin = today.toISOString().split('T')[0].replace(/-/g, '');
const end = new Date(today.getTime() + 3 * 86400000).toISOString().split('T')[0].replace(/-/g, '');

const url = `https://api.tidesandcurrents.noaa.gov/api/prod/datagetter` +
  `?begin_date=${begin}&end_date=${end}` +
  `&station=${NOAA_STATION}` +
  `&product=predictions&datum=MLLW&time_zone=lst_ldt` +
  `&interval=hilo&units=english&application=whidbey_dashboard&format=json`;

console.log('URL:', url);
const r = await fetch(url);
const d = await r.json();
console.log('Response:', JSON.stringify(d).slice(0, 300));
