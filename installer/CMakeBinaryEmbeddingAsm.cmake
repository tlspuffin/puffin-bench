#***********************************************\
#                                               *
#  project : Cmake helper to embed large        *
#            binaries via .incbin               *
#                                               *
#  author : Olivier Demengeon                   *
#  created : 2026                               *
#                                               *
#***********************************************/

cmake_minimum_required(VERSION 3.16)

# The installer embeds whole statically-linked server binaries (tens of MB
# each). CMakeBinaryEmbedding.cmake's xxd -i turns that into a `{0x12, 0x34,
# ...}` C array, which for a binary this size becomes a source file 6-7x
# larger than the input and reliably OOM-kills the compiler front-end when
# several of them are built. The assembler's .incbin directive streams the
# file straight from disk instead, so compiling stays cheap regardless of size.
if(DEFINED BIN_FILE AND DEFINED OUTPUT_ASM AND DEFINED VARPREFIX)
  file(WRITE "${OUTPUT_ASM}"
    ".section .rodata\n"
    ".global ${VARPREFIX}_Start\n"
    ".global ${VARPREFIX}_End\n"
    ".balign 16\n"
    "${VARPREFIX}_Start:\n"
    ".incbin \"${BIN_FILE}\"\n"
    "${VARPREFIX}_End:\n"
    # Marks this object as not needing an executable stack. GCC-compiled
    # objects get this automatically; hand-assembled .s files don't, and if
    # even one object in the link is missing it, the linker falls back to
    # marking the whole binary's stack executable (a security weakening) and
    # warns about it.
    ".section .note.GNU-stack,\"\",@progbits\n"
  )
  return()
endif()

# EmbedBinaryTargetAsm(<cmake_target> <output.s> <varname_prefix>)
## Declares a build rule that generates an assembly file embedding the build
## output of <cmake_target> as a rodata blob, exposing it as two symbols:
##   VARPREFIX_start / VARPREFIX_end  (unsigned char[], one-past-the-end)
## Also (re)writes a companion header "<VARPREFIX>.h" next to OUTPUT_ASM
## declaring both symbols as extern, so callers can #include it instead of
## hand-declaring the symbols.
##
## Unlike the .s file, the header is written directly here at configure time
## rather than deferred to a build-time add_custom_command: its content is
## fully determined by VARPREFIX alone (it doesn't depend on the actual
## binary being embedded), so it doesn't need to wait on TARGET_NAME being
## built. This also means two calls that legitimately share a VARPREFIX
## (e.g. a plain and a -static build of the same target, exposing identical
## symbol names for the linker to resolve from whichever one is actually
## linked in) simply rewrite the same header with the same content instead of
## colliding as two build rules producing the same OUTPUT. And since the file
## already exists on disk before the generate step, callers can #include it
## without needing to add it to a target's sources for build-order reasons.
function(EmbedBinaryTargetAsm TARGET_NAME OUTPUT_ASM VARPREFIX)
  get_filename_component(_abs_output_asm "${OUTPUT_ASM}" ABSOLUTE)
  get_filename_component(_out_dir "${_abs_output_asm}" DIRECTORY)
  get_filename_component(_asm_name "${_abs_output_asm}" NAME_WLE)
  file(MAKE_DIRECTORY "${_out_dir}")

  # Only the generated filename is lowercased, not the whole path: _out_dir
  # comes from the caller (e.g. .../Desktop/...) and must be left as-is, or
  # file(WRITE) silently targets a path that doesn't exist on a case-sensitive
  # filesystem (lowercasing the whole string turned .../Desktop/... into
  # .../desktop/..., which doesn't exist on Linux).
  string(TOLOWER "${VARPREFIX}.h" _header_name_lc)
  set(_header_file "${_out_dir}/${_header_name_lc}")
  file(WRITE "${_header_file}"
    "#pragma once\n"
    "extern \"C\" {\n"
    "  extern unsigned char const ${VARPREFIX}_Start[];\n"
    "  extern unsigned char const ${VARPREFIX}_End[];\n"
    "}\n"
  )

  # Named after OUTPUT_ASM's own stem, not VARPREFIX: two calls can legitimately
  # share a VARPREFIX (see above), and OUTPUT_ASM is guaranteed unique since
  # CMake requires distinct OUTPUTs across custom commands. Naming this after
  # VARPREFIX instead would make both calls stage into the same .bin file,
  # which either races or makes the generator (e.g. Ninja) reject the build
  # for two rules producing the same byproduct.
  set(_bin_file "${_out_dir}/${_asm_name}.bin")
  add_custom_command(
    OUTPUT "${_abs_output_asm}"
    COMMAND ${CMAKE_COMMAND} -E copy "$<TARGET_FILE:${TARGET_NAME}>" "${_bin_file}"
    COMMAND ${CMAKE_COMMAND}
            -DBIN_FILE=${_bin_file}
            -DOUTPUT_ASM=${_abs_output_asm}
            -DVARPREFIX=${VARPREFIX}
            -P "${CMAKE_CURRENT_SOURCE_DIR}/CMakeBinaryEmbeddingAsm.cmake"
    DEPENDS ${TARGET_NAME}
    BYPRODUCTS "${_bin_file}"
    COMMENT "Embedding (asm) target '${TARGET_NAME}' -> ${_abs_output_asm}"
    VERBATIM
  )
endfunction()
