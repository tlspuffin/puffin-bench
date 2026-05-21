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
########################### User functions ###########################
######################################################################

# EmbedTextFile(<input_txt> <output_header> <varname_prefix>)
## Required parameters
### INPUT_TXT (in) : path to the source text file to embed
### OUTPUT_HEADER (out) : generates a C header file
###   VARPREFIX_data (out) : a NUL-terminated C string literal
###   VARPREFIX_size (out) : size of the C string literal (excluding the NULL)
function(EmbedTextFile INPUT_TXT OUTPUT_HEADER VARPREFIX)
  file(READ "${INPUT_TXT}" _raw_content)

  string(REPLACE "\\" "\\\\" _escaped_content "${_raw_content}")
  string(REPLACE "\"" "\\\"" _escaped_content "${_escaped_content}")
  string(REPLACE "\n" "\\n\"\n\"" _escaped_content "${_escaped_content}")

  file(WRITE "${OUTPUT_HEADER}"
    "/* Auto-generated from ${INPUT_TXT} */\n"
    "static const char ${VARPREFIX}_data[] = \"${_escaped_content}\";\n"
    "static const size_t ${VARPREFIX}_size = sizeof(${VARPREFIX}_data) - 1;\n"
  )
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

  add_custom_command(
    OUTPUT  "${OUTPUT_H}"
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
