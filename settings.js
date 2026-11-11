/* settings.js — ayarlar (IndexedDB 'kv' içinde saklanır; token SAKLANMAZ) */
(function (g) {
  'use strict';
  const DEFAULTS = {
    leagueUrl: '',
    clientId: '',
    spreadsheetId: '',
    redManagers: [],
    blueManagers: [],
    matchday: 1,
    autoSync: true,
    autoCommit: false,
    minMatches: 3,
    countLive: false,
    redName: '',
    blueName: '',
    battleCompleted: false
  };

  async function load() {
    const r = await OSMDB.get('kv', 'settings');
    return Object.assign({}, DEFAULTS, r ? r.value : {});
  }
  const save = st => OSMDB.put('kv', { key: 'settings', value: st });

  const lines = s => String(s || '').split('\n').map(x => x.trim()).filter(Boolean);

  function toForm(st) {
    const $ = id => document.getElementById(id);
    $('s-leagueUrl').value = st.leagueUrl;
    $('s-clientId').value = st.clientId;
    $('s-sheetId').value = st.spreadsheetId;
    $('s-red').value = st.redManagers.join('\n');
    $('s-blue').value = st.blueManagers.join('\n');
    $('s-matchday').value = st.matchday;
    $('s-autoSync').checked = !!st.autoSync;
    $('s-autoCommit').checked = !!st.autoCommit;
    $('s-minMatches').value = st.minMatches == null ? 3 : st.minMatches;
    $('s-countLive').checked = !!st.countLive;
    $('s-redName').value = st.redName || '';
    $('s-blueName').value = st.blueName || '';
    $('s-completed').checked = !!st.battleCompleted;
  }

  function fromForm(st) {
    const $ = id => document.getElementById(id);
    const n = parseInt($('s-matchday').value, 10);
    return Object.assign({}, st, {
      leagueUrl: $('s-leagueUrl').value.trim(),
      clientId: $('s-clientId').value.trim(),
      spreadsheetId: $('s-sheetId').value.trim(),
      redManagers: lines($('s-red').value),
      blueManagers: lines($('s-blue').value),
      matchday: isNaN(n) || n < 1 ? 1 : n,
      autoSync: $('s-autoSync').checked,
      autoCommit: $('s-autoCommit').checked,
      minMatches: Math.max(0, parseInt($('s-minMatches').value, 10) || 0),
      countLive: $('s-countLive').checked,
      redName: $('s-redName').value.trim(),
      blueName: $('s-blueName').value.trim(),
      battleCompleted: $('s-completed').checked
    });
  }

  // Sheets ID'si tam adres olarak yapıştırıldıysa ID'yi ayıkla
  function cleanSheetId(v) {
    const m = String(v).match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
    return m ? m[1] : String(v).trim();
  }

  g.OSMSettings = { DEFAULTS, load, save, toForm, fromForm, cleanSheetId };
})(window);
