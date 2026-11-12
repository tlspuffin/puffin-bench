// has_place.js <place "A < B < C"> <frames "a < b < c">: exit 0 when a crash's frames have a known bug's place, 1 when
// not. The rule is common/signatures.js HasPlace, the one of every page and tool (rule R3: the crash's first frames
// outside the sanitizer runtime, libc and the fuzzer are the place's, in order); the job scripts ask it here
// (PR_common.sh HasPlace) with the bench's qjs: qjs --std -m <tools>/js/has_place.js <place> <frames>. The tools and the
// pages are installed side by side (<data>/tools/js and <data>/html/common), as in tlspuffin/data of the repository.
import { HasPlace } from '../../html/common/signatures.js';

const frames = text => String(text ?? '').split(' < ').map(frame => frame.trim()).filter(Boolean);
std.exit(HasPlace(frames(scriptArgs[1]), frames(scriptArgs[2])) ? 0 : 1);
