// Tombol sentuh + drag HUD pakai jari. Dijalankan setelah autoaim.js.
(() => {
  const old = document.getElementById('aim-touch-bar');
  if (old) old.remove();

  // Kirim "keypress" ke handler keydown milik autoaim.js
  const press = (key, code) => window.dispatchEvent(
    new KeyboardEvent('keydown', { key: key, code: code || ('Key' + key.toUpperCase()), bubbles: true })
  );

  const bar = document.createElement('div');
  bar.id = 'aim-touch-bar';
  bar.style.cssText =
    'position:fixed;left:50%;bottom:10px;transform:translateX(-50%);z-index:999998;' +
    'display:flex;flex-wrap:wrap;gap:6px;justify-content:center;max-width:96vw;' +
    'padding:6px;background:rgba(10,16,28,.88);border:1px solid rgba(0,255,170,.35);' +
    'border-radius:14px;touch-action:none;user-select:none;-webkit-user-select:none;';

  const mkBtn = (label, color, onDown, repeat) => {
    const b = document.createElement('button');
    b.textContent = label;
    b.style.cssText =
      'min-width:46px;height:40px;padding:0 10px;border-radius:10px;font-size:13px;font-weight:bold;' +
      'font-family:monospace,sans-serif;color:' + color + ';background:#162b3d;' +
      'border:1px solid ' + color + '88;touch-action:none;';
    let timer = null;
    const stop = () => { if (timer) { clearInterval(timer); timer = null; } };
    b.addEventListener('pointerdown', (e) => {
      e.preventDefault(); e.stopPropagation();
      onDown();
      if (repeat) { stop(); timer = setInterval(onDown, 60); }
    });
    ['pointerup', 'pointercancel', 'pointerleave'].forEach(ev => b.addEventListener(ev, stop));
    bar.appendChild(b);
    return b;
  };

  mkBtn('AUTO',  '#00ffaa', () => press('a'));
  mkBtn('TRICK', '#ff00ff', () => press('t'));
  mkBtn('BALL',  '#ffeb3b', () => press('b'));
  mkBtn('NEXT',  '#00ffff', () => press('n'));
  mkBtn('MODE',  '#b388ff', () => press('m'));
  mkBtn('◀',     '#ffffff', () => press('q'), true);
  mkBtn('▶',     '#ffffff', () => press('e'), true);
  mkBtn('🔥 SHOOT', '#ff5555', () => press('Enter', 'Enter'));
  mkBtn('HUD',   '#aaaaaa', () => press('h'));

  document.body.appendChild(bar);

  // Drag HUD pakai sentuhan (script utama cuma support mouse)
  const hud = document.getElementById('aim-hud-pc');
  if (hud) {
    hud.style.touchAction = 'none';
    let drag = false, sx = 0, sy = 0, il = 0, it = 0;
    hud.addEventListener('touchstart', (e) => {
      if (e.target.id === 'mode-pill-badge') return;
      const t = e.touches[0];
      drag = true; sx = t.clientX; sy = t.clientY;
      const r = hud.getBoundingClientRect();
      il = r.left; it = r.top;
      hud.style.right = 'auto';
      hud.style.left = il + 'px';
      hud.style.top = it + 'px';
    }, { passive: true });
    window.addEventListener('touchmove', (e) => {
      if (!drag) return;
      const t = e.touches[0];
      hud.style.left = (il + t.clientX - sx) + 'px';
      hud.style.top = (it + t.clientY - sy) + 'px';
    }, { passive: true });
    window.addEventListener('touchend', () => { drag = false; });
  }

  console.log('Touch controls aktif');
})();
