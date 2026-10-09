// Links to the services of this machine follow the address typed in the browser.
//
// Some links are written by the server side (job scripts, report pages, publish links) with the name the
// machine gives itself (e.g. cassis-calc.loria.fr) or with localhost. Opened from another address (a
// shorter alias, an SSH tunnel on localhost, …) they would leave it. Every link of the page whose host is
// a loopback address, or whose port is one of the services' ports, is rewritten to the host of the page
// when it is hovered, focused or clicked, so links added later are covered too.
// A page includes it once: <script type="module" src="…/board/hostlinks.js"></script> (or imports it).

const servicePorts = new Set(['10081', '10082', '10083', '10084']);
const loopbacks = new Set(['localhost', '127.0.0.1', '[::1]']);

// the URL with the host of the page, or null when it is not a link to this machine
export function LocalURL(href) {
  let url;
  try {
    url = new URL(href, window.location.href);
  } catch {
    return null;
  }
  if (!['http:', 'https:'].includes(url.protocol) || (url.hostname === window.location.hostname)) return null;
  if (!loopbacks.has(url.hostname) && !servicePorts.has(url.port)) return null;
  url.hostname = window.location.hostname;
  return url.href;
}

function Rewrite(event) {
  const link = event.target instanceof Element ? event.target.closest('a[href]') : null;
  if (!link) return;
  const local = LocalURL(link.getAttribute('href'));
  if (local) link.href = local;
}

for (const type of ['mouseover', 'focusin', 'click', 'auxclick', 'contextmenu']) {
  document.addEventListener(type, Rewrite, true);
}
