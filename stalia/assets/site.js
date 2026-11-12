/*! Stalia — landing pages and guides: prices and contacts from config.js, live demo, small helpers. */
(function () {
  'use strict';
  var CFG = window.STALIA_CONFIG || {};
  var lang = (document.documentElement.lang || 'en').slice(0, 2);
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };

  $$('[data-year]').forEach(function (el) { el.textContent = String(new Date().getFullYear()); });

  // ---- prices: <span data-price="usd.monthly">$19</span>
  function fmt(n, loc) { try { return new Intl.NumberFormat(loc, { maximumFractionDigits: 0 }).format(n); } catch (e) { return String(n); } }
  $$('[data-price]').forEach(function (el) {
    var p = el.getAttribute('data-price').split('.'), v = CFG.pricing && CFG.pricing[p[0]] && CFG.pricing[p[0]][p[1]];
    if (v == null) return;
    el.textContent = p[0] === 'kzt' ? fmt(v, 'ru-RU') + ' ₸' : '$' + fmt(v, 'en-US');
  });

  // ---- contacts and checkout links
  var email = CFG.contactEmail || '';
  $$('[data-contact="email"]').forEach(function (el) { if (email) el.textContent = email; });
  $$('a[data-contact="mailto"]').forEach(function (el) { if (email) el.setAttribute('href', 'mailto:' + email); });
  $$('[data-contact="telegram"]').forEach(function (el) {
    if (CFG.telegram) { el.setAttribute('href', 'https://t.me/' + String(CFG.telegram).replace(/^@/, '')); el.hidden = false; }
  });
  $$('a[data-buy]').forEach(function (el) {
    var url = CFG.checkout && CFG.checkout[el.getAttribute('data-buy') + 'Url'];
    if (/^https:\/\//.test(url || '')) { el.setAttribute('href', url); el.setAttribute('target', '_blank'); el.setAttribute('rel', 'noopener'); }
    else el.setAttribute('href', '#contact');
  });
  $$('[data-copy]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var src = document.querySelector(btn.getAttribute('data-copy'));
      if (!src) return;
      var done = function () { var old = btn.textContent; btn.textContent = '✓'; setTimeout(function () { btn.textContent = old; }, 1400); };
      try { navigator.clipboard.writeText(src.textContent.trim()).then(done, function () { selectText(src); }); } catch (e) { selectText(src); }
    });
  });
  function selectText(node) { var r = document.createRange(); r.selectNodeContents(node); var s = window.getSelection(); s.removeAllRanges(); s.addRange(r); }

  // ---- live demo: the built-in example, computed by the real engine
  var demo = document.getElementById('demo-body');
  if (demo && window.StaliaEngine && window.StaliaModel && window.StaliaView) {
    try {
      var id = demo.getAttribute('data-example') || 'bulk';
      var ex = window.StaliaModel.examples(lang).filter(function (x) { return x.id === id; })[0];
      var res = window.StaliaEngine.compute(ex.calc);
      if (res.ok) {
        demo.innerHTML = window.StaliaView.summaryHTML(ex.calc, res, lang) +
          res.ports.map(function (p) { return window.StaliaView.timelineHTML(p, lang); }).join('');
      }
    } catch (e) { /* the static fallback stays */ }
  }

  // ---- time-line tooltips
  var tip = document.getElementById('tip');
  if (tip) {
    var show = function (seg) {
      tip.firstElementChild.textContent = seg.getAttribute('data-tv') || '';
      tip.lastElementChild.textContent = seg.getAttribute('data-tt') || '';
      tip.hidden = false;
      var r = seg.getBoundingClientRect(), tw = tip.offsetWidth, th = tip.offsetHeight;
      var x = Math.max(8, Math.min(r.left + r.width / 2 - tw / 2, window.innerWidth - tw - 8)), y = r.top - th - 8;
      if (y < 8) y = r.bottom + 8;
      tip.style.left = x + 'px'; tip.style.top = y + 'px';
    };
    document.addEventListener('pointerover', function (e) { var s = e.target.closest && e.target.closest('.seg'); if (s) show(s); });
    document.addEventListener('pointerout', function (e) { if (e.target.closest && e.target.closest('.seg')) tip.hidden = true; });
    document.addEventListener('focusin', function (e) { if (e.target.classList && e.target.classList.contains('seg')) show(e.target); });
    document.addEventListener('focusout', function (e) { if (e.target.classList && e.target.classList.contains('seg')) tip.hidden = true; });
    window.addEventListener('scroll', function () { tip.hidden = true; }, true);
  }
})();
