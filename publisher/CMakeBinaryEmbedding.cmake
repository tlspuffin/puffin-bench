#***********************************************\
#                                               *
#  project : Cmake helper to embed files        *
#                                               *
#  author : Olivier Demengeon                   *
#  created : 2026                               *
#                                               *
#***********************************************/

cmake_minimum_required(VERSION 3.16)

find_program(XXD xxd REQUIRED)

function(EmbedBinaryTarget TARGET_NAME OUTPUT_HEADER VARPREFIX)
  get_filename_component(_abs_output_header "${OUTPUT_HEADER}" ABSOLUTE)
  get_filename_component(_out_dir "${_abs_output_header}" DIRECTORY)
  file(MAKE_DIRECTORY "${_out_dir}")
  set(TEMP_FILE "${CMAKE_CURRENT_BINARY_DIR}/${VARPREFIX}")
  add_custom_command(
    OUTPUT "${_abs_output_header}"
    COMMAND ${CMAKE_COMMAND} -E copy "$<TARGET_FILE:${TARGET_NAME}>" "${TEMP_FILE}"       
    COMMAND ${CMAKE_COMMAND} -E chdir "${CMAKE_CURRENT_BINARY_DIR}" ${XXD} -i "${VARPREFIX}" "${_abs_output_header}"
    COMMAND ${CMAKE_COMMAND} -E rm -f "${TEMP_FILE}"
    DEPENDS ${TARGET_NAME}
    COMMENT "Generating C array '${VARPREFIX}' from target '${TARGET_NAME}'"
    VERBATIM
  )
endfunction()

function(EmbedBinaryFile INPUT_FILE OUTPUT_HEADER VARPREFIX)
  get_filename_component(_abs_input_file "${INPUT_FILE}" ABSOLUTE)
  get_filename_component(_abs_output_header "${OUTPUT_HEADER}" ABSOLUTE)
  get_filename_component(_out_dir "${_abs_output_header}" DIRECTORY)
  file(MAKE_DIRECTORY "${_out_dir}")
  set(TEMP_FILE "${CMAKE_CURRENT_BINARY_DIR}/${VARPREFIX}")
  add_custom_command(
    OUTPUT "${_abs_output_header}"
    COMMAND ${CMAKE_COMMAND} -E copy "${_abs_input_file}" "${TEMP_FILE}"
    COMMAND ${CMAKE_COMMAND} -E chdir "${CMAKE_CURRENT_BINARY_DIR}" ${XXD} -i "${VARPREFIX}" "${_abs_output_header}"
    COMMAND ${CMAKE_COMMAND} -E rm -f "${TEMP_FILE}"
    DEPENDS "${_abs_input_file}"
    COMMENT "Generating C array '${VARPREFIX}' from file '${INPUT_FILE}'"
    VERBATIM
  )
endfunction()
