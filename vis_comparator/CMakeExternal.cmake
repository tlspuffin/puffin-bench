#***********************************************\
#                                               *
#  project : Cmake Helper to build Library      *
#                                               *
#  author : Olivier Demengeon                   *
#  created : 2024                               *
#                                               *
#***********************************************/

cmake_minimum_required(VERSION 3.21)

find_package(Git REQUIRED)

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
        "NAME;GIT_URL;GIT_TAG;GIT_COMMIT;TARGET;TARGET_TYPE"
        "CMAKE_ARGS;INCLUDE_DIRS;LIBS_RELEASE;LIBS_DEBUG;IMPLIBS_RELEASE;IMPLIBS_DEBUG;INTERFACE_LIBS;INTERFACE_LIBS_RELEASE;INTERFACE_LIBS_DEBUG;INTERFACE_COMPILE_DEFINITIONS"
        ${ARGN}
    )

  set(SRC_DIR     ${CMAKE_BINARY_DIR}/${FEP_NAME}-src)
  set(BLD_DIR     ${CMAKE_BINARY_DIR}/${FEP_NAME}-bld)
  set(INSTALL_DIR ${CMAKE_BINARY_DIR}/${FEP_NAME}-install)

  get_property(IS_MULTI_CONFIG GLOBAL PROPERTY GENERATOR_IS_MULTI_CONFIG)

  # Clone
  if(NOT EXISTS ${SRC_DIR})
    if(FEP_GIT_TAG)
      message(STATUS "${FEP_NAME}: clonage (tag: ${FEP_GIT_TAG})...")
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

  # Configure
  set(_cmake_args
        -S ${SRC_DIR}
        -B ${BLD_DIR}
        -G ${CMAKE_GENERATOR}
        ${FEP_CMAKE_ARGS}
    )
  if(NOT IS_MULTI_CONFIG)
    list(APPEND _cmake_args -DCMAKE_BUILD_TYPE=${CMAKE_BUILD_TYPE})
  endif()
  if(CMAKE_GENERATOR_PLATFORM)
    list(APPEND _cmake_args -A ${CMAKE_GENERATOR_PLATFORM})
  endif()
  if(CMAKE_GENERATOR_TOOLSET)
    list(APPEND _cmake_args -T ${CMAKE_GENERATOR_TOOLSET})
  endif()
  if (NOT FEP_FIX_INSTALL_PREFIX)
    list(APPEND _cmake_args -DCMAKE_INSTALL_PREFIX=${INSTALL_DIR})
    message(STATUS "${FEP_NAME}: configuration...")
    execute_process(COMMAND ${CMAKE_COMMAND} ${_cmake_args})
  endif()

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
            --build ${BLD_DIR} --config ${CONFIG} -j)
      execute_process(COMMAND ${CMAKE_COMMAND}
            --install ${BLD_DIR} --config ${CONFIG} --prefix ${INSTALL_DIR}/${CONFIG})
    endforeach()
  else()
    if (FEP_FIX_INSTALL_PREFIX)
      list(APPEND _cmake_args -DCMAKE_INSTALL_PREFIX=${INSTALL_DIR})
      message(STATUS "${FEP_NAME}: configuration...")
      execute_process(COMMAND ${CMAKE_COMMAND} ${_cmake_args})
    endif()
    message(STATUS "${FEP_NAME}: build+install...")
    execute_process(COMMAND ${CMAKE_COMMAND} --build ${BLD_DIR} -j)
    execute_process(COMMAND ${CMAKE_COMMAND} --install ${BLD_DIR})
  endif()

  if(IS_DIRECTORY ${INSTALL_DIR}/Release AND IS_DIRECTORY ${INSTALL_DIR}/Debug)
    set(_install_release ${INSTALL_DIR}/Release)
    set(_install_debug   ${INSTALL_DIR}/Debug)
  else()
    set(_install_release ${INSTALL_DIR})
    set(_install_debug   ${INSTALL_DIR})
  endif()

  if(FEP_TARGET)
    if(NOT FEP_TARGET_TYPE)
      set(FEP_TARGET_TYPE STATIC)
    endif()

    add_library(${FEP_TARGET} IMPORTED ${FEP_TARGET_TYPE} GLOBAL)

    # Préfixer chaque entrée avec INSTALL_DIR
    macro(prefix_with_install_dir OUT_VAR IN_LIST BASE_DIR)
      set(${OUT_VAR})
      foreach(_item ${IN_LIST})
        list(APPEND ${OUT_VAR} ${BASE_DIR}/${_item})
      endforeach()
    endmacro()

    prefix_with_install_dir(_include_dirs    "${FEP_INCLUDE_DIRS}"    ${_install_release})
    prefix_with_install_dir(_libs_release    "${FEP_LIBS_RELEASE}"    ${_install_release})
    prefix_with_install_dir(_libs_debug      "${FEP_LIBS_DEBUG}"      ${_install_debug})
    prefix_with_install_dir(_implibs_release "${FEP_IMPLIBS_RELEASE}" ${_install_release})
    prefix_with_install_dir(_implibs_debug   "${FEP_IMPLIBS_DEBUG}"   ${_install_debug})

    # Includes
    if(_include_dirs)
      set_target_properties(${FEP_TARGET} PROPERTIES
            INTERFACE_INCLUDE_DIRECTORIES "${_include_dirs}")
    endif()

    # Libs Release/Debug
    if(IS_MULTI_CONFIG)
      if(_libs_release)
        list(GET _libs_release 0 _first)
        set_target_properties(${FEP_TARGET} PROPERTIES
              IMPORTED_LOCATION_RELEASE "${_first}"
     IMPORTED_LOCATION "${_first}")
        list(LENGTH _libs_release _len)
        if(_len GREATER 1)
          list(SUBLIST _libs_release 1 -1 _rest)
          set_target_properties(${FEP_TARGET} PROPERTIES
                IMPORTED_LINK_INTERFACE_LIBRARIES_RELEASE "${_rest}"
    IMPORTED_LINK_INTERFACE_LIBRARIES "${_rest}")
        endif()
      endif()
      if(_libs_debug)
        list(GET _libs_debug 0 _first)
        set_target_properties(${FEP_TARGET} PROPERTIES
              IMPORTED_LOCATION_DEBUG "${_first}")
        list(LENGTH _libs_debug _len)
        if(_len GREATER 1)
          list(SUBLIST _libs_debug 1 -1 _rest)
          set_target_properties(${FEP_TARGET} PROPERTIES
                IMPORTED_LINK_INTERFACE_LIBRARIES_DEBUG "${_rest}")
        endif()
      endif()
    else()
      if(_libs_release)
        list(GET _libs_release 0 _first)
        set_target_properties(${FEP_TARGET} PROPERTIES
              IMPORTED_LOCATION "${_first}")
        list(LENGTH _libs_release _len)
        if(_len GREATER 1)
          list(SUBLIST _libs_release 1 -1 _rest)
          set_target_properties(${FEP_TARGET} PROPERTIES
                IMPORTED_LINK_INTERFACE_LIBRARIES "${_rest}")
        endif()
      endif()
    endif()

    # Import libs (DLL)
    if(_implibs_release)
      set_target_properties(${FEP_TARGET} PROPERTIES
            IMPORTED_IMPLIB_RELEASE "${_implibs_release}")
    endif()
    if(_implibs_debug)
      set_target_properties(${FEP_TARGET} PROPERTIES
            IMPORTED_IMPLIB_DEBUG "${_implibs_debug}")
    endif()

    # Libs système identiques Debug/Release
    if(FEP_INTERFACE_LIBS)
      set_target_properties(${FEP_TARGET} PROPERTIES
            INTERFACE_LINK_LIBRARIES "${FEP_INTERFACE_LIBS}")
    endif()

    # Libs système spécifiques par config
    if(FEP_INTERFACE_LIBS_RELEASE OR FEP_INTERFACE_LIBS_DEBUG)
      set_property(TARGET ${FEP_TARGET} APPEND PROPERTY
      INTERFACE_LINK_LIBRARIES
            "$<$<CONFIG:Release>:${FEP_INTERFACE_LIBS_RELEASE}>"
            "$<$<CONFIG:Debug>:${FEP_INTERFACE_LIBS_DEBUG}>")
    endif()

    if(FEP_INTERFACE_COMPILE_DEFINITIONS)
      set_target_properties(${FEP_TARGET} PROPERTIES
      INTERFACE_COMPILE_DEFINITIONS "${FEP_INTERFACE_COMPILE_DEFINITIONS}")
    endif()
  endif()

  # Exposer les chemins à l'appelant via variables dans le scope parent
  #set(${FEP_NAME}_SRC_DIR         ${SRC_DIR}          PARENT_SCOPE)
  #set(${FEP_NAME}_BLD_DIR         ${BLD_DIR}          PARENT_SCOPE)
  set(${FEP_NAME}_INSTALL_DIR     ${INSTALL_DIR}      PARENT_SCOPE)

  set(${FEP_NAME}_INCLUDE_DIRS    ${_include_dirs}    PARENT_SCOPE)
  set(${FEP_NAME}_LIBS_RELEASE    ${_libs_release}    PARENT_SCOPE)
  set(${FEP_NAME}_LIBS_DEBUG      ${_libs_debug}      PARENT_SCOPE)
  set(${FEP_NAME}_IMPLIBS_RELEASE ${_implibs_release} PARENT_SCOPE)
  set(${FEP_NAME}_IMPLIBS_DEBUG   ${_implibs_debug}   PARENT_SCOPE)
endfunction()
