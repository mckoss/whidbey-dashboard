#!/bin/bash
# Test what scheduletoday returns after midnight
# Run via cron at 12:15 AM and 12:45 AM

KEY="eb41b0f7-35f6-4e06-9303-eec2e8bc5528"
LOG="/home/mckoss/projects/whidbey-dashboard/midnight-test.log"

echo "=== $(date -Iseconds) ===" >> "$LOG"

# scheduletoday (Clinton → Mukilteo)
echo "--- scheduletoday 5→14 ---" >> "$LOG"
curl -s "https://www.wsdot.wa.gov/ferries/api/schedule/rest/scheduletoday/5/14/false?apiaccesscode=$KEY" \
  | node -e "
const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
const t=d.TerminalCombos?.[0]?.Times||[];
console.log('Total sailings:', t.length);
t.slice(0,5).forEach(s=>{
  const ms=s.DepartingTime.match(/\/Date\((\d+)/)[1];
  console.log('  ',new Date(parseInt(ms)).toLocaleString('en-US',{timeZone:'America/Los_Angeles'}),'-',s.VesselName);
});
console.log('  ...');
t.slice(-3).forEach(s=>{
  const ms=s.DepartingTime.match(/\/Date\((\d+)/)[1];
  console.log('  ',new Date(parseInt(ms)).toLocaleString('en-US',{timeZone:'America/Los_Angeles'}),'-',s.VesselName);
});
" >> "$LOG" 2>&1

# Also try schedule/{date} for today
TODAY=$(TZ=America/Los_Angeles date +%Y-%m-%d)
echo "--- schedule/$TODAY 5→14 ---" >> "$LOG"
curl -s "https://www.wsdot.wa.gov/ferries/api/schedule/rest/schedule/$TODAY/5/14?apiaccesscode=$KEY" \
  | node -e "
const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
const t=d.TerminalCombos?.[0]?.Times||d.Times||[];
if(t.length){
  console.log('Total sailings:', t.length);
  t.slice(0,3).forEach(s=>{
    const ms=s.DepartingTime.match(/\/Date\((\d+)/)[1];
    console.log('  ',new Date(parseInt(ms)).toLocaleString('en-US',{timeZone:'America/Los_Angeles'}),'-',s.VesselName);
  });
  console.log('  ...');
  t.slice(-3).forEach(s=>{
    const ms=s.DepartingTime.match(/\/Date\((\d+)/)[1];
    console.log('  ',new Date(parseInt(ms)).toLocaleString('en-US',{timeZone:'America/Los_Angeles'}),'-',s.VesselName);
  });
} else {
  console.log('No TerminalCombos.Times found');
  console.log(JSON.stringify(d).slice(0,300));
}
" >> "$LOG" 2>&1

# Also try schedule for YESTERDAY (should be 2026-04-25 when running after midnight on 4/26)
YESTERDAY=$(TZ=America/Los_Angeles date -d 'yesterday' +%Y-%m-%d)
echo "--- schedule/$YESTERDAY (yesterday) 5→14 ---" >> "$LOG"
curl -s "https://www.wsdot.wa.gov/ferries/api/schedule/rest/schedule/$YESTERDAY/5/14?apiaccesscode=$KEY" \
  | node -e "
const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
const t=d.TerminalCombos?.[0]?.Times||[];
if(t.length){
  console.log('Total sailings:', t.length);
  t.slice(-5).forEach(s=>{
    const ms=s.DepartingTime.match(/\/Date\((\d+)/)[1];
    console.log('  ',new Date(parseInt(ms)).toLocaleString('en-US',{timeZone:'America/Los_Angeles'}),'-',s.VesselName);
  });
} else {
  console.log('Response:', JSON.stringify(d).slice(0,500));
}
" >> "$LOG" 2>&1

echo "" >> "$LOG"
