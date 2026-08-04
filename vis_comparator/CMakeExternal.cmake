#***********************************************\
#                                               *
#  project : Cmake helper to fetch libraries    *
#                                               *
#  author : Olivier Demengeon                   *
#  created : 2026                               *
#                                               *
#***********************************************/

cmake_minimum_required(VERSION 3.21)

include(CMakeUtils.cmake)

find_package(Git REQUIRED)

set(DEPS_BASE_DIR "${CMAKE_BINARY_DIR}/_deps" CACHE PATH "shared dependencies base directory")

# Signature:
# fetch_external_project(
#     NAME        <name>
#     GIT_URL     <url>
#     GIT_TAG     <tag>
#     CMAKE_ARGS  <arg1> <arg2> ...
# )
function(FetchExternalProject)
  cmake_parse_arguments(FEP
      "FIX_INSTALL_PREFIX"
      "NAME;HASH_SRC;HASH_DST;GIT_URL;GIT_TAG;GIT_COMMIT;CMAKE_PATH"
      "CMAKE_ARGS"
      ${ARGN}
  )
  get_property(IS_MULTI_CONFIG GLOBAL PROPERTY GENERATOR_IS_MULTI_CONFIG)

  if(FEP_HASH_SRC AND FEP_HASH_DST)
    set(FEP_HASH_SRC "${FEP_HASH_SRC}-")
    set(FEP_HASH_DST "${FEP_HASH_DST}-")
  elseif((NOT FEP_HASH_SRC) AND (NOT FEP_HASH_DST))
  else()
    message(FATAL_ERROR "FetchExternalProject ${FEP_NAME} require 2 or 0 hashes")
  endif()
  set(SRC_DIR     ${DEPS_BASE_DIR}/${FEP_NAME}-${FEP_HASH_SRC}src)
  set(BLD_DIR     ${DEPS_BASE_DIR}/${FEP_NAME}-${FEP_HASH_DST}bld)
  set(INSTALL_DIR ${DEPS_BASE_DIR}/${FEP_NAME}-${FEP_HASH_DST}install)

  # Get Source
  if(NOT EXISTS ${SRC_DIR})
    if(FEP_GIT_TAG)
      message(STATUS "${FEP_NAME}: clonage (tag: ${FEP_GIT_TAG})... ${SRC_DIR}")
      execute_process(
          COMMAND ${GIT_EXECUTABLE} clone --depth 1 --branch ${FEP_GIT_TAG}
          ${FEP_GIT_URL} ${SRC_DIR}
      )
    elseif(FEP_GIT_COMMIT)
      message(STATUS "${FEP_NAME}: clonage (commit: ${FEP_GIT_COMMIT})...")
      execute_process(
          COMMAND ${GIT_EXECUTABLE} clone ${FEP_GIT_URL} ${SRC_DIR}
      )
      execute_process(
          COMMAND ${GIT_EXECUTABLE} checkout ${FEP_GIT_COMMIT}
          WORKING_DIRECTORY ${SRC_DIR}
      )
    else()
      message(STATUS "${FEP_NAME}: clonage ...")
      execute_process(
          COMMAND ${GIT_EXECUTABLE} clone --depth 1 ${FEP_GIT_URL} ${SRC_DIR}
      )
    endif()
  endif()

  set(PRJ_CMAKE_PATH "${SRC_DIR}")
  if (FEP_CMAKE_PATH)
    set(PRJ_CMAKE_PATH "${SRC_DIR}/${FEP_CMAKE_PATH}")
  endif()

  # Configure
  set(_cmake_args -S ${PRJ_CMAKE_PATH} -B ${BLD_DIR} -G ${CMAKE_GENERATOR} ${FEP_CMAKE_ARGS})
  if(NOT IS_MULTI_CONFIG)
    list(APPEND _cmake_args -DCMAKE_BUILD_TYPE=${CMAKE_BUILD_TYPE})
  endif()
  if(CMAKE_GENERATOR_PLATFORM)
    list(APPEND _cmake_args -A ${CMAKE_GENERATOR_PLATFORM})
  endif()
  if(CMAKE_GENERATOR_TOOLSET)
    list(APPEND _cmake_args -T ${CMAKE_GENERATOR_TOOLSET})
  endif()
  if (NOT (FEP_FIX_INSTALL_PREFIX AND IS_MULTI_CONFIG))
    if(IS_MULTI_CONFIG)
      list(APPEND _cmake_args -DCMAKE_INSTALL_PREFIX=${INSTALL_DIR})
    else()
      list(APPEND _cmake_args -DCMAKE_INSTALL_PREFIX=${INSTALL_DIR}/${CMAKE_BUILD_TYPE})
    endif()
    message(STATUS "${FEP_NAME}: configuration...")
    execute_process(COMMAND ${CMAKE_COMMAND} ${_cmake_args})
  endif()

  if (NOT EXTERNAL_BUILD_J)
    set(EXTERNAL_BUILD_J "")
  endif()
  # Build
  if(IS_MULTI_CONFIG)
    foreach(CONFIG Debug Release)
      if (FEP_FIX_INSTALL_PREFIX)
        set(_cmake_args_current ${_cmake_args})
        list(APPEND _cmake_args_current --fresh -DCMAKE_INSTALL_PREFIX=${INSTALL_DIR}/${CONFIG})
        message(STATUS "${FEP_NAME}: configuration for ${CONFIG}...")
        execute_process(COMMAND ${CMAKE_COMMAND} ${_cmake_args_current})
      endif()
      message(STATUS "${FEP_NAME}: build+install ${CONFIG}...")
      execute_process(COMMAND ${CMAKE_COMMAND}
          --build ${BLD_DIR} --config ${CONFIG} -j${EXTERNAL_BUILD_J})
      execute_process(COMMAND ${CMAKE_COMMAND}
          --install ${BLD_DIR} --config ${CONFIG} --prefix ${INSTALL_DIR}/${CONFIG})
    endforeach()
  else()
    message(STATUS "${FEP_NAME}: build+install...")
    execute_process(COMMAND ${CMAKE_COMMAND} --build ${BLD_DIR} -j${EXTERNAL_BUILD_J})
    execute_process(COMMAND ${CMAKE_COMMAND} --install ${BLD_DIR})
  endif()

  file(REMOVE_RECURSE "${BLD_DIR}")

  file(WRITE "${INSTALL_DIR}/.cmake-deps-meta.cmake"
      "set(${FEP_NAME}_SRC_DIR     \"${SRC_DIR}\")\n"
      "set(${FEP_NAME}_SRC_HASH    \"${FEP_HASH_SRC}\")\n"
      "set(${FEP_NAME}_GIT_TAG     \"${FEP_GIT_TAG}\")\n"
      "set(${FEP_NAME}_CMAKE_ARGS  \"${FEP_CMAKE_ARGS}\")\n"
      "set(${FEP_NAME}_LIBTYPE     \"${FEP_LIBTYPE}\")\n"
  )

  set(${FEP_NAME}_INSTALL_DIR     ${INSTALL_DIR}      PARENT_SCOPE)
endfunction()

# Signature:
# FetchAndCreateExternalLib(
#     NAME          <name>
#     OUTPUT_TARGET <variable>    # optional: receives the actual created target name (NAME + build hash)
#     GIT_URL       <url>
#     GIT_TAG       <tag>          # optional
#     GIT_COMMIT    <commit>       # optional
#     LIBTYPE       <STATIC|SHARED|HEADERSONLY>
#     REQUIREDLIBS  <lib1> <lib2> ...
#     CMAKE_PATH    <path to CMakelists.txt in source tree> # optional
#     CMAKE_ARGS    <arg1> <arg2> ...  # optional
#     OPTIONALS     <lib1> <lib2> ...  # optional
#     HEADERSAMPLE  <file>             # optional
#     HEADERSPATH   <path>             # optional
#     COMPILE_DEFINITIONS <def1> ...   # optional
#     DEPLOYTARGET  <target>           # optional
#     FIX_INSTALL_PREFIX               # optional
#     VERBOSE                          # optional
# )
function(FetchAndCreateExternalLib)
  cmake_parse_arguments(ARG
    "FIX_INSTALL_PREFIX;VERBOSE"
    "NAME;OUTPUT_TARGET;GIT_URL;GIT_TAG;GIT_COMMIT;CMAKE_PATH;LIBTYPE;DEPLOYTARGET;HEADERSAMPLE;HEADERSPATH"
    "CMAKE_ARGS;REQUIREDLIBS;OPTIONALS;COMPILE_DEFINITIONS;LINK_LIBRARIES"
    ${ARGN}
  )

  if(NOT ARG_LIBTYPE)
    set(ARG_LIBTYPE STATIC)
  endif()

  string(MD5 _src_hash "${ARG_GIT_TAG}${ARG_GIT_COMMIT}")
  string(SUBSTRING "${_src_hash}" 0 14 _src_short_hash)
  string(MD5 _build_hash "${ARG_GIT_TAG}${ARG_GIT_COMMIT}${ARG_CMAKE_ARGS}${ARG_LIBTYPE}")
  string(SUBSTRING "${_build_hash}" 0 14 _build_short_hash)
  if (ARG_OUTPUT_TARGET)
    set(_target_real_name "${ARG_NAME}_${_build_short_hash}")
  else()
    set(_target_real_name "${ARG_NAME}")
  endif()

  if (TARGET ${_target_real_name})
    if (ARG_OUTPUT_TARGET)
      set(${ARG_OUTPUT_TARGET} ${_target_real_name} PARENT_SCOPE)
    endif()
    return()
  endif()


  # Arguments optionnels à transmettre
  set(_getlibs_extra)
  if(ARG_HEADERSAMPLE)
    list(APPEND _getlibs_extra HEADERSAMPLE ${ARG_HEADERSAMPLE})
  endif()
  if(ARG_HEADERSPATH)
    list(APPEND _getlibs_extra HEADERSPATH ${ARG_HEADERSPATH})
  endif()
  if(ARG_OPTIONALS)
    list(APPEND _getlibs_extra OPTIONALS ${ARG_OPTIONALS})
  endif()
  if(ARG_VERBOSE)
    list(APPEND _getlibs_extra VERBOSE)
  endif()

  set(_fetch_extra)
  if(ARG_FIX_INSTALL_PREFIX)
    list(APPEND _fetch_extra FIX_INSTALL_PREFIX)
  endif()
  if(ARG_GIT_TAG)
    list(APPEND _fetch_extra GIT_TAG ${ARG_GIT_TAG})
  endif()
  if(ARG_GIT_COMMIT)
    list(APPEND _fetch_extra GIT_COMMIT ${ARG_GIT_COMMIT})
  endif()
  if(ARG_CMAKE_ARGS)
    list(APPEND _fetch_extra CMAKE_ARGS ${ARG_CMAKE_ARGS})
  endif()
  if(ARG_CMAKE_PATH)
    list(APPEND _fetch_extra CMAKE_PATH ${ARG_CMAKE_PATH})
  endif()

  set(_create_extra)
  if(ARG_COMPILE_DEFINITIONS)
    list(APPEND _create_extra COMPILE_DEFINITIONS ${ARG_COMPILE_DEFINITIONS})
  endif()
  if(ARG_LINK_LIBRARIES)
    list(APPEND _create_extra LINK_LIBRARIES ${ARG_LINK_LIBRARIES})
  endif()
  if(ARG_DEPLOYTARGET)
    list(APPEND _create_extra DEPLOYTARGET ${ARG_DEPLOYTARGET})
  endif()
  if(ARG_VERBOSE)
    list(APPEND _create_extra VERBOSE)
  endif()

  set(_src_dir "${DEPS_BASE_DIR}/${ARG_NAME}-${_src_short_hash}-src")
  set(_install_dir "${DEPS_BASE_DIR}/${ARG_NAME}-${_build_short_hash}-install")
  set(_found_libs "NOT-FOUND")

  # 1. Chercher les libs
  GetLibs(${_target_real_name} ${ARG_LIBTYPE} "${_install_dir}"
    "${ARG_REQUIREDLIBS}" _found_libs ${_getlibs_extra})

  set(_build_type "RELEASE")
  if(CMAKE_BUILD_TYPE STREQUAL "Debug")
    set(_build_type "DEBUG")
  endif()
  get_property(IS_MULTI_CONFIG GLOBAL PROPERTY GENERATOR_IS_MULTI_CONFIG)
  if(NOT IS_MULTI_CONFIG)
    if(NOT MYLIBSEARCH_${_target_real_name}_HAS_${_build_type})
      if(NOT "${_found_libs}" STREQUAL "NOT-FOUND")
        message(STATUS "${ARG_NAME}: found, but not built for ${_build_type} yet, rebuilding")
      endif()
      set(_found_libs "NOT-FOUND")
    endif()
  endif()

  # 2. Si non trouvées, fetch + rebuild
  if("${_found_libs}" STREQUAL "NOT-FOUND")
    FetchExternalProject(
      NAME     ${ARG_NAME}
      GIT_URL  ${ARG_GIT_URL}
      HASH_SRC ${_src_short_hash}
      HASH_DST ${_build_short_hash}
      ${_fetch_extra}
    )
    GetLibs(${_target_real_name} ${ARG_LIBTYPE} "${_install_dir}"
      "${ARG_REQUIREDLIBS}" _found_libs ${_getlibs_extra})
  endif()

  # 3. Créer la target
  if(MYLIBSEARCH_${_target_real_name}_HAS_${_build_type} OR MYLIBSEARCH_${_target_real_name}_TYPE_HEADERS)
    CreateExternalLib(${_target_real_name} "${_found_libs}" ${_create_extra})
    set(${_target_real_name}_SOURCE_DIR "${_src_dir}" PARENT_SCOPE)
    set(${_target_real_name}_INSTALL_DIR "${_install_dir}" PARENT_SCOPE)
    if (ARG_OUTPUT_TARGET)
      set(${ARG_OUTPUT_TARGET} ${_target_real_name} PARENT_SCOPE)
    endif()
  else()
    message(FATAL_ERROR "FetchAndCreateExternalLib: could not find or build '${ARG_NAME}'")
  endif()

  if(ARG_VERBOSE)
    PrintTargetProperties(${_target_real_name})
  endif()

endfunction()

# AppendCMakeArgs(<OUTPUT> <CMAKE_VAR_NAMES> <TARGET>)
# CMAKE_VAR_NAMES (semicolon-separated, positional):
#   1st: include dir   -> INTERFACE_INCLUDE_DIRECTORIES
#   2nd: release lib   -> IMPORTED_LOCATION          (optional)
#   3rd: debug lib     -> IMPORTED_LOCATION_DEBUG     (optional)
function(AppendCMakeArgs OUTPUT CMAKE_VAR_NAMES TARGET)
  list(LENGTH CMAKE_VAR_NAMES _LEN)

  list(GET CMAKE_VAR_NAMES 0 _INCLUDE_NAME)
  get_target_property(_INCLUDE_PATH ${TARGET} INTERFACE_INCLUDE_DIRECTORIES)
  if(_INCLUDE_PATH)
    list(APPEND ${OUTPUT} "-D${_INCLUDE_NAME}=${_INCLUDE_PATH}")
  endif()

  if(_LEN GREATER 1)
    list(GET CMAKE_VAR_NAMES 1 _LIB_RELEASE)
    get_target_property(_LIB_RELEASE_PATH ${TARGET} IMPORTED_LOCATION)
    if(_LIB_RELEASE_PATH)
      list(APPEND ${OUTPUT} "-D${_LIB_RELEASE}=${_LIB_RELEASE_PATH}")
    endif()
  endif()

  if(_LEN GREATER 2)
    list(GET CMAKE_VAR_NAMES 2 _LIB_DEBUG)
    get_target_property(_LIB_DEBUG_PATH ${TARGET} IMPORTED_LOCATION_DEBUG)
    if(_LIB_DEBUG_PATH)
      list(APPEND ${OUTPUT} "-D${_LIB_DEBUG}=${_LIB_DEBUG_PATH}")
    endif()
  endif()

  set(${OUTPUT} "${${OUTPUT}}" PARENT_SCOPE)
endfunction()
