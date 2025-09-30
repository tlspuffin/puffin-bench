#***********************************************\
#                                               *
#  project : Cmake Helper to find Library       *
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

EmbedTextFile("${INPUT_TXT}" "${OUTPUT_HEADER}" "${VARPREFIX}")