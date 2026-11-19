#!/bin/bash
# strip_aranges_test.sh: the binaries the job scripts build lose their .debug_aranges (PR_common.sh StripDebugAranges),
# so that ASan's llvm-symbolizer gives the replays' and validation's stacks their files and lines. On a program built
# here with one wrong entry in that index (a compile unit claiming every address, as libafl_targets' unit does in the
# builds of rustc 1.94):
#   - llvm-symbolizer finds no line for a function of another unit (the failure: "??:0:0", no file);
#   - after StripDebugAranges it gives the function's file and line; the program runs as before; a hard link of it
#     (cargo's target/release/<bin> and deps/<bin>-<hash>) is the same file, stripped too;
#   - a binary without the section is left as it is; one objcopy cannot rewrite too, said.
set -euo pipefail
here=$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )
cc=$( command -v gcc || command -v cc || true )
symbolizer=$( command -v llvm-symbolizer || ls /usr/lib/llvm-*/bin/llvm-symbolizer 2> /dev/null | sort -V | tail -1 || true )
for tool in "${cc}" "${symbolizer}" "$( command -v objcopy )" "$( command -v readelf )" "$( command -v as )"; do
  [ -n "${tool}" ] || { echo "SKIP: needs a C compiler, as, objcopy, readelf and llvm-symbolizer"; exit 0; }
done
work=$( mktemp -d ); trap 'rm -rf "${work}"' EXIT
fail=0
check() { if eval "$2"; then echo "ok   $1"; else echo "FAIL $1"; fail=1; fi; }
source <( sed -n '/^StripDebugAranges()/,/^}/p' "${here}/../PR_common.sh" )
cd "${work}"
printf 'int other(int x) { return x + 1; }\n' > other.c
printf '#include <stdlib.h>\nint helper(int x) {\n  return x * 2 + abs(x);\n}\nint main(int argc, char **argv) { return helper(argc) > 100; }\n' > prog.c
# one more set of .debug_aranges: the first compile unit (other.c) claims [0x0, 0x10000000)
cat > wrong.s <<'EOF'
	.section .note.GNU-stack,"",@progbits
	.section .debug_aranges,"",@progbits
	.long 0x2c
	.value 2
	.long 0
	.byte 8
	.byte 0
	.zero 4
	.quad 0
	.quad 0x10000000
	.quad 0
	.quad 0
EOF
"${cc}" -g -O0 -c other.c -o other.o && "${cc}" -g -O0 -c prog.c -o prog.o && as wrong.s -o wrong.o &&
  "${cc}" -g -no-pie wrong.o other.o prog.o -o prog 2> /dev/null || { echo "SKIP: cannot build the program"; exit 0; }
helper=$( printf '0x%x' $(( 0x$( nm prog | awk '$3 == "helper" { print $1 }' ) + 8 )) )
where() { "${symbolizer}" --obj="$1" "${helper}" | sed -n 2p; }
check 'with the wrong entry, llvm-symbolizer has no line for helper (the failure)' '[[ "$( where prog )" != *prog.c:* ]]'
ln prog deps-prog
command cp -f prog unstripped
out=$( StripDebugAranges "${work}/prog" )
check 'StripDebugAranges: the section removed, said' '! readelf -S -W prog | grep -q "\.debug_aranges" && grep -q "without .debug_aranges" <<< "${out}"'
check 'its hard link is the same file, without the section too' '[ prog -ef deps-prog ] && ! readelf -S -W deps-prog | grep -q "\.debug_aranges"'
check 'llvm-symbolizer then gives helper its file and line (prog.c:2)' '[[ "$( where prog )" == */prog.c:2:* ]]'
check 'the program runs as before' './prog; a=$?; ./unstripped; [ "${a}" -eq "$?" ]'
sum=$( sha256sum prog )
out=$( StripDebugAranges "${work}/prog" )
check 'a binary without the section: left as it is, nothing said' '[ "$( sha256sum prog )" == "${sum}" ] && [ -z "${out}" ]'
command cp -f unstripped broken; sum=$( sha256sum broken )
out=$( objcopy() { return 1; }; StripDebugAranges "${work}/broken" 2>&1 )
check 'objcopy failing: the binary left as it was built, said' '[ "$( sha256sum broken )" == "${sum}" ] && grep -q "kept as built" <<< "${out}" && [ -z "$( ls broken.* 2> /dev/null )" ]'
exit "${fail}"
