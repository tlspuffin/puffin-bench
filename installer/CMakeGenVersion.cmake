#***********************************************\
#                                               *
#  project : Cmake helper to maintain version   *
#            header                             *
#                                               *
#  author : Olivier Demengeon                   *
#  created : 2026                               *
#                                               *
#***********************************************/

if(NOT DEFINED INPUT)
    message(FATAL_ERROR "missing INPUT")
endif()
if(NOT DEFINED OUTPUT)
    message(FATAL_ERROR "missing OUTPUT")
endif()

string(TIMESTAMP BUILD_DATE "%b %d %Y")
string(TIMESTAMP BUILD_TIME "%H:%M:%S")

find_package(Git QUIET)

set(GIT_COMMIT "unknown")
set(GIT_DIRTY 0)

if(GIT_FOUND)
  execute_process(
      COMMAND "${GIT_EXECUTABLE}" rev-parse --short=12 HEAD
      WORKING_DIRECTORY "${CMAKE_SOURCE_DIR}"
      OUTPUT_VARIABLE GIT_COMMIT
      OUTPUT_STRIP_TRAILING_WHITESPACE
      ERROR_QUIET
  )

  execute_process(
      COMMAND "${GIT_EXECUTABLE}" diff --quiet --exit-code
      WORKING_DIRECTORY "${CMAKE_SOURCE_DIR}"
      RESULT_VARIABLE GIT_DIFF_RESULT
      ERROR_QUIET
  )

  execute_process(
      COMMAND "${GIT_EXECUTABLE}" diff --cached --quiet --exit-code
      WORKING_DIRECTORY "${CMAKE_SOURCE_DIR}"
      RESULT_VARIABLE GIT_DIFF_CACHED_RESULT
      ERROR_QUIET
  )

  if(NOT GIT_DIFF_RESULT EQUAL 0 OR NOT GIT_DIFF_CACHED_RESULT EQUAL 0)
    set(GIT_DIRTY 1)
  endif()
endif()

configure_file("${INPUT}" "${OUTPUT}" @ONLY)