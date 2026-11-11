// Formatting shared by the pages of the catalogue (the launcher's custom benchmarks, the Bugs reference).

// text for HTML, attribute values included
export const esc = text => String(text ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// the library of a vendor of puffin-build, as people write it
const LIBRARY = { wolfssl: 'wolfSSL', openssl: 'OpenSSL', libressl: 'LibreSSL', boringssl: 'BoringSSL', libssh: 'libssh', wolfssh: 'wolfSSH' };
export const libraryName = vendor => LIBRARY[vendor] ?? vendor;
// the vendors of puffin-build, in the order the pages list them
export const VENDORS = Object.keys(LIBRARY);

// a duration in seconds, e.g. "42 s", "3 min 07 s", "2 h 05"; "—" when unknown
export const duration = s => {
  if (s === null || s === undefined || !Number.isFinite(Number(s))) return '—';
  if (Number(s) < 1) return '< 1 s';
  const t = Math.round(Number(s));
  return t < 60 ? `${t} s` : t < 3600 ? `${Math.floor(t / 60)} min ${String(t % 60).padStart(2, '0')} s`
    : `${Math.floor(t / 3600)} h ${String(Math.floor(t % 3600 / 60)).padStart(2, '0')}`;
};
