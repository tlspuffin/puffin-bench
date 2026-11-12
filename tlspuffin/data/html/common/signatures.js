// The stack part of a signature, one definition for every page and tool: the frames a crash is recognised by, the place
// of a known bug, whether a stack has it. Used by the strength of a signature verdict (objectives_page/bugs.js
// BugValidation, report_verdicts.js), by what the Bugs reference shows of a bug (its place, its witness's stack) and by
// its "bugs found so far" (which known bug a crash is). The rule is here only: change it here, every page follows.
// Nothing here imports anything: QuickJS reads it too (the tools' tree links ../common to this folder).

// The function of a frame: the simple C++ mangling "_Z<length><name>…" undone, the arguments dropped
// ("MemcmpInterceptorCommon(void*," and "_Z23MemcmpInterceptorCommonPvPFi…" are the same function)
export function FrameName(frame) {
  let name = String(frame ?? '').trim();
  const mangled = /^_Z(\d+)(.*)$/.exec(name);
  if (mangled) name = mangled[2].slice(0, Number(mangled[1]));
  // the arguments after a function name ("MemcmpInterceptorCommon(void*,"), not a leading "<(Head,Tail) as …>"
  return name.replace(/([\w>])\(.*$/, '$1').trim();
}

// frames of the sanitizer runtime, of the libc memory and string functions it intercepts, and of the fuzzer's own code
// (its harness, LibAFL, the Rust runtime): never the location of a bug
export const RUNTIME_FRAME = /Interceptor|^__interceptor_|^___interceptor_|^__asan|^__sanitizer|^__ubsan|^(memcmp|bcmp|memcpy|memmove|memset|memchr|strcmp|strncmp|strlen|strnlen|strcpy|strncpy|strcat|strchr|strstr)$|^puffin::fuzzer::|^<?libafl|^<?(std|core|alloc)::|^<\(Head,Tail\)|^<ST as libafl/;
// glibc's own variants of the memory and string functions (__memmove_avx_unaligned_erms: SDOS2 crashes in it, called by
// DoTls13ClientHello): never the place of a bug either
export const LIBC_VARIANT = /^__(mem|str|wmem|wcs)\w*$/;

// How many of a stack's first frames a signature looks at
export const SIGNATURE_DEPTH = 3;

// The frames of a stack a signature looks at: the first SIGNATURE_DEPTH outside the runtime, libc and glibc's variants
export function SignatureFrames(frames) {
  return (frames ?? []).map(FrameName).filter(name => name && !RUNTIME_FRAME.test(name) && !LIBC_VARIANT.test(name))
      .slice(0, SIGNATURE_DEPTH);
}

// The place of a known bug, the frames a crash of it is recognised by (rule R3, chosen 2026-11-12 from the stacks of every
// crash of cassis, why: the user guide, "The place of a bug"): the first SIGNATURE_DEPTH frames of its witness's stack, in
// order, when validation recorded it; else the catalogue's top frames; [] when neither is known
export function PlaceOf(topFrames, witnessFrames) {
  const witness = SignatureFrames(witnessFrames);
  if (witness.length) return witness;
  return (topFrames ?? []).map(FrameName).slice(0, SIGNATURE_DEPTH);
}

// Whether a crash's stack has a bug's place: its first frames a signature looks at are the place's, in order. The
// reports keep the first 3 frames of a stack (its replay's, the fuzzer's record), of which the runtime and glibc can take
// one: then the 2 left are compared (never fewer than 2, unless the place itself is a single frame)
export function HasPlace(place, frames) {
  const want = (place ?? []).map(FrameName), got = SignatureFrames(frames);
  const n = Math.min(want.length, got.length);
  return n > 0 && n >= Math.min(2, want.length) && want.slice(0, n).every((frame, i) => got[i] === frame);
}

// The rule in words, for the pages and the guide
export const PLACE_RULE = `a crash has a known bug's place when its first ${SIGNATURE_DEPTH} frames, outside the sanitizer runtime, libc's memory and string functions and the fuzzer, are the bug's, in order (2 when its record keeps only 2 of them): the first ${SIGNATURE_DEPTH} of the stack of its witness, else its top frames in the catalogue`;
