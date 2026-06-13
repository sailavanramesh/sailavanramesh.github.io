/*************************************
 * Powerwall + Amber → Telegram (no server)
 * DAYLIGHT-ONLY, NO-SHEET, CASCADE + HYSTERESIS
 *
 * Cadence highlights:
 * - FiT ≤ 0 and SoC ≥ 98%  → 1 min checks
 * - FiT ≤ 0 and SoC ≥ 85%  → 2 min checks
 * - waiting_pos            → 1 min checks
 * - FiT > 0                → 30 / 15 / 10 / 5 min (by SoC)
 *
 * State machine (INTERNAL FiT = -Amber perKwh):
 *   idle        -> (SoC≥95 & fitCents≤0)      -> neg_window (silent)
 *   neg_window  -> (SoC≥98 & fitCents≤0)      -> 1× heads-up (one-shot)
 *   neg_window  -> (SoC=100 & fitCents≤0)     -> send 3 msgs -> waiting_pos
 *   waiting_pos -> (FiT positive confirmed*)  -> send 1 msg  -> idle
 *
 * * Positive confirmation (hysteresis):
 *   - immediate if FiT ≥ +0.15 c/kWh, OR
 *   - after 3 consecutive >0 readings.
 *
 * Script properties (required):
 *   TESLA_REFRESH_TOKEN, TESLA_SITE_ID, AMBER_API_TOKEN, AMBER_SITE_ID,
 *   TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
 *
 * Optional tuning (defaults shown):
 *   BATTERY_KWH=13.5, MAX_CHARGE_KW=5,
 *   SOC_HEADSUP_PCT=98, POS_CENTS_MIN=0.15, POS_CONSEC_MIN=3,
 *   TESLA_AUTH_HOST=https://auth.tesla.com,
 *   TESLA_OWNER_HOST=https://owner-api.teslamotors.com
 *************************************/

/*** ===== Helpers: Script Properties ===== ***/
function _SP() { return PropertiesService.getScriptProperties(); }
function _get(key, def) {
  const v = _SP().getProperty(key);
  return (v === null || v === undefined || v === '') ? def : v;
}
function _set(key, val) { _SP().setProperty(key, val); }
function _del(key) { _SP().deleteProperty(key); }

/*** ===== Quick sanity check ===== ***/
function verifyProps() {
  const keys = [
    'TESLA_REFRESH_TOKEN','TESLA_SITE_ID',
    'AMBER_API_TOKEN','AMBER_SITE_ID',
    'TELEGRAM_BOT_TOKEN','TELEGRAM_CHAT_ID',
    'BATTERY_KWH','MAX_CHARGE_KW',
    'SOC_HEADSUP_PCT','POS_CENTS_MIN','POS_CONSEC_MIN',
    'TESLA_AUTH_HOST','TESLA_OWNER_HOST'
  ];
  const out = {};
  keys.forEach(k => out[k] = (_get(k) ? (k.includes('TOKEN') ? '[set]' : _get(k)) : '(missing)'));
  console.log(JSON.stringify(out, null, 2));
}

/*** ===== One-off setter (optional) ===== ***/
function setScriptPropsOnce() {
  _SP().setProperties({
    TESLA_REFRESH_TOKEN: 'paste_refresh_token',
    TESLA_SITE_ID:       'paste_site_id',
    AMBER_API_TOKEN:     'paste_amber_token',
    AMBER_SITE_ID:       'paste_amber_site_id',
    TELEGRAM_BOT_TOKEN:  'paste_telegram_bot_token',
    TELEGRAM_CHAT_ID:    'paste_telegram_chat_id',
    BATTERY_KWH:         '13.5',
    MAX_CHARGE_KW:       '5',
    SOC_HEADSUP_PCT:     '98',
    POS_CENTS_MIN:       '0.15',
    POS_CONSEC_MIN:      '3',
    TESLA_AUTH_HOST:     'https://auth.tesla.com',
    TESLA_OWNER_HOST:    'https://owner-api.teslamotors.com'
  }, true);
  console.log('Script properties saved.');
}

/*** ===== Triggers (self-rescheduling) ===== ***/
function _deleteLogTriggers() {
  ScriptApp.getProjectTriggers().forEach(tr => {
    if (tr.getHandlerFunction() === 'logPowerwall') ScriptApp.deleteTrigger(tr);
  });
}
function _scheduleAt(dateObj) {
  const ms = Math.max(60 * 1000, dateObj.getTime() - Date.now()); // ≥ 1 minute
  _deleteLogTriggers();
  ScriptApp.newTrigger('logPowerwall').timeBased().after(ms).create();
  const when = dateObj.toString();
  _set('NEXT_RUN_AT_ISO', dateObj.toISOString());
  console.log('Next run at', when);
}
function _scheduleAfterMinutes(minutes) {
  const mins = Math.max(1, Math.floor(Number(minutes) || 5));
  const at = new Date(Date.now() + mins * 60 * 1000);
  _scheduleAt(at); // stores NEXT_RUN_AT_ISO + logs "Next run at ..."
}
function installTriggers() {
  _deleteLogTriggers();
  const at = _capToDaylight(1); // if night -> next sunrise; if day -> now+1min (capped by sunset)
  _scheduleAt(at);              // logs and stores NEXT_RUN_AT_ISO
}
function uninstallTriggers() {
  ScriptApp.getProjectTriggers().forEach(tr => ScriptApp.deleteTrigger(tr));
  console.log('All triggers removed.');
}
function showNextRun() {
  const iso = _get('NEXT_RUN_AT_ISO', '');
  if (!iso) { console.log('No NEXT_RUN_AT_ISO stored yet.'); return; }
  const local = Utilities.formatDate(new Date(iso), 'Australia/Melbourne', "EEE, dd MMM yyyy HH:mm:ss");
  console.log('Next logPowerwall scheduled at (local):', local, '| ISO:', iso);
}

/*** ===== Telegram ===== ***/
function _tgToken() { const t = _get('TELEGRAM_BOT_TOKEN'); if (!t) throw new Error('Missing TELEGRAM_BOT_TOKEN.'); return t; }
function _tgChat()  { const c = _get('TELEGRAM_CHAT_ID');   if (!c) throw new Error('Missing TELEGRAM_CHAT_ID.');  return c; }
function tgSend(text) {
  const url = 'https://api.telegram.org/bot' + _tgToken() + '/sendMessage';
  const resp = UrlFetchApp.fetch(url, {
    method: 'post',
    payload: { chat_id: _tgChat(), text: String(text) },
    muteHttpExceptions: true
  });
  if (resp.getResponseCode() >= 300) throw new Error('Telegram send failed: ' + resp.getContentText());
}
function testTelegram() { tgSend('✅ Telegram wired up.'); }

/*** ===== Generic timing + retries ===== ***/
function _nowMs(){ return Date.now(); }
// generic retry with exponential backoff
function _withRetries(fn, tries, baseMs){
  let lastErr;
  for (let i=0;i<tries;i++){
    try { return fn(); } catch(e){
      lastErr = e;
      const msg = (e && e.message) ? e.message : String(e);
      const isRate = /quota|bandwidth|rate.*limit|429/i.test(msg);
      const wait = (isRate ? 1.5 : 1) * (baseMs * Math.pow(2,i));
      console.warn(`Retry ${i+1}/${tries} after ${Math.round(wait)}ms due to: ${msg}`);
      Utilities.sleep(Math.min(wait, 15000)); // cap sleep inside Apps Script limits
    }
  }
  throw lastErr;
}

/*** ===== Tesla token cache ===== ***/
function _setCachedToken(tok, expiresSec){
  // expire 5 min early to be safe
  const skewMs = 5 * 60 * 1000;
  const until = _nowMs() + Math.max(30*1000, (Number(expiresSec)||0)*1000 - skewMs);
  _set('TESLA_ACCESS_TOKEN', tok);
  _set('TESLA_ACCESS_EXPIRES', String(until));
}
function _getCachedToken(){
  const tok = _get('TESLA_ACCESS_TOKEN','');
  const exp = Number(_get('TESLA_ACCESS_EXPIRES','0'));
  if (tok && exp && _nowMs() < exp) return tok;
  return '';
}

/*** ===== Tesla auth + live status ===== ***/
function _getAccessTokenViaRefresh_AuthV3() {
  const cached = _getCachedToken();
  if (cached) return cached;

  return _withRetries(() => {
    const authHost = _get('TESLA_FLEET_AUTH_HOST', 'https://fleet-auth.prd.vn.cloud.tesla.com');
    const clientId = _get('TESLA_CLIENT_ID');
    const refreshToken = _get('TESLA_REFRESH_TOKEN');

    if (!clientId) throw new Error('Missing TESLA_CLIENT_ID.');
    if (!refreshToken) throw new Error('Missing TESLA_REFRESH_TOKEN.');

    const resp = UrlFetchApp.fetch(authHost + '/oauth2/v3/token', {
      method: 'post',
      contentType: 'application/x-www-form-urlencoded',
      muteHttpExceptions: true,
      payload: {
        grant_type: 'refresh_token',
        client_id: clientId,
        refresh_token: refreshToken
      }
    });

    const body = resp.getContentText();

    if (resp.getResponseCode() >= 300) {
      throw new Error('Fleet token refresh failed (' + resp.getResponseCode() + '): ' + body);
    }

    const json = JSON.parse(body);

    if (!json.access_token) {
      throw new Error('No access_token returned: ' + body);
    }

    // Fleet refresh tokens rotate. Save the new one if returned.
    if (json.refresh_token) {
      _set('TESLA_REFRESH_TOKEN', json.refresh_token);
      console.log('TESLA_REFRESH_TOKEN updated from Fleet refresh response.');
    }

    _setCachedToken(json.access_token, json.expires_in || 3000);
    return json.access_token;
  }, 3, 800);
}
function _ownerApiLiveStatus(accessToken, siteId) {
  return _withRetries(() => {
    const API = _get('TESLA_FLEET_API_HOST', 'https://fleet-api.prd.na.vn.cloud.tesla.com');
    const url = API + '/api/1/energy_sites/' + encodeURIComponent(siteId) + '/live_status';

    const r = UrlFetchApp.fetch(url, {
      method: 'get',
      headers: { Authorization: 'Bearer ' + accessToken },
      muteHttpExceptions: true
    });

    if (r.getResponseCode() >= 300) {
      throw new Error('Fleet live_status failed (' + r.getResponseCode() + '): ' + r.getContentText());
    }

    return JSON.parse(r.getContentText());
  }, 2, 500);
}

/*** ===== Amber FiT (internal flipped cents) ===== ***/
function _amberProps() {
  const sp = _SP();
  return {
    token:  (sp.getProperty('AMBER_API_TOKEN') || '').trim(),
    siteId: (sp.getProperty('AMBER_SITE_ID')   || '').trim(),
  };
}
/** INTERNAL FiT (c/kWh) = -Amber perKwh */
function amberCurrentFeedInCents() {
  const { token, siteId } = _amberProps();
  if (!token || !siteId) throw new Error('Missing AMBER_API_TOKEN or AMBER_SITE_ID.');
  const url = `https://api.amber.com.au/v1/sites/${encodeURIComponent(siteId)}/prices/current`;
  const resp = UrlFetchApp.fetch(url, {
    method: 'get',
    muteHttpExceptions: true,
    headers: { Authorization: `Bearer ${token}` },
  });
  if (resp.getResponseCode() >= 300) {
    throw new Error(`Amber current price failed (${resp.getResponseCode()}): ${resp.getContentText()}`);
  }
  const intervals = JSON.parse(resp.getContentText());
  const feed = Array.isArray(intervals)
    ? intervals.find(i => (i.channelType || i.channel) === 'feedIn')
    : null;
  if (!feed) throw new Error('No feedIn interval in Amber response.');
  const perKwh = Number(feed.perKwh);
  if (!isFinite(perKwh)) throw new Error('feedIn.perKwh missing or not numeric.');
  return -perKwh; // flipped sign, still c/kWh
}

/*** ===== State (ScriptProperties) ===== ***/
// Phases: idle | neg_window | waiting_pos
function _alertProps() {
  const p = _SP();
  return {
    get phase()        { return p.getProperty('ALERT_PHASE') || 'idle'; },
    set phase(v)       { p.setProperty('ALERT_PHASE', v); },
    get paused()       { return p.getProperty('ALERT_PAUSED') === '1'; },
    pause()            { p.setProperty('ALERT_PAUSED', '1'); },
    resume()           { p.deleteProperty('ALERT_PAUSED'); },
    // 98% heads-up one-shot per negative window
    get headsup98()    { return p.getProperty('ALERT_98_SENT') || ''; },
    set headsup98(v)   { if (v) p.setProperty('ALERT_98_SENT', v); else p.deleteProperty('ALERT_98_SENT'); },
    // Positive-streak debounce while waiting_pos
    get posStreak()    { return Number(p.getProperty('POS_STREAK') || '0'); },
    set posStreak(n)   { if (n>0) p.setProperty('POS_STREAK', String(n)); else p.deleteProperty('POS_STREAK'); },
    // One-time alert latch for "export before full" in a negative window
    get preFullExportNotified() { return p.getProperty('PREFULL_EXPORT') || ''; },
    set preFullExportNotified(v){ if (v) p.setProperty('PREFULL_EXPORT', '1'); else p.deleteProperty('PREFULL_EXPORT'); },
  };
}
function pauseAlerts()     { _alertProps().pause(); }
function resumeAlerts()    { _alertProps().resume(); }
function resetAlertPhase() { const s=_alertProps(); s.phase='idle'; s.headsup98=''; s.posStreak=0; s.preFullExportNotified=''; }

/*** ===== Config helpers ===== ***/
function _socHeadsUpThreshold() {
  const v = Number(_get('SOC_HEADSUP_PCT', '98'));
  return (isFinite(v) && v >= 0 && v <= 100) ? v : 98;
}
function _posCentsMin() {
  const v = Number(_get('POS_CENTS_MIN','0.15')); // c/kWh
  return (isFinite(v) && v > 0) ? v : 0.15;
}
function _posConsecMin() {
  const v = Number(_get('POS_CONSEC_MIN','3'));
  return (isFinite(v) && v >= 1) ? v : 3;
}
function _numOrBlank(x){ return (x===null || x===undefined || Number.isNaN(Number(x))) ? '' : Number(x); }
function _kw(v){
  if (v===null || v===undefined) return null;
  const n = Number(v);
  if (Number.isNaN(n)) return null;
  return Math.abs(n) > 50 ? n/1000 : n; // watts → kW, else assume kW
}
function _pickFirstNumber(){ for (let i=0;i<arguments.length;i++){ const v=arguments[i]; const n=Number(v); if(v!==undefined && v!==null && !Number.isNaN(n)) return n; } return null; }
function _fmtCentsRaw(x) {
  if (typeof x !== 'number' || !isFinite(x)) return '';
  return (Math.abs(x) < 1) ? x.toPrecision(6) : x.toFixed(4);
}

/*** ===== Daylight window: Melbourne month-average table ===== ***/
const _MEL_TZ = 'Australia/Melbourne';
const _SUN_TABLE = [
  ['05:58','20:49'], // Jan
  ['06:28','20:23'], // Feb
  ['06:57','19:46'], // Mar
  ['07:21','18:03'], // Apr
  ['07:43','17:20'], // May
  ['07:36','17:08'], // Jun
  ['07:34','17:17'], // Jul
  ['07:04','17:45'], // Aug
  ['06:24','18:07'], // Sep
  ['06:44','19:29'], // Oct
  ['06:17','20:00'], // Nov
  ['05:56','20:29']  // Dec
];

function _hmToDateToday(hhmm) {
  const [h,m] = hhmm.split(':').map(Number);
  const d = new Date();
  d.setHours(h, m, 0, 0);
  const iso = Utilities.formatDate(d, _MEL_TZ, "yyyy-MM-dd'T'HH:mm:ss");
  return new Date(iso);
}
function _todaySunriseSunset() {
  const month = new Date().getMonth();
  const [sr, ss] = _SUN_TABLE[month];
  return { sunrise: _hmToDateToday(sr), sunset: _hmToDateToday(ss) };
}
function _isDaylightNow() {
  const { sunrise, sunset } = _todaySunriseSunset();
  const nowLocal = new Date(Utilities.formatDate(new Date(), _MEL_TZ, "yyyy-MM-dd'T'HH:mm:ss"));
  return nowLocal >= sunrise && nowLocal <= sunset;
}
function _nextDaylightStart() {
  const nowLocal = new Date(Utilities.formatDate(new Date(), _MEL_TZ, "yyyy-MM-dd'T'HH:mm:ss"));
  const { sunrise } = _todaySunriseSunset();
  if (nowLocal < sunrise) return sunrise;
  const tomorrow = new Date(nowLocal.getTime() + 24*60*60*1000);
  const [sr] = _SUN_TABLE[tomorrow.getMonth()];
  const t = new Date(tomorrow);
  t.setHours(Number(sr.split(':')[0]), Number(sr.split(':')[1]), 0, 0);
  const iso = Utilities.formatDate(t, _MEL_TZ, "yyyy-MM-dd'T'HH:mm:ss");
  return new Date(iso);
}
function _capToDaylight(nextMinutes) {
  if (!_isDaylightNow()) return _nextDaylightStart();
  const { sunset } = _todaySunriseSunset();
  const nowLocal = new Date(Utilities.formatDate(new Date(), _MEL_TZ, "yyyy-MM-dd'T'HH:mm:ss"));
  const desired = new Date(nowLocal.getTime() + Math.max(1, nextMinutes)*60*1000);
  return (desired <= sunset) ? desired : _nextDaylightStart();
}

/*** ===== Phase advancement (CASCADE + heads-up + hysteresis) ===== ***/
function _advancePhaseByFitAndSoc(S, fitCents, soc, opts) {
  const sendAlerts = !!(opts && opts.sendAlerts);
  const inNeg  = (typeof fitCents === 'number' && fitCents <= 0);
  const isPos  = (typeof fitCents === 'number' && fitCents > 0);
  const socNum = (typeof soc === 'number') ? soc : null;

  const headsUpPct   = _socHeadsUpThreshold();
  const wantHeadsUp  = (socNum !== null && socNum >= headsUpPct && inNeg);

  const POS_THRESH   = _posCentsMin();
  const POS_CONSEC   = _posConsecMin();
  let progressed = true;

  while (progressed) {
    progressed = false;

    switch (S.phase || 'idle') {
      case 'idle':
        if (socNum !== null && socNum >= 95 && inNeg) {
          S.phase = 'neg_window';
          S.preFullExportNotified = '';
          S.headsup98 = '';
          S.posStreak = 0;
          progressed = true;
        }
        break;

      case 'neg_window':
        // 98% heads-up (one-shot per negative window)
        if (wantHeadsUp && !S.headsup98) {
          if (sendAlerts) tgSend(`⚠️ SoC ${socNum.toFixed(0)}% • FiT(flipped) ${fitCents.toFixed(2)} c/kWh — almost full (${headsUpPct}%+)`);
          S.headsup98 = '1';
        }
        // If FiT flips positive, re-arm
        if (isPos) {
          S.phase = 'idle';
          S.preFullExportNotified = '';
          S.headsup98 = '';
          S.posStreak = 0;
          progressed = true;
          break;
        }
        // At 100% with negative FiT → send triple + wait for positive
        if (socNum !== null && socNum >= 100 && inNeg) {
          if (sendAlerts) {
            const msg = `⚡ SoC ${socNum.toFixed(0)}% • FiT(flipped) ${fitCents.toFixed(2)} c/kWh`;
            tgSend(msg); tgSend(msg); tgSend(msg);
          }
          S.phase = 'waiting_pos';
          S.posStreak = 0;
          progressed = true;
        }
        break;

      case 'waiting_pos':
        // If SoC drops below 100% while FiT is still negative -> back to neg_window and allow a fresh 98% heads-up
        if (inNeg && socNum !== null && socNum < 100) {
          S.phase = 'neg_window';
          S.posStreak = 0;
          S.headsup98 = '';
          S.preFullExportNotified = ''; // allow a fresh taper/export heads-up if it happens again
          progressed = true;
          break;
        }

        // Normal positive confirmation logic (hysteresis)
        if (isPos) {
          const strong = (typeof fitCents === 'number' && fitCents >= POS_THRESH);
          if (strong) {
            if (sendAlerts) tgSend(`✅ FiT now positive (≥ ${POS_THRESH.toFixed(2)} c/kWh): ${fitCents.toFixed(2)} — re-armed`);
            S.phase = 'idle';
            S.headsup98 = '';
            S.preFullExportNotified = '';
            S.posStreak = 0;
            progressed = true;
          } else {
            S.posStreak = (S.posStreak || 0) + 1;
            if (S.posStreak >= POS_CONSEC) {
              if (sendAlerts) tgSend(`✅ FiT positive (stable): ${fitCents.toFixed(2)} c/kWh — re-armed`);
              S.phase = 'idle';
              S.headsup98 = '';
              S.preFullExportNotified = '';
              S.posStreak = 0;
              progressed = true;
            }
          }
        } else {
          S.posStreak = 0;
        }
        break;
    }
  }
}

/*** ===== Next-interval estimator (85%→2m, 98%→1m, daylight-capped) ===== ***/
function _computeNextMinutes(soc, fitCents, phase) {
  const socNum = (typeof soc === 'number') ? soc : 50;
  const fitNum = (typeof fitCents === 'number') ? fitCents : 0;
  const headsUpPct = _socHeadsUpThreshold();

  // Tightest sampling while waiting for positive confirmation
  if (phase === 'waiting_pos') return 1;

  // If we previously detected taper/export before full, keep 1-min cadence while we're still 98–99% and FiT ≤ 0
  try {
    const S = _alertProps();
    if (S.preFullExportNotified && fitNum <= 0 && socNum >= 98 && socNum < 100) return 1;
  } catch(_) {}

  // FiT negative & very close to full → 1 min
  if (fitNum <= 0 && socNum >= headsUpPct) return 1; // ≥98%

  // FiT negative & getting close → 2 min from 85%
  if (fitNum <= 0 && socNum >= 85) return 2;

  // FiT positive: faster backoff (no hourly gaps)
  if (fitNum > 0) {
    if (socNum < 80) return 30;
    if (socNum < 90) return 15;
    if (socNum < 95) return 10;
    return 5;
  }

  // FiT negative otherwise: ETA-based with 15 min cap
  const cap = Number(_get('BATTERY_KWH', '13.5')) || 13.5;
  const maxKw = Number(_get('MAX_CHARGE_KW', '5')) || 5;
  const pctPerMin = (maxKw / cap) * 100 / 60;
  const deltaPct = Math.max(0, 100 - socNum);
  const estMins  = Math.max(1, Math.ceil(deltaPct / Math.max(0.01, pctPerMin)));
  const SAFETY   = 1;
  const next     = Math.max(1, estMins - SAFETY);
  return Math.min(next, 15);
}

/*** ===== Pre-full (98–99%) taper/export detector ===== ***/
function _detectPreFullExport(soc, fitCents, battKw, solarKw, homeKw, gridKw){
  const socNum  = (typeof soc === 'number') ? soc : null;
  const fitNeg  = (typeof fitCents === 'number' && fitCents <= 0);
  const gridExp = (typeof gridKw === 'number' && gridKw < -0.05); // export ~50W+
  const isTaper = (typeof battKw === 'number' && battKw > 0 && battKw < 0.6); // charging slowly
  const surplus = (typeof solarKw==='number' && typeof homeKw==='number' && typeof battKw==='number')
                   ? (solarKw - homeKw - Math.max(0, battKw)) : 0;
  return !!(socNum !== null && socNum >= 98 && socNum < 100 && fitNeg && (gridExp || surplus > 0.1 || isTaper));
}

/*** ===== Main scheduled task (self-rescheduling, daylight-controlled, ROBUST) ===== ***/
function logPowerwall() {
  try {
    if (!_isDaylightNow()) {
      const at = _nextDaylightStart();
      console.log('Nighttime; scheduling next daylight start:', at.toString());
      _scheduleAt(at);
      return;
    }

    const siteId = _get('TESLA_SITE_ID');
    if (!siteId) throw new Error('Missing TESLA_SITE_ID.');

    // 1) Tesla access token (cached)
    const accessToken = _getAccessTokenViaRefresh_AuthV3();

    // 2) Live status
    const data = _ownerApiLiveStatus(accessToken, siteId);

    // 3) Parse Tesla response
    const nowIso = new Date().toISOString();
    const body = data.response ? data.response : data;

    const soc     = _pickFirstNumber(body.battery_level, body.percentage_charged, body.state_of_charge);
    const battKw  = _pickFirstNumber(body.battery_power) / 1000 || _kw(body.battery_power) || _kw(body.battery);
    const solarKw = _pickFirstNumber(body.solar_power)   / 1000 || _kw(body.solar_power)  || _kw(body.solar);
    const gridKw  = _pickFirstNumber(body.grid_power)    / 1000 || _kw(body.grid_power)   || _kw(body.grid);
    const homeKw  = _pickFirstNumber(body.load_power)    / 1000 || _kw(body.load_power)   || _kw(body.load);
    const reserve = _pickFirstNumber(body.backup_reserve_percent, body.backup_reserve_level);

    // 4) Amber FiT (internal flipped)
    let fitCents = '';
    try { fitCents = amberCurrentFeedInCents(); } catch (_) { fitCents = ''; }

    // 5) Stateful alerts (CASCADE + HYSTERESIS)
    const S = _alertProps();
    let alertTag = '';
    if (!S.paused) {
      const beforePhase = S.phase;
      _advancePhaseByFitAndSoc(S, fitCents, soc, { sendAlerts: true });
      const afterPhase = S.phase;

      if (beforePhase !== afterPhase && afterPhase === 'waiting_pos') alertTag = 'telegram_triple';
      else if (beforePhase !== afterPhase && afterPhase === 'idle')   alertTag = 'rearmed';
      else if (S.headsup98)                                           alertTag = 'heads_up_sent';
    } else {
      alertTag = 'paused';
    }

    // 5b) Detect pre-full taper/export (98–99%) and send one-time heads-up per negative window
    if (!S.paused) {
      const preFull = _detectPreFullExport(soc, fitCents, battKw, solarKw, homeKw, gridKw);
      if (preFull && (S.phase === 'neg_window' || S.phase === 'waiting_pos') && !S.preFullExportNotified) {
        try {
          tgSend(
`ℹ️ Powerwall tapering/export before full
• SoC ${_numOrBlank(soc)}% (<100)
• Solar ${_numOrBlank(solarKw)} kW → Home ${_numOrBlank(homeKw)} kW → Batt ${_numOrBlank(battKw)} kW
• Grid ${_numOrBlank(gridKw)} kW (negative = export)
• FiT (flipped) ${_fmtCentsRaw(fitCents)} c/kWh`
          );
        } catch(_) {}
        S.preFullExportNotified = '1';
      }
      // If we're no longer near-full or FiT flipped positive, drop the latch to avoid forcing 1-min later
      if ((!preFull && (Number(soc) < 98 || Number(fitCents) > 0)) && S.preFullExportNotified) {
        S.preFullExportNotified = '';
      }
    }

    // 6) Console-only logging
    console.log(JSON.stringify({
      ts: nowIso,
      soc: _numOrBlank(soc),
      battKw: _numOrBlank(battKw),
      solarKw: _numOrBlank(solarKw),
      gridKw: _numOrBlank(gridKw),
      homeKw: _numOrBlank(homeKw),
      reserve: _numOrBlank(reserve),
      fitCents: _numOrBlank(fitCents), // internal flipped
      phase: _alertProps().phase,
      headsup98: !!_alertProps().headsup98,
      posStreak: _alertProps().posStreak || 0,
      preFullExport: !!_alertProps().preFullExportNotified,
      tag: alertTag
    }));

    // 7) Self-reschedule (then cap to daylight)
    const nextMins = _computeNextMinutes(soc, fitCents, _alertProps().phase);
    const at = _capToDaylight(nextMins);
    _scheduleAt(at);

  } catch (e) {
    const msg = (e && e.message) ? e.message : String(e);
    console.error('logPowerwall error:', msg);

    // Identify rate/bandwidth limits and back off a bit more aggressively
    const isRate = /quota|bandwidth|rate.*limit|429/i.test(msg);
    const backoffMin = isRate ? 10 : 5;

    // Optional: throttle Telegram error spam (notify at most once per 30 min)
    try {
      const last = Number(_get('LAST_ERR_TS','0'));
      if (_nowMs() - last > 30*60*1000) {
        tgSend(`⚠️ logPowerwall error: ${msg}\nBacking off ${backoffMin} min.`);
        _set('LAST_ERR_TS', String(_nowMs()));
      }
    } catch(_) {}

    _scheduleAfterMinutes(backoffMin);
  }
}

/*** ===== Utilities ===== ***/
function printEnergySiteId() {
  const token = _getAccessTokenViaRefresh_AuthV3();
  const OWNER = _get('TESLA_OWNER_HOST', 'https://owner-api.teslamotors.com');
  const r = UrlFetchApp.fetch(OWNER + '/api/1/products', {
    headers: { Authorization: 'Bearer ' + token },
    muteHttpExceptions: true
  });
  if (r.getResponseCode() >= 300) throw new Error('products failed ('+r.getResponseCode()+'): ' + r.getContentText());
  const items = (JSON.parse(r.getContentText()).response) || [];
  const ids = items.filter(x => x.energy_site_id).map(x => ({
    site_id: x.energy_site_id,
    type: x.resource_type || x.resource_type_name,
    site_name: x.site_name || x.vin || ''
  }));
  console.log(JSON.stringify(ids, null, 2));
}

/*** ===== On-demand status (manual run) ===== ***/
function sendStatusNow() {
  const siteId = _get('TESLA_SITE_ID');
  if (!siteId) throw new Error('Missing TESLA_SITE_ID.');
  const accessToken = _getAccessTokenViaRefresh_AuthV3();
  const data = _ownerApiLiveStatus(accessToken, siteId);

  const body = data.response ? data.response : data;
  const soc     = _pickFirstNumber(body.battery_level, body.percentage_charged, body.state_of_charge);
  const battKw  = _pickFirstNumber(body.battery_power) / 1000 || _kw(body.battery_power) || _kw(body.battery);
  const solarKw = _pickFirstNumber(body.solar_power)   / 1000 || _kw(body.solar_power)  || _kw(body.solar);
  const gridKw  = _pickFirstNumber(body.grid_power)    / 1000 || _kw(body.grid_power)   || _kw(body.grid);
  const homeKw  = _pickFirstNumber(body.load_power)    / 1000 || _kw(body.load_power)   || _kw(body.load);

  let fitCents = '';
  try { fitCents = amberCurrentFeedInCents(); } catch (_) {}

  const S = _alertProps();
  _advancePhaseByFitAndSoc(S, fitCents, soc, { sendAlerts: false });

  const phase = S.phase || 'idle';
  const paused = S.paused ? 'yes' : 'no';
  const amberRaw = (typeof fitCents === 'number') ? -fitCents : '';

  const lines = [
    'ℹ️ Current status',
    `• SoC: ${_numOrBlank(soc)} %`,
    `• FiT (internal flipped): ${_fmtCentsRaw(fitCents)} c/kWh`,
    `• FiT (Amber raw): ${_fmtCentsRaw(amberRaw)} c/kWh`,
    `• Solar kW: ${_numOrBlank(solarKw)} | Home kW: ${_numOrBlank(homeKw)}`,
    `• Grid kW: ${_numOrBlank(gridKw)} | Battery kW: ${_numOrBlank(battKw)}`,
    `• Phase: ${phase} | Paused: ${paused}`,
    `• Daylight now: ${_isDaylightNow() ? 'yes' : 'no'}`
  ];
  tgSend(lines.join('\n'));
}

function printTeslaTokenScopes() {
  const tok = _getAccessTokenViaRefresh_AuthV3();
  const parts = tok.split('.');
  if (parts.length < 2) throw new Error('Access token is not a JWT.');

  let payload = parts[1]
    .replace(/-/g, '+')
    .replace(/_/g, '/');

  while (payload.length % 4) payload += '=';

  const json = JSON.parse(
    Utilities.newBlob(
      Utilities.base64Decode(payload)
    ).getDataAsString()
  );

  console.log(JSON.stringify({
    aud: json.aud,
    iss: json.iss,
    scp: json.scp,
    scope: json.scope,
    exp: json.exp,
    sub: json.sub
  }, null, 2));
}

function buildTeslaFleetAuthUrl() {
  const clientId = _get('TESLA_CLIENT_ID');
  const redirectUri = _get('TESLA_REDIRECT_URI', 'http://localhost:3000/callback');

  if (!clientId) throw new Error('Missing TESLA_CLIENT_ID.');

  const state = Utilities.getUuid();
  const scope = 'openid offline_access energy_device_data';

  _set('TESLA_OAUTH_STATE', state);

  const params = {
    client_id: clientId,
    locale: 'en-US',
    prompt: 'login',
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: scope,
    state: state,
    prompt_missing_scopes: 'true',
    require_requested_scopes: 'true'
  };

  const qs = Object.keys(params)
    .map(k => encodeURIComponent(k) + '=' + encodeURIComponent(params[k]))
    .join('&');

  const url = 'https://auth.tesla.com/oauth2/v3/authorize?' + qs;

  console.log(url);
  return url;
}
function exchangeTeslaFleetCode(callbackUrlOrCode) {
  const clientId = _get('TESLA_CLIENT_ID');
  const clientSecret = _get('TESLA_CLIENT_SECRET');
  const redirectUri = _get('TESLA_REDIRECT_URI', 'http://localhost:3000/callback');
  const authHost = _get('TESLA_FLEET_AUTH_HOST', 'https://fleet-auth.prd.vn.cloud.tesla.com');
  const apiHost = _get('TESLA_FLEET_API_HOST', 'https://fleet-api.prd.na.vn.cloud.tesla.com');

  if (!clientId) throw new Error('Missing TESLA_CLIENT_ID.');
  if (!clientSecret) throw new Error('Missing TESLA_CLIENT_SECRET.');

  let code = String(callbackUrlOrCode || '').trim();

  // Accept either the full callback URL or just the code
  if (code.indexOf('code=') >= 0) {
    const m = code.match(/[?&]code=([^&]+)/);
    if (!m) throw new Error('Could not extract code from callback URL.');
    code = decodeURIComponent(m[1]);
  }

  if (!code) throw new Error('Paste the callback URL or code into exchangeTeslaFleetCode("...").');

  const resp = UrlFetchApp.fetch(authHost + '/oauth2/v3/token', {
    method: 'post',
    contentType: 'application/x-www-form-urlencoded',
    muteHttpExceptions: true,
    payload: {
      grant_type: 'authorization_code',
      client_id: clientId,
      client_secret: clientSecret,
      code: code,
      audience: apiHost,
      redirect_uri: redirectUri
    }
  });

  const body = resp.getContentText();
  if (resp.getResponseCode() >= 300) {
    throw new Error('Fleet code exchange failed (' + resp.getResponseCode() + '): ' + body);
  }

  const json = JSON.parse(body);

  if (!json.access_token) throw new Error('No access_token returned: ' + body);
  if (!json.refresh_token) throw new Error('No refresh_token returned. Did you request offline_access? ' + body);

  _set('TESLA_ACCESS_TOKEN', json.access_token);
  _set('TESLA_REFRESH_TOKEN', json.refresh_token);
  _setCachedToken(json.access_token, json.expires_in || 3000);

  console.log('Saved Fleet API access_token and refresh_token.');
  console.log('Now run printTeslaTokenScopes().');

  return 'OK';
}

function registerTeslaPartnerAccount() {
  const partnerToken = getTeslaPartnerToken();
  const API = _get('TESLA_FLEET_API_HOST', 'https://fleet-api.prd.na.vn.cloud.tesla.com');

  // This must match the domain configured in your Tesla Developer app.
  // Do NOT include https:// here.
  const domain = _get('TESLA_APP_DOMAIN');

  if (!domain) {
    throw new Error('Missing TESLA_APP_DOMAIN. Add it in Script Properties, e.g. yourdomain.com');
  }

  const url = API + '/api/1/partner_accounts';

  const r = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    headers: {
      Authorization: 'Bearer ' + partnerToken
    },
    payload: JSON.stringify({
      domain: domain
    }),
    muteHttpExceptions: true
  });

  console.log('Register response code: ' + r.getResponseCode());
  console.log(r.getContentText());

  if (r.getResponseCode() >= 300) {
    throw new Error('Partner account register failed (' + r.getResponseCode() + '): ' + r.getContentText());
  }

  return r.getContentText();
}
function getTeslaPartnerToken() {
  const clientId = _get('TESLA_CLIENT_ID');
  const clientSecret = _get('TESLA_CLIENT_SECRET');
  const authHost = _get('TESLA_FLEET_AUTH_HOST', 'https://fleet-auth.prd.vn.cloud.tesla.com');
  const apiHost = _get('TESLA_FLEET_API_HOST', 'https://fleet-api.prd.na.vn.cloud.tesla.com');

  if (!clientId) throw new Error('Missing TESLA_CLIENT_ID.');
  if (!clientSecret) throw new Error('Missing TESLA_CLIENT_SECRET.');

  const resp = UrlFetchApp.fetch(authHost + '/oauth2/v3/token', {
    method: 'post',
    contentType: 'application/x-www-form-urlencoded',
    muteHttpExceptions: true,
    payload: {
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
      audience: apiHost,
      scope: 'openid energy_device_data'
    }
  });

  const body = resp.getContentText();
  console.log('Partner token response code: ' + resp.getResponseCode());

  if (resp.getResponseCode() >= 300) {
    throw new Error('Partner token failed (' + resp.getResponseCode() + '): ' + body);
  }

  const json = JSON.parse(body);
  if (!json.access_token) throw new Error('No partner access_token returned: ' + body);

  return json.access_token;
}

function clearTeslaTokenCache() {
  _del('TESLA_ACCESS_TOKEN');
  _del('TESLA_ACCESS_EXPIRES');
  _del('LAST_ERR_TS');
  console.log('Tesla cached access token cleared.');
}

function runTeslaStatusTestAfterFleetUpdate() {
  clearTeslaTokenCache();
  sendStatusNow();
}

function runExchangeTeslaFleetCode() {
  exchangeTeslaFleetCode("PASTE FULL CALLBACK URL HERE");
}
