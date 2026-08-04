#***********************************************\
#                                               *
#  project : Cmake helper to embed files        *
#                                               *
#  author : Olivier Demengeon                   *
#  created : 2025                               *
#                                               *
#***********************************************/

cmake_minimum_required(VERSION 3.16)

######################################################################
########################### Pure functions #############################
######################################################################

# _EmbedTextHeaderPath(<output_file> <out_var>)
## Scriptable. If OUTPUT_FILE ends in ".c", sets OUT_VAR to the path of its
## companion header ("<name>.h" next to it); otherwise sets OUT_VAR to "".
## Mirrors CMakeBinaryEmbedding.cmake's _EmbedBinaryHeaderPath: single source
## of truth used both to actually write the header (EmbedTextFile) and to
## declare it as a build OUTPUT (EmbedTextFileScript), so the two stay in
## sync by construction.
function(_EmbedTextHeaderPath OUTPUT_FILE OUT_VAR)
  get_filename_component(_ext "${OUTPUT_FILE}" LAST_EXT)
  if(_ext STREQUAL ".c")
    get_filename_component(_out_dir "${OUTPUT_FILE}" DIRECTORY)
    get_filename_component(_header_name "${OUTPUT_FILE}" NAME_WLE)
    set(${OUT_VAR} "${_out_dir}/${_header_name}.h" PARENT_SCOPE)
  else()
    set(${OUT_VAR} "" PARENT_SCOPE)
  endif()
endfunction()

######################################################################
########################### User functions ###########################
######################################################################

# EmbedTextFile(<input_txt> <output_header> <varname_prefix>)
## Required parameters
### INPUT_TXT (in) : path to the source text file to embed
### OUTPUT_HEADER (out) : generates a C header file
###   VARPREFIX_data (out) : a NUL-terminated C string literal
###   VARPREFIX_size (out) : size of the C string literal (excluding the NULL)
## Behavior:
## - If OUTPUT_HEADER ends in ".c", the data is given external linkage (no
##   `static`) and a companion header "<name>.h" is (re)written next to it
##   declaring both symbols `extern`, so other translation units can use it
##   too -- same split as CMakeBinaryEmbedding.cmake's EmbedBinary. `static`
##   would be wrong here: it gives the symbols internal linkage, so no other
##   .c/.cxx could ever resolve them at link time regardless of any header.
## - Otherwise (OUTPUT_HEADER is a .h meant to be #include-d directly, e.g.
##   EmbedTextFileScript's documented usage), the data stays `static const`,
##   inlined in that one header, exactly as before.
function(EmbedTextFile INPUT_TXT OUTPUT_HEADER VARPREFIX)
  file(READ "${INPUT_TXT}" _raw_content)

  string(REPLACE "\\" "\\\\" _escaped_content "${_raw_content}")
  string(REPLACE "\"" "\\\"" _escaped_content "${_escaped_content}")
  string(REPLACE "\n" "\\n\"\n\"" _escaped_content "${_escaped_content}")

  _EmbedTextHeaderPath("${OUTPUT_HEADER}" _header_file)
  if(_header_file)
    file(WRITE "${OUTPUT_HEADER}"
      "/* Auto-generated from ${INPUT_TXT} */\n"
      "#include <stddef.h>\n"
      "const char ${VARPREFIX}_data[] = \"${_escaped_content}\";\n"
      "const size_t ${VARPREFIX}_size = sizeof(${VARPREFIX}_data) - 1;\n"
    )
    file(WRITE "${_header_file}"
      "#pragma once\n"
      "#include <stddef.h>\n"
      "extern const char ${VARPREFIX}_data[];\n"
      "extern const size_t ${VARPREFIX}_size;\n"
    )
  else()
    file(WRITE "${OUTPUT_HEADER}"
      "/* Auto-generated from ${INPUT_TXT} */\n"
      "static const char ${VARPREFIX}_data[] = \"${_escaped_content}\";\n"
      "static const size_t ${VARPREFIX}_size = sizeof(${VARPREFIX}_data) - 1;\n"
    )
  endif()
endfunction()

# EmbedTextFileScript(<input_txt> <output_header> <varname_prefix>)
##
## Declares a build rule that generates a C header file from a text file
## (e.g. a shell script). The header contains the file content encoded
## as a C string literal.
##
## Required parameters:
### INPUT_TEXT (in) : path to the source text file to embed
### OUTPUT_H (out) : path to the generated C header
###   - VARPREFIX_data (out) : a NUL-terminated C string literal
###   - VARPREFIX_size (out) : the size of the string literal (excluding the NUL)
### VARPREFIX (in) : prefix used to name the generated C symbols
##
## Behavior:
## - Declares a custom build rule with add_custom_command().
## - Automatically regenerates the header if INPUT_TXT changes.
## - Creates the output directory if necessary.
## - OUTPUT_HEADER is marked as a byproduct and can be used with target_sources().
##
## Example usage:
##   EmbedTextFileScript(${CMAKE_SOURCE_DIR}/scripts/myscript.sh
##                ${CMAKE_BINARY_DIR}/generated/myscript.h
##                myscript)
##
##   add_library(mylib ...)
##   target_sources(mylib PRIVATE ${CMAKE_BINARY_DIR}/generated/myscript.h)
##   target_include_directories(mylib PRIVATE ${CMAKE_BINARY_DIR}/generated)
##
# When invoked via cmake -P (script mode), INPUT_TXT/OUTPUT_HEADER/VARPREFIX
# are passed as -D variables — call EmbedTextFile directly here.
if(DEFINED INPUT_TXT AND DEFINED OUTPUT_HEADER AND DEFINED VARPREFIX)
  EmbedTextFile("${INPUT_TXT}" "${OUTPUT_HEADER}" "${VARPREFIX}")
  return()
endif()

function(EmbedTextFileScript INPUT_TEXT OUTPUT_H VARPREFIX)
  # Assure-toi que le dossier existe
  get_filename_component(_out_dir "${OUTPUT_H}" DIRECTORY)
  file(MAKE_DIRECTORY "${_out_dir}")

  # If OUTPUT_H is a ".c", EmbedTextFile also writes a companion header next
  # to it (see _EmbedTextHeaderPath) -- declare it as a second OUTPUT of the
  # same rule so anything #include-ing it gets a correct build dependency
  # instead of relying on an untracked side effect (same reasoning as
  # CMakeBinaryEmbedding.cmake's EmbedBinaryTarget).
  _EmbedTextHeaderPath("${OUTPUT_H}" _header_file)
  set(_extra_outputs)
  if(_header_file)
    list(APPEND _extra_outputs "${_header_file}")
  endif()

  add_custom_command(
    OUTPUT  "${OUTPUT_H}" ${_extra_outputs}
    COMMAND "${CMAKE_COMMAND}"
            -DINPUT_TXT=${INPUT_TEXT}
            -DOUTPUT_HEADER=${OUTPUT_H}
            -DVARPREFIX=${VARPREFIX}
            -P "${CMAKE_CURRENT_SOURCE_DIR}/CMakeTextEmbedding.cmake"
    DEPENDS "${INPUT_TEXT}" "${CMAKE_CURRENT_SOURCE_DIR}/CMakeTextEmbedding.cmake"
    COMMENT "Embedding ${INPUT_TEXT} -> ${OUTPUT_H}"
    VERBATIM
  )
endfunction()
