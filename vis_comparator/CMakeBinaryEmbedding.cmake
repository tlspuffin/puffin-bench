#***********************************************\
#                                               *
#  project : Cmake helper to embed files        *
#                                               *
#  author : Olivier Demengeon                   *
#  created : 2026                               *
#                                               *
#***********************************************/

cmake_minimum_required(VERSION 3.21) # file(COPY_FILE ...) requires 3.21

find_program(XXD xxd REQUIRED)

######################################################################
########################### Pure functions #############################
######################################################################

# _EmbedBinaryHeaderPath(<output_file> <out_var>)
## Scriptable. If OUTPUT_FILE ends in ".c", sets OUT_VAR to the path of its
## companion header ("<name>.h" next to it); otherwise sets OUT_VAR to "".
## Single source of truth for this rule, used both to actually write the
## header (EmbedBinary) and to declare it as a build OUTPUT (EmbedBinaryTarget/
## EmbedBinaryFile), so the two stay in sync by construction.
##
## IMPORTANT for callers who #include the generated header: declaring it as a
## build OUTPUT is not enough to make another target wait for it. A #include
## is not a dependency CMake knows about until the file has been compiled once
## (compiler-generated depfile) — on a clean/parallel build that hasn't
## happened yet. Whoever #includes "<name>.h" from a .cxx in some target MUST
## also add that header's path to that target's sources (same pattern already
## used for the CMakeTextEmbedding.cmake headers in SCHEDULER_SRC, e.g.
## executor_sh.h), or wrap the generating custom command in a custom target and
## add_dependencies() it explicitly. Without one of these, expect intermittent
## "No such file or directory" on clean/parallel builds.
function(_EmbedBinaryHeaderPath OUTPUT_FILE OUT_VAR)
  get_filename_component(_ext "${OUTPUT_FILE}" LAST_EXT)
  if(_ext STREQUAL ".c")
    get_filename_component(_out_dir "${OUTPUT_FILE}" DIRECTORY)
    get_filename_component(_header_name "${OUTPUT_FILE}" NAME_WLE)
    set(${OUT_VAR} "${_out_dir}/${_header_name}.h" PARENT_SCOPE)
  else()
    set(${OUT_VAR} "" PARENT_SCOPE)
  endif()
endfunction()

# EmbedBinary(<input_file> <output_file> <varname_prefix> <work_dir>)
## Scriptable: only uses commands available in cmake -P script mode
## (file(), execute_process(), no add_custom_command/target references),
## so it can be called both from the configure-time functions below and
## from this same file re-invoked as a build-time script (see the
## self-dispatch block further down).
##
## Does the actual work: (re)create the destination directory, stage the
## input file under WORK_DIR named VARPREFIX (xxd -i derives its C
## identifier from that file name), run xxd -i, clean up, and — if
## OUTPUT_FILE ends in ".c" — (re)generate a companion header "<name>.h"
## declaring the two produced symbols as extern.
function(EmbedBinary INPUT_FILE OUTPUT_FILE VARPREFIX WORK_DIR)
  get_filename_component(_out_dir "${OUTPUT_FILE}" DIRECTORY)
  file(MAKE_DIRECTORY "${_out_dir}")

  file(MAKE_DIRECTORY "${WORK_DIR}")
  set(_staged_file "${WORK_DIR}/${VARPREFIX}")
  file(COPY_FILE "${INPUT_FILE}" "${_staged_file}")

  execute_process(
    COMMAND ${XXD} -i "${VARPREFIX}" "${OUTPUT_FILE}"
    WORKING_DIRECTORY "${WORK_DIR}"
    RESULT_VARIABLE _xxd_result
  )
  file(REMOVE_RECURSE "${WORK_DIR}")
  if(NOT _xxd_result EQUAL 0)
    message(FATAL_ERROR "xxd failed embedding '${INPUT_FILE}' (exit ${_xxd_result})")
  endif()

  if(DEFINED EMBED_HEADER_FILE)
    set(_header_file "${EMBED_HEADER_FILE}")
  else()
    _EmbedBinaryHeaderPath("${OUTPUT_FILE}" _header_file)
  endif()
  if(_header_file)
    file(WRITE "${_header_file}"
      "#pragma once\n"
      "extern unsigned char ${VARPREFIX}[];\n"
      "extern unsigned int ${VARPREFIX}_len;\n"
    )
  endif()
endfunction()

######################################################################
##################### Self re-invocation (script mode) ###############
######################################################################

# When invoked via cmake -P (script mode), EMBED_INPUT_FILE/EMBED_OUTPUT_FILE/
# EMBED_VARPREFIX/EMBED_WORK_DIR are passed as -D variables — call
# EmbedBinary directly here. Because the actual work runs at build time
# rather than at configure time, a deleted "embeded/" tree self-heals on
# the next build without a reconfigure.
if(DEFINED EMBED_INPUT_FILE AND DEFINED EMBED_OUTPUT_FILE AND DEFINED EMBED_VARPREFIX AND DEFINED EMBED_WORK_DIR)
  EmbedBinary("${EMBED_INPUT_FILE}" "${EMBED_OUTPUT_FILE}" "${EMBED_VARPREFIX}" "${EMBED_WORK_DIR}")
  return()
endif()

######################################################################
########################### User functions ###########################
######################################################################

# EmbedBinaryTarget(<target_name> <output_file> <varname_prefix>)
## Required parameters
### TARGET_NAME (in) : CMake target whose built binary ($<TARGET_FILE:...>) is embedded
### OUTPUT_FILE (out) : path to the generated C array file
###   VARPREFIX (out) : unsigned char array + unsigned int _len companion
## Behavior:
## - Declares a build rule that re-invokes this script (see block above) to do
##   the actual copy+xxd+header work at build time.
## - If OUTPUT_FILE ends in ".c", the companion header is declared as a second
##   OUTPUT of the same rule, so anything #include-ing it gets a correct build
##   dependency instead of relying on an untracked side effect.
## - Not scriptable itself (wraps add_custom_command and needs $<TARGET_FILE:...>,
##   a generator expression only meaningful within a real project build) — that's
##   why it can't be called from the -P dispatch block, only EmbedBinary can.
function(EmbedBinaryTarget TARGET_NAME OUTPUT_FILE VARPREFIX)
  get_filename_component(_abs_output_file "${OUTPUT_FILE}" ABSOLUTE)
  _EmbedBinaryHeaderPath("${_abs_output_file}" _header_file)
  set(_extra_outputs)
  if(_header_file)
    list(APPEND _extra_outputs "${_header_file}")
  endif()

  string(MD5 _uniq "${_abs_output_file}")
  set(_work_dir "${CMAKE_CURRENT_BINARY_DIR}/embed_tmp/${_uniq}")
  add_custom_command(
    OUTPUT "${_abs_output_file}" ${_extra_outputs}
    COMMAND ${CMAKE_COMMAND}
            -DEMBED_INPUT_FILE=$<TARGET_FILE:${TARGET_NAME}>
            -DEMBED_OUTPUT_FILE=${_abs_output_file}
            -DEMBED_VARPREFIX=${VARPREFIX}
            -DEMBED_WORK_DIR=${_work_dir}
            -P "${CMAKE_CURRENT_SOURCE_DIR}/CMakeBinaryEmbedding.cmake"
    DEPENDS ${TARGET_NAME} "${CMAKE_CURRENT_SOURCE_DIR}/CMakeBinaryEmbedding.cmake"
    COMMENT "Generating C array '${VARPREFIX}' from target '${TARGET_NAME}'"
    VERBATIM
  )
endfunction()

# EmbedBinaryFile(<input_file> <output_file> <varname_prefix>)
## Same as EmbedBinaryTarget, but embeds an arbitrary file on disk instead of
## a CMake target's build output (e.g. a binary produced by an external
## project fetched via FetchAndCreateExternalLib).
function(EmbedBinaryFile INPUT_FILE OUTPUT_FILE VARPREFIX)
  get_filename_component(_abs_input_file "${INPUT_FILE}" ABSOLUTE)
  get_filename_component(_abs_output_file "${OUTPUT_FILE}" ABSOLUTE)
  _EmbedBinaryHeaderPath("${_abs_output_file}" _header_file)
  set(_extra_outputs)
  if(_header_file)
    list(APPEND _extra_outputs "${_header_file}")
  endif()

  string(MD5 _uniq "${_abs_output_file}")
  set(_work_dir "${CMAKE_CURRENT_BINARY_DIR}/embed_tmp/${_uniq}")
  add_custom_command(
    OUTPUT "${_abs_output_file}" ${_extra_outputs}
    COMMAND ${CMAKE_COMMAND}
            -DEMBED_INPUT_FILE=${_abs_input_file}
            -DEMBED_OUTPUT_FILE=${_abs_output_file}
            -DEMBED_VARPREFIX=${VARPREFIX}
            -DEMBED_WORK_DIR=${_work_dir}
            -P "${CMAKE_CURRENT_SOURCE_DIR}/CMakeBinaryEmbedding.cmake"
    DEPENDS "${_abs_input_file}" "${CMAKE_CURRENT_SOURCE_DIR}/CMakeBinaryEmbedding.cmake"
    COMMENT "Generating C array '${VARPREFIX}' from file '${INPUT_FILE}'"
    VERBATIM
  )
endfunction()

# EmbedBinaryTargets(<varname_prefix> PATH <dir> FILES <target1> <target2> ...)
## Embarque N cibles CMake sous UN seul symbole VARPREFIX. Chaque element de
## FILES est a la fois le nom de la cible CMake ($<TARGET_FILE:...>) et la
## base du nom du fichier .c genere : "<PATH>/<element>.c". Toujours .c (pas
## de mode .h direct - cf. discussion sur xxd et static). Un unique header
## partage est genere dans PATH, nomme d'apres VARPREFIX (minuscule).
function(EmbedBinaryTargets VARPREFIX)
  cmake_parse_arguments(ARG "" "PATH" "TARGETS" ${ARGN})

  if(NOT ARG_PATH)
    message(FATAL_ERROR "EmbedBinaryTargets(${VARPREFIX}): missing PATH")
  endif()
  list(LENGTH ARG_TARGETS _n_files)
  if(_n_files EQUAL 0)
    message(FATAL_ERROR "EmbedBinaryTargets(${VARPREFIX}): empty TARGETS")
  endif()

  get_filename_component(_abs_path "${ARG_PATH}" ABSOLUTE)
  string(TOLOWER "${VARPREFIX}" _header_name)
  set(_shared_header "${_abs_path}/${_header_name}.h")

  math(EXPR _last_idx "${_n_files} - 1")
  foreach(_i RANGE ${_last_idx})
    list(GET ARG_TARGETS ${_i} _target)
    set(_abs_output "${_abs_path}/${_target}.c")

    set(_extra_outputs)
    set(_header_for_call "")
    if(_i EQUAL 0)
      set(_header_for_call "${_shared_header}")
      list(APPEND _extra_outputs "${_shared_header}")
    endif()

    string(MD5 _uniq "${_abs_output}")
    set(_work_dir "${CMAKE_CURRENT_BINARY_DIR}/embed_tmp/${_uniq}")
    add_custom_command(
      OUTPUT "${_abs_output}" ${_extra_outputs}
      COMMAND ${CMAKE_COMMAND}
              -DEMBED_INPUT_FILE=$<TARGET_FILE:${_target}>
              -DEMBED_OUTPUT_FILE=${_abs_output}
              -DEMBED_VARPREFIX=${VARPREFIX}
              -DEMBED_WORK_DIR=${_work_dir}
              "-DEMBED_HEADER_FILE=${_header_for_call}"
              -P "${CMAKE_CURRENT_SOURCE_DIR}/CMakeBinaryEmbedding.cmake"
      DEPENDS ${_target} "${CMAKE_CURRENT_SOURCE_DIR}/CMakeBinaryEmbedding.cmake"
      COMMENT "Generating C array '${VARPREFIX}' from target '${_target}'"
      VERBATIM
    )
  endforeach()
endfunction()
