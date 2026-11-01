// Ads Placement injector: renders enabled ad slots only.
// A slot renders its configured code ONLY when enabled AND non-empty;
// otherwise it renders nothing at all (no empty boxes, no placeholder text).
(function () {
  var rendered = false;
  function clear() {
    document.querySelectorAll('[data-ad-slot]').forEach(function (el) { el.remove(); });
  }
  function place(code, slot) {
    var div = document.createElement('div');
    div.setAttribute('data-ad-slot', slot);
    div.style.cssText = 'display:block;width:100%;text-align:center;overflow:hidden';
    div.innerHTML = code;
    return div;
  }
  function render(slots) {
    clear();
    var path = location.pathname;
    var main = document.querySelector('main') || document.body;
    if (!main) return;
    if (slots['home-top'] && path === '/') {
      main.insertBefore(place(slots['home-top'].code, 'home-top'), main.firstChild);
    }
    if (slots['home-between'] && path === '/') {
      var sections = main.querySelectorAll('section, div');
      if (sections.length > 1) sections[1].insertAdjacentElement('beforebegin', place(slots['home-between'].code, 'home-between'));
      else main.appendChild(place(slots['home-between'].code, 'home-between'));
    }
    if (slots['title-top'] && path.indexOf('/title/') === 0) {
      main.insertBefore(place(slots['title-top'].code, 'title-top'), main.firstChild);
    }
    if (slots['reader-top'] && path.indexOf('/chapter/') === 0) {
      main.insertBefore(place(slots['reader-top'].code, 'reader-top'), main.firstChild);
    }
    if (slots['reader-bottom'] && path.indexOf('/chapter/') === 0) {
      main.appendChild(place(slots['reader-bottom'].code, 'reader-bottom'));
    }
    rendered = true;
  }
  function load() {
    fetch('/api/ads', { credentials: 'same-origin' })
      .then(function (r) { return r.ok ? r.json() : { slots: {} }; })
      .then(function (d) { render(d.slots || {}); })
      .catch(function () { clear(); });
  }
  function schedule() { setTimeout(load, 900); }
  document.addEventListener('DOMContentLoaded', schedule);
  ['pushState', 'replaceState'].forEach(function (fn) {
    var orig = history[fn];
    history[fn] = function () { var r = orig.apply(this, arguments); clear(); schedule(); return r; };
  });
  window.addEventListener('popstate', function () { clear(); schedule(); });
  schedule();
})();
