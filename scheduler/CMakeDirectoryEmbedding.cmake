find_program(ZIP zip REQUIRED)

include(CMakeBinaryEmbedding.cmake)

# EmbedDirectory(<source_dir> <output_c_file> <varname_prefix> FILES <file1> <file2> ...)
## FILES : liste exhaustive de chemins relatifs à SOURCE_DIR — à construire par
## l'appelant (liste écrite à la main, ou file(GLOB_RECURSE ... CONFIGURE_DEPENDS)
## + list(FILTER ... REGEX ...)). Cette même liste pilote à la fois le contenu
## de l'archive et le DEPENDS : une seule source de vérité, pas de risque de
## désync entre "ce que zip inclut" et "ce que CMake surveille".
function(EmbedDirectory SOURCE_DIR OUTPUT_FILE VARPREFIX)
  cmake_parse_arguments(ARG "" "" "FILES" ${ARGN})
  if(NOT ARG_FILES)
    message(FATAL_ERROR "EmbedDirectoryZip(${VARPREFIX}): FILES est vide")
  endif()

  get_filename_component(_abs_source_dir "${SOURCE_DIR}" ABSOLUTE)
  get_filename_component(_abs_output_file "${OUTPUT_FILE}" ABSOLUTE)

  set(_abs_deps)
  foreach(_f IN LISTS ARG_FILES)
    list(APPEND _abs_deps "${_abs_source_dir}/${_f}")
  endforeach()

  string(MD5 _uniq "${_abs_output_file}")
  set(_zip_file "${CMAKE_CURRENT_BINARY_DIR}/embed_tmp/${_uniq}.zip")

  add_custom_command(
    OUTPUT "${_zip_file}"
    COMMAND ${CMAKE_COMMAND} -E make_directory "${CMAKE_CURRENT_BINARY_DIR}/embed_tmp"
    COMMAND ${CMAKE_COMMAND} -E rm -f "${_zip_file}"
    COMMAND ${ZIP} "${_zip_file}" ${ARG_FILES}
    WORKING_DIRECTORY "${_abs_source_dir}"
    DEPENDS ${_abs_deps}
    COMMENT "Zipping ${_abs_source_dir} -> ${_zip_file}"
    VERBATIM
  )

  EmbedBinaryFile("${_zip_file}" "${_abs_output_file}" "${VARPREFIX}")
endfunction()
