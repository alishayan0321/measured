/* MEASURED · turntable deck
 * Draws the record once, then rotates it with the audio clock and drives the
 * tonearm from real playback position using 9-inch arm geometry.            */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const audio = document.getElementById('audio');
  const cv = $('vd-disc');
  const spin = $('vd-spin');
  const arm = $('vd-arm');
  if (!cv || !spin || !arm || !audio) return;

  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ── arm geometry (units match the 300×300 viewBox) ─────────────── */
  const PIVOT = { x: 272, y: 44 };
  const CENTRE = { x: 150, y: 150 };
  const ARM_LEN = 152;
  const D_PC = Math.hypot(CENTRE.x - PIVOT.x, CENTRE.y - PIVOT.y);
  const A_PC = Math.atan2(CENTRE.y - PIVOT.y, CENTRE.x - PIVOT.x);
  const R_OUT = 126;   // first groove
  const R_IN = 60;     // run-out
  const R_REST = 197;  // parked on the arm rest
  const RPM = 33.3333;
  const DEG_PER_SEC = RPM * 6; // 200°/s

  /* stylus angle for a groove radius, by the cosine rule */
  function angleForRadius(r) {
    const cos = (ARM_LEN * ARM_LEN + D_PC * D_PC - r * r) / (2 * ARM_LEN * D_PC);
    const th = Math.acos(Math.min(1, Math.max(-1, cos)));
    return (A_PC + th) * 180 / Math.PI;
  }

  /* ── draw the record ────────────────────────────────────────────── */
  (function drawDisc() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const size = 520;
    cv.width = size * dpr;
    cv.height = size * dpr;
    const c = cv.getContext('2d');
    c.scale(dpr, dpr);

    const cx = size / 2;
    const cy = size / 2;
    const R = size / 2 - 2;

    // base: warm-black vinyl, lighter where the light hits
    const base = c.createRadialGradient(cx - R * 0.22, cy - R * 0.26, R * 0.08, cx, cy, R);
    base.addColorStop(0, '#232220');
    base.addColorStop(0.45, '#141413');
    base.addColorStop(1, '#0a0a09');
    c.beginPath();
    c.arc(cx, cy, R, 0, Math.PI * 2);
    c.fillStyle = base;
    c.fill();

    // deterministic pseudo-random so the pressing looks the same every load
    let seed = 0x9e3779b9;
    const rnd = () => {
      seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
      return ((seed >>> 0) / 4294967296);
    };

    const labelR = R * 0.335;
    const rIn = labelR + 4;
    const rOut = R - 8;

    // lead-in: sparse, wide-spaced grooves
    for (let r = rOut; r > rOut - 16; r -= 2.4) {
      c.beginPath();
      c.arc(cx, cy, r, 0, Math.PI * 2);
      c.strokeStyle = 'rgba(255,255,255,' + (0.035 + rnd() * 0.02).toFixed(3) + ')';
      c.lineWidth = 0.7;
      c.stroke();
    }

    // program area: banded "music", gaps between tracks
    let bandLeft = 0;
    let bandWidth = 34 + rnd() * 26;
    let energy = 0.05;
    for (let r = rOut - 17; r > rIn; r -= 1.15) {
      bandLeft += 1.15;
      if (bandLeft > bandWidth) {           // inter-track gap
        bandLeft = 0;
        bandWidth = 30 + rnd() * 30;
        energy = 0.028 + rnd() * 0.02;
        for (let g = 0; g < 5; g++) {       // quiet gap: darker, wide spacing
          const gr = r - g * 2.6;
          c.beginPath();
          c.arc(cx, cy, gr, 0, Math.PI * 2);
          c.strokeStyle = 'rgba(0,0,0,0.42)';
          c.lineWidth = 1.1;
          c.stroke();
        }
        r -= 12;
        continue;
      }
      // slow loudness drift plus per-groove jitter
      energy = 0.042 + 0.05 * (0.5 + 0.5 * Math.sin(r * 0.085)) + rnd() * 0.028;
      c.beginPath();
      c.arc(cx, cy, r, 0, Math.PI * 2);
      c.strokeStyle = 'rgba(255,255,255,' + energy.toFixed(3) + ')';
      c.lineWidth = 0.75;
      c.stroke();

      if (rnd() > 0.86) {                   // an occasional dark score line
        c.beginPath();
        c.arc(cx, cy, r + 0.45, 0, Math.PI * 2);
        c.strokeStyle = 'rgba(0,0,0,0.5)';
        c.lineWidth = 1;
        c.stroke();
      }
    }

    // run-out + locked groove
    for (let r = rIn; r > labelR + 1; r -= 0.85) {
      c.beginPath();
      c.arc(cx, cy, r, 0, Math.PI * 2);
      c.strokeStyle = 'rgba(255,255,255,0.05)';
      c.lineWidth = 0.7;
      c.stroke();
    }
    c.beginPath();
    c.arc(cx, cy, labelR + 2.6, 0, Math.PI * 2);
    c.strokeStyle = 'rgba(255,255,255,0.16)';
    c.lineWidth = 1.4;
    c.stroke();

    // dust specks, mostly near the rim
    for (let i = 0; i < 46; i++) {
      const a = rnd() * Math.PI * 2;
      const r = labelR + 10 + rnd() * (R - labelR - 18);
      const x = cx + Math.cos(a) * r;
      const y = cy + Math.sin(a) * r;
      c.beginPath();
      c.arc(x, y, 0.35 + rnd() * 0.5, 0, Math.PI * 2);
      c.fillStyle = 'rgba(255,255,255,' + (0.10 + rnd() * 0.16).toFixed(2) + ')';
      c.fill();
    }

    // chamfered edge
    c.beginPath();
    c.arc(cx, cy, R - 0.6, 0, Math.PI * 2);
    c.strokeStyle = 'rgba(255,255,255,0.10)';
    c.lineWidth = 1.4;
    c.stroke();
    c.beginPath();
    c.arc(cx, cy, R - 2.6, 0, Math.PI * 2);
    c.strokeStyle = 'rgba(0,0,0,0.55)';
    c.lineWidth = 1.6;
    c.stroke();
  })();

  /* ── state ──────────────────────────────────────────────────────── */
  let angle = 0;        // platter rotation, degrees
  let rate = 0;         // 0…1, eases the platter to a stop
  let last = performance.now();
  let armDeg = R_REST;
  let shownCat = '';
  let trackNo = 1;
  let total = 0;

  const fmt = (s) => {
    if (!isFinite(s) || s < 0) s = 0;
    const m = Math.floor(s / 60);
    const r = Math.floor(s % 60);
    return m + ':' + String(r).padStart(2, '0');
  };

  /* label follows the hero title/artist */
  function syncLabel() {
    const t = ($('title').textContent || '').trim();
    const a = ($('artist').textContent || '').trim();
    const cat = 'M—' + String(trackNo).padStart(3, '0') + (total ? ' / ' + String(total).padStart(3, '0') : '');

    const small = $('vd-cat');
    if (small && small.textContent !== 'M—' + String(trackNo).padStart(3, '0')) {
      small.textContent = 'M—' + String(trackNo).padStart(3, '0');
    }

    const set = (id, val) => {
      const el = $(id);
      if (el && el.textContent !== val) el.textContent = val;
    };
    set('vd-title', t || '—');
    set('vd-artist', a || '—');
    set('vd-title2', t || '—');
    set('vd-artist2', a || '—');
    set('vd-cat2', cat);

    const pad = String(trackNo).padStart(3, '0');
    const mtx = 'MEAS-' + pad + '-A1';
    const met = document.querySelector('.dlabel .dl-meta');
    if (met) met.textContent = 'SIDE A \u00b7 33\u2153 RPM \u00b7 2026';
    set('vd-matrix', mtx);
  }

  const obs = new MutationObserver(syncLabel);
  ['title', 'artist'].forEach((id) => {
    const n = $(id);
    if (n) obs.observe(n, { childList: true, characterData: true, subtree: true });
  });

  /* count + index come from the queue the page already renders */
  function syncQueueInfo() {
    const rows = document.querySelectorAll('#list [role="option"]');
    if (rows.length && rows.length !== total) {
      total = rows.length;
      const serial = $('vd-serial');
      if (serial) serial.textContent = 'SIDE A · BELT DRIVE · ' + total + ' TRACKS';
      syncLabel();
    }
    const active = document.querySelector('#list [role="option"][aria-selected="true"]')
      || document.querySelector('#list .row.on');
    if (active) {
      let n = 0;
      const nEl = active.querySelector('.n');
      if (nEl) n = parseInt(String(nEl.textContent).replace(/\D+/g, ''), 10) || 0;
      if (!n && active.id) {
        const m = /row-?(\d+)/.exec(active.id) || /(\d+)$/.exec(active.id);
        if (m) n = Number(m[1]);
      }
      if (n && n !== trackNo) { trackNo = n; syncLabel(); }
    }
  }

  /* ── frame loop ─────────────────────────────────────────────────── */
  let qTick = 0;
  function frame(now) {
    if ((qTick = (qTick + 1) % 15) === 0) syncQueueInfo();
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;

    const playing = !audio.paused && !audio.ended && audio.readyState > 2;
    const target = playing ? 1 : 0;
    // spin up a little slower than it stops — belt drive feel
    rate += (target - rate) * Math.min(1, dt * (playing ? 6.5 : 4.2));
    if (rate < 0.002) rate = playing ? rate : 0;

    if (!reduce) {
      angle += DEG_PER_SEC * dt * rate;
      if (angle > 360) angle -= 360;
      // a pressing is never perfectly centred
      const wx = Math.sin(angle * Math.PI / 180 * 0.5) * 0.35 * (rate > 0.15 ? 1 : 0);
      const wy = Math.cos(angle * Math.PI / 180 * 0.5) * 0.35 * (rate > 0.15 ? 1 : 0);
      spin.style.transform = 'translate(' + wx.toFixed(2) + 'px,' + wy.toFixed(2) + 'px) rotate(' + angle.toFixed(2) + 'deg)';
    }

    /* tonearm: park, or ride the groove at the real radius */
    const dur = audio.duration;
    const has = isFinite(dur) && dur > 0;
    let targetArm = R_REST;
    let radius = null;
    if (has) {
      const p = Math.min(1, Math.max(0, audio.currentTime / dur));
      radius = R_OUT + (R_IN - R_OUT) * p;
      targetArm = angleForRadius(radius);
      if (audio.ended) targetArm = R_REST;
    }
    // arm moves slowly and smoothly; never snaps
    armDeg += (targetArm - armDeg) * Math.min(1, dt * (has ? 3.4 : 2.4));
    arm.setAttribute('transform', 'translate(' + PIVOT.x + ' ' + PIVOT.y + ') rotate(' + armDeg.toFixed(3) + ')');

    /* readouts */
    const rpmEl = $('vd-rpm');
    if (rpmEl) rpmEl.textContent = (RPM * rate).toFixed(1);

    const rEl = $('vd-radius');
    if (rEl) {
      // real 12" record: 146 mm outer groove → 57 mm run-out
      rEl.innerHTML = radius == null ? '—' : Math.round(146 - (146 - 57) * ((R_OUT - radius) / (R_OUT - R_IN))) + ' <small>mm</small>';
    }

    const gfill = $('vd-gfill');
    const gcap = $('vd-gcap');
    if (gfill && gcap) {
      const p = has ? Math.min(100, (audio.currentTime / dur) * 100) : 0;
      gfill.style.width = p.toFixed(2) + '%';
      const txt = fmt(audio.currentTime) + ' / ' + fmt(has ? dur : 0);
      if (gcap.textContent !== txt) gcap.textContent = txt;
    }

    const lamp = $('vd-lamp');
    if (lamp) {
      const on = playing && rate > 0.5;
      if (lamp.classList.contains('on') !== on) lamp.classList.toggle('on', on);
    }

    const note = $('vd-note');
    if (note) {
      let msg;
      if (!has) msg = 'Idle — platter stopped. The arm sits on its rest until a track starts.';
      else if (playing) msg = 'On the groove · tracking ' + (radius ? (146 - (146 - 57) * ((R_OUT - radius) / (R_OUT - R_IN))).toFixed(1) : '—') + ' mm from centre.';
      else if (audio.ended) msg = 'Run-out — the arm has lifted and returned to its rest.';
      else msg = 'Cued — platter holding pace, arm resting on the groove.';
      if (note.textContent !== msg) note.textContent = msg;
    }

    requestAnimationFrame(frame);
  }

  /* keep the queue-derived numbering fresh without touching page code */
  syncQueueInfo();
  syncQueueInfo();
  syncLabel();
  setInterval(syncQueueInfo, 700);
    /* scrubbing hook: let the page drive the platter by hand, then hand the
     clock back to the audio element on release */
  window.__vinyl = {
    get angle() { return angle; },
    set angle(v) {
      angle = ((v % 360) + 360) % 360;
      const wx = Math.sin(angle * Math.PI / 180 * 0.5) * 0.35;
      const wy = Math.cos(angle * Math.PI / 180 * 0.5) * 0.35;
      spin.style.transform = 'translate(' + wx.toFixed(2) + 'px,' + wy.toFixed(2) + 'px) rotate(' + angle.toFixed(2) + 'deg)';
    },
  };

  requestAnimationFrame(frame);
})();