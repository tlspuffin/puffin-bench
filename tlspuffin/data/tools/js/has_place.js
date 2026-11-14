// has_place.js <place "A < B < C"> <frames "a < b < c">: exit 0 when a crash's frames have a known bug's place, 1 when
// not, 2 when it cannot tell (the pages' module missing beside the tools, an error): never "not the place" then.
// has_place.js --witness <witness's stack "a < b < …"> <frames>: the same with the place of that stack (PlaceOf: its first
// frames outside the runtime, libc and the fuzzer). The rule
// is common/signatures.js HasPlace, the one of every page and tool (rule R3: the crash's first frames outside the
// sanitizer runtime, libc and the fuzzer are the place's, in order); the job scripts ask it here (PR_common.sh HasPlace)
// with the bench's qjs: qjs --std -m <tools>/js/has_place.js <place> <frames>. The tools and the pages are installed side
// by side (<data>/tools/js and <data>/html/common), as in tlspuffin/data of the repository.
let HasPlace, PlaceOf;
try {
  ({ HasPlace, PlaceOf } = await import('../../html/common/signatures.js'));
} catch (error) {
  std.err.puts(`has_place.js: cannot load ../../html/common/signatures.js (${error})\n`);
  std.exit(2);
}
const frames = text => String(text ?? '').split(' < ').map(frame => frame.trim()).filter(Boolean);
let answer;
try {
  answer = scriptArgs[1] === '--witness' ? HasPlace(PlaceOf([], frames(scriptArgs[2])), frames(scriptArgs[3]))
      : HasPlace(frames(scriptArgs[1]), frames(scriptArgs[2]));
} catch (error) {
  std.err.puts(`has_place.js: ${error}\n`);
  std.exit(2);
}
std.exit(answer ? 0 : 1);
