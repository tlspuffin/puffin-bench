#***********************************************\
#                                               *
#  project : Cmake Helper to find Library       *
#                                               *
#  author : Olivier Demengeon                   *
#  created : 2024                               *
#                                               *
#***********************************************/

cmake_minimum_required(VERSION 3.16)

#######################################################################
########################## Helper functions ##########################
#######################################################################

function (IsLibWanted libpath libname type wantedlib symbolicName)
  set(${symbolicName} "" PARENT_SCOPE)
  string(REGEX MATCHALL "/[^/]*" pathSplit ${libpath})
  foreach(arch ${MYTOOLS_LIB_PATH_ARCH_AVOID})
    if("/${arch}" IN_LIST pathSplit)
        return()
    endif()
  endforeach()

  if ((NOT wantedlib) OR (NOT type))
    set(${symbolicName} "${libname}" PARENT_SCOPE)
    return()
  endif()

  if (${type} STREQUAL "debug")
    string(REGEX REPLACE "d$" "" libname ${libname})
  endif()
  if (${libname} IN_LIST wantedlib)
    set(${symbolicName} "${libname}" PARENT_SCOPE)
    return()
  endif()
  string(REGEX REPLACE "^lib" "" libnamewithoutprefix ${libname})
  if (${libnamewithoutprefix} IN_LIST wantedlib)
    set(${symbolicName} "${libnamewithoutprefix}" PARENT_SCOPE)
    return()
  endif()
endfunction()

function (TryFindDLL libname type dllFiles retval)
  #message(STATUS "TryFindDLL <${libname}> <${type}> <${dllFiles}>")
  set(${retval} PARENT_SCOPE)
  foreach(file ${dllFiles})
    get_filename_component(filepath "${file}" DIRECTORY)
    set(filepath "${filepath}/")
    foreach(arch ${MYTOOLS_LIB_PATH_ARCH_AVOID})

      if ((filepath MATCHES "[rR][eE][lL][eE][aA][sS][eE]") AND (${type} STREQUAL "debug"))
        set(file "")
        break()
      elseif ((filepath MATCHES "[dD][eE][bB][uU][gG]") AND (${type} STREQUAL "release"))
        set(file "")
        break()
      endif()

      if(filepath MATCHES ".*/${arch}/.*")
        set(file "")
        break()
      endif()
    endforeach()
    if (NOT file)
      continue()
    endif()
    get_filename_component(filename "${file}" NAME_WE)
    foreach(arch ${MYTOOLS_LIB_PATH_ARCH_POSSIBILITY})
      string(REPLACE "${arch}" "" filename "${filename}")
    endforeach()
    string(REGEX MATCH "${libname}[0-9_-]*" matchingFile "${filename}")
    #message(STATUS "${libname}[0-9_-]* | ${filename} = ${file} <${matchingFile}>")
    if (matchingFile)
      set(${retval} ${file} PARENT_SCOPE)
      return()
    endif()
  endforeach()
endfunction()

######################################################################
########################## Common variables ##########################
######################################################################

set(MYTOOLS_LIB_EXTENSION_SHARED)
set(MYTOOLS_LIB_EXTENSION_STATIC)
set(MYTOOLS_LIB_PATH_ARCH_POSSIBILITY)
set(MYTOOLS_LIB_PATH_ARCH_AVOID)
set(OS_SUPPORT_DLL OFF)
if (WIN32)
  set(MYTOOLS_LIB_EXTENSION_SHARED lib)
  set(MYTOOLS_LIB_EXTENSION_STATIC lib)
  if (${CMAKE_SYSTEM_PROCESSOR} STREQUAL "X86")
    set(MYTOOLS_LIB_PATH_ARCH_POSSIBILITY x86 Win32)
    set(MYTOOLS_LIB_PATH_ARCH_AVOID x86_64 x64 Win64)
  else()
    set(MYTOOLS_LIB_PATH_ARCH_POSSIBILITY x86_64 x64 Win64)
    set(MYTOOLS_LIB_PATH_ARCH_AVOID x86 Win32)
  endif()
  set(OS_SUPPORT_DLL ON)
endif (WIN32)

if (UNIX)
  set(MYTOOLS_LIB_EXTENSION_SHARED so)
  set(MYTOOLS_LIB_EXTENSION_STATIC a)
  if (${CMAKE_SYSTEM_PROCESSOR} STREQUAL "x86_64")
    set(MYTOOLS_LIB_PATH_ARCH_POSSIBILITY x86_64 x64)
    set(MYTOOLS_LIB_PATH_ARCH_AVOID x86)
  else()
    set(MYTOOLS_LIB_PATH_ARCH_POSSIBILITY x86)
    set(MYTOOLS_LIB_PATH_ARCH_AVOID x86_64 x64)
  endif()
endif (UNIX)

######################################################################
########################### User functions ###########################
######################################################################

## Required parameters
### libname (in) : name of the library
### libsharedstatic (in) : STATIC, SHARED or HEADERSONLY type of library file to find
### libpath (in) : 
###  * for STATIC or SHARED libraries: path where to search for the headers and libraries files
###  * for HEADERSONLY libraries: it match is same as the optional parameter HEADERSAMPLE, can be empty to use default search method
### requiredlib (in) : list of libraries names required to find in <libpath>, if empty will use all libraries found
### outFoundlibs (out) : list of libraries found or NOT-fOUND or NOT-ALL-fOUND
## Optional (in) parameters
### HEADERSONLY : will only setup headers informations
### HEADERSPATH <path> : a path where the headers are, not test will be done on it, ignored if path is empty.
###                      if set to SYSTEM will use os headers locations
### OPTIONALS <list of path> : list of libraries names optinal to find in <libpath>
### HEADERSAMPLE <include_file> : only for STATIC or SHARED libraries, example of include of the librarie in your code like glm/glm.hpp
### VERBOSE : to make cmake display information at run
function(GetLibs libname libsharedstatic libpath requiredlib outFoundlibs)
  message(STATUS "looking for ${libname} in ${libpath}")

  cmake_parse_arguments(PARSE_ARGV 5 arg "VERBOSE" "HEADERSPATH;HEADERSAMPLE" "OPTIONALS")
  string(REPLACE "\\;" ";" arg_OPTIONALS "${arg_OPTIONALS}")
  set(headersPathSearch ON)
  set(optionallib "${arg_OPTIONALS}")
  if("${libsharedstatic}" STREQUAL "HEADERSONLY")
    if (requiredlib)
      set(includesample "${requiredlib}")
    endif()
  elseif(arg_HEADERSAMPLE)
    set(includesample "${arg_HEADERSAMPLE}")
  endif()
  set(verbose ${arg_VERBOSE})

  set(foundMSG "not found")
  set(${outFoundlibs} "NOT-fOUND" PARENT_SCOPE)

  if (NOT arg_HEADERSPATH)
    if(NOT includesample)
      file(GLOB_RECURSE headersfound "${libpath}/*.h")
      list(APPEND allheadersfound ${headersfound})
      file(GLOB_RECURSE headersfound "${libpath}/*.hpp")
      list(APPEND allheadersfound ${headersfound})
      file(GLOB_RECURSE headersfound "${libpath}/*.hxx")
      list(APPEND allheadersfound ${headersfound})
      if (NOT allheadersfound)
        message(STATUS "looking for ${libname} in ${libpath} - ${foundMSG}")
        return()
      endif()
      list(SORT allheadersfound)
      list(GET allheadersfound 0 headerpath)
      get_filename_component(headerpath ${headerpath} DIRECTORY)
      string(REGEX REPLACE "/include/.*" "/include/" realheaderpath ${headerpath})
    else()
      get_filename_component(includesamplename "${includesample}" NAME)
      file(GLOB_RECURSE headersfound "${libpath}/*${includesamplename}")
      list(APPEND allheadersfound ${headersfound})
      list(SORT allheadersfound)
      foreach(file ${allheadersfound})
        if(file MATCHES ".*${includesample}$")
          set(headerpath ${file})
          break()
        endif()
      endforeach()
      if(NOT headerpath)
        message(STATUS "looking for ${libname} in ${libpath} - ${foundMSG}")
        return()
      endif()
      string(REGEX REPLACE "${includesample}$" "" realheaderpath ${headerpath})
    endif()

    set(realheaderpathRelease ${realheaderpath})
    # if "debug" in header path, try to find a same path exist with release instead of debug inside
    if(${realheaderpath} MATCHES ".*/[dD][eE][bB][uU][gG]/.*")
      string(REGEX REPLACE "\(.*\)/[dD][eE][bB][uU][gG]/.*" "\\1" topofpath "${realheaderpath}")
      string(REGEX REPLACE ".*/[dD][eE][bB][uU][gG]/\(.*\)" "\\1" endofpath "${realheaderpath}")
      foreach(header ${allheadersfound})
        string(REGEX REPLACE "/include/.*" "/include/" headerpath ${header})
        if(${headerpath} MATCHES "${topofpath}/[rR][eE][lL][eE][aA][sS][eE]/${endofpath}")
          set(realheaderpathRelease "${headerpath}")
          break()
        endif()
      endforeach()
    endif()

    set(headersPath "${realheaderpathRelease}")
  elseif("${arg_HEADERSPATH}" STREQUAL "SYSTEM")
    set(headersPath "")
  else()
    set(headersPath "${arg_HEADERSPATH}")
  endif()
  if (verbose)
    message(STATUS "  set MYLIBSEARCH_${libname}_HEADERS = ${headersPath}")
  endif()
  set(MYLIBSEARCH_${libname}_HEADERS "${headersPath}" PARENT_SCOPE)

  message(STATUS "  headers ${headersPath}")
  if("${libsharedstatic}" STREQUAL "HEADERSONLY")
    if(headersPath)
      set(foundMSG "found")
      if(verbose)
        message(STATUS "  set MYLIBSEARCH_${libname}_TYPE_${libsharedstatic} ON")
      endif()
      set(MYLIBSEARCH_${libname}_TYPE_HEADERS ON PARENT_SCOPE)
    endif()
    message(STATUS "looking for ${libname} in ${libpath} - ${foundMSG}")
    return()
  endif()

  list(APPEND libslist ${requiredlib})
  list(APPEND libslist ${optionallib})

  set(files)
  foreach(extension ${MYTOOLS_LIB_EXTENSION_${libsharedstatic}})
    file(GLOB_RECURSE filesfound "${libpath}/*.${extension}")
    list(APPEND files ${filesfound})
  endforeach()

  set(dllFilesLst)
  file(GLOB_RECURSE dllFilesLst "${libpath}/*.dll")
  foreach(file ${dllFilesLst})
    # subPathName is the relative path of pathName from  libpath 
    string(REGEX REPLACE "^${libpath}" "" subPathName "${file}")
    list(APPEND dllFiles ${subPathName})
  endforeach()

  set(libs)
  foreach(file ${files})
    get_filename_component(pathName ${file} DIRECTORY)
    get_filename_component(filename ${file} NAME_WLE)
    #get_filename_component(fileext ${file} LAST_EXT)
    # subPathName is the relative path of pathName from  libpath 
    string(REGEX REPLACE "^${libpath}" "" subPathName "${pathName}")

    set(libType "release")
    set(libPostfix)
    string(REGEX REPLACE "d$" "" filenameRelease ${filename})
    if(${subPathName} MATCHES "[rR][eE][lL][eE][aA][sS][eE]")
    elseif(${subPathName} MATCHES "[dD][eE][bB][uU][gG]")
      set(libType "debug")
      set(libPostfix "_DEBUG")
    else()
      if ((NOT ${filenameRelease} STREQUAL ${filename}) AND ("${filenameRelease}" IN_LIST files))
      set(libType "debug")
      set(libPostfix "_DEBUG")
      endif()
    endif()

    IsLibWanted(${pathName} ${filename} ${libType} "${libslist}" filenameRelease)

    if (filenameRelease)
      message(STATUS "  check ${file}")
      if ((${libsharedstatic} STREQUAL "SHARED") AND (OS_SUPPORT_DLL))
        TryFindDLL(${filename} "${libType}" "${dllFiles}" dllFile)
        string(PREPEND dllFile "${libpath}")
        if (dllFile)
          IsLibWanted(${pathName} ${dllFile} "" "" dllName)
          if(dllName)
            if(verbose)
              message(STATUS "  set MYLIBSEARCH_${libname}_${filenameRelease}_DLL${libPostfix} = ${dllFile}")
            endif()
            set(MYLIBSEARCH_${libname}_${filenameRelease}_DLL${libPostfix} "${dllFile}" PARENT_SCOPE)
          endif()
        endif()
      endif()
      if(verbose)
        message(STATUS "  set MYLIBSEARCH_${libname}_${filenameRelease}${libPostfix} ${file}")
      endif()
      set(MYLIBSEARCH_${libname}_${filenameRelease}${libPostfix} "${file}" PARENT_SCOPE)
      if(NOT libPostfix)
        list(APPEND libs ${filenameRelease})
      endif()
    endif()
  endforeach()
  if (libs)
    set(foundMSG "found")

    foreach(alib ${requiredlib})
      if (NOT ${alib} IN_LIST libs)
        set(foundMSG "missing required libs")
        set(${outFoundlibs} "NOT-fOUND" PARENT_SCOPE)
        break()
      endif()
      list(REMOVE_ITEM libs ${alib})
    endforeach()

    if (${foundMSG} STREQUAL "found")
      set(outFoundlibsList ${requiredlib})
      foreach(alib ${libs})
        list(APPEND outFoundlibsList ${alib})
      endforeach()
      set(${outFoundlibs} "${outFoundlibsList}" PARENT_SCOPE)

      if(verbose)
        message(STATUS "  set MYLIBSEARCH_${libname}_TYPE_${libsharedstatic} ON")
      endif()
      set(MYLIBSEARCH_${libname}_TYPE_${libsharedstatic} ON PARENT_SCOPE)
    endif()

  endif()
  message(STATUS "looking for ${libname} in ${libpath} - ${foundMSG}")
endfunction()

## Required parameters
### libname (in) : name of the library
### libs (in) : outFoundlibs of GetLibs
## Optional (in) parameters
### DEPLOYTARGET <name> : name of the target used to copy the dll in build directories, if the target does not exist, il will create it
### VERBOSE : to make cmake display information at run
function(CreateExternalLib libname libs)
  cmake_parse_arguments(PARSE_ARGV 2 arg "VERBOSE" "DEPLOYTARGET" "")
  set(verbose ${arg_VERBOSE})
  set(deploytarget ${arg_DEPLOYTARGET})

  set(importedDst IMPLIB)
  set(libtype SHARED)
  if (MYLIBSEARCH_${libname}_TYPE_STATIC)
    set(libtype STATIC)
  elseif(MYLIBSEARCH_${libname}_TYPE_HEADERS)
    if(verbose)
      message(STATUS "Create ${libname} as headers only library")
      message(STATUS "  header ${MYLIBSEARCH_${libname}_HEADERS}")
    endif()
    add_library(${libname} INTERFACE)
    set_target_properties(${libname} PROPERTIES
      INTERFACE_INCLUDE_DIRECTORIES "${MYLIBSEARCH_${libname}_HEADERS}")
    return()
  endif()
  if(verbose)
    message(STATUS "Create ${libname} with ${libs}")
  endif()
  set(library_elements)
  foreach(filename ${libs})
    if(verbose)
      message(STATUS "Create ${libname}::${filename}")
      message(STATUS "  header    ${MYLIBSEARCH_${libname}_HEADERS}")
      message(STATUS "  lib       ${MYLIBSEARCH_${libname}_${filename}}")
      message(STATUS "  lib DEBUG ${MYLIBSEARCH_${libname}_${filename}_DEBUG}")
      if ((${libtype} STREQUAL "SHARED") AND (OS_SUPPORT_DLL))
        message(STATUS "  dll       ${MYLIBSEARCH_${libname}_${filename}_DLL}")
        message(STATUS "  dll DEBUG ${MYLIBSEARCH_${libname}_${filename}_DLL_DEBUG}")
      endif()
    endif()

    add_library(${libname}::${filename} ${libtype} IMPORTED)
    list(APPEND library_elements ${libname}::${filename})
    set_target_properties(${libname}::${filename} PROPERTIES
      INTERFACE_INCLUDE_DIRECTORIES "${MYLIBSEARCH_${libname}_HEADERS}"
      IMPORTED_LOCATION "${MYLIBSEARCH_${libname}_${filename}}")
    if (${libtype} STREQUAL "SHARED")
      set_target_properties(${libname}::${filename} PROPERTIES
        IMPORTED_IMPLIB "${MYLIBSEARCH_${libname}_${filename}}")
      if (MYLIBSEARCH_${libname}_${filename}_DEBUG)
        set_target_properties(${libname}::${filename} PROPERTIES
          IMPORTED_IMPLIB_DEBUG "${MYLIBSEARCH_${libname}_${filename}_DEBUG}")
      else()
        set_target_properties(${libname}::${filename} PROPERTIES
          IMPORTED_LOCATION_DEBUG "${MYLIBSEARCH_${libname}_${filename}}")
      endif()
    endif()
    if (MYLIBSEARCH_${libname}_${filename}_DLL)
      set_target_properties(${libname}::${filename} PROPERTIES
        IMPORTED_LOCATION "${MYLIBSEARCH_${libname}_${filename}_DLL}")
    endif()
    if (MYLIBSEARCH_${libname}_${filename}_DLL_DEBUG)
      set_target_properties(${libname}::${filename} PROPERTIES
        IMPORTED_LOCATION_DEBUG "${MYLIBSEARCH_${libname}_${filename}_DLL_DEBUG}")
    endif()

    if (deploytarget)
      if (NOT TARGET ${deploytarget})
        add_custom_target(${deploytarget})
      endif()

      if (MYLIBSEARCH_${libname}_${filename}_DLL)
        if(MYLIBSEARCH_${libname}_${filename}_DLL_DEBUG)
          add_custom_target(${deploytarget}_${libname}_${filename}
            COMMAND ${CMAKE_COMMAND} -E copy $<TARGET_PROPERTY:${libname}::${filename},IMPORTED_LOCATION> ${CMAKE_CURRENT_BINARY_DIR}/Release
            COMMAND ${CMAKE_COMMAND} -E copy $<TARGET_PROPERTY:${libname}::${filename},IMPORTED_LOCATION_DEBUG> ${CMAKE_CURRENT_BINARY_DIR}/Debug
          )
        else()
          add_custom_target(${deploytarget}_${libname}_${filename}
            COMMAND ${CMAKE_COMMAND} -E copy $<TARGET_PROPERTY:${libname}::${filename},IMPORTED_LOCATION> ${CMAKE_CURRENT_BINARY_DIR}/Release
            COMMAND ${CMAKE_COMMAND} -E copy $<TARGET_PROPERTY:${libname}::${filename},IMPORTED_LOCATION> ${CMAKE_CURRENT_BINARY_DIR}/Debug
          )
        endif()
        add_dependencies(${deploytarget} ${deploytarget}_${libname}_${filename})
        set_target_properties(${deploytarget}_${libname}_${filename} PROPERTIES FOLDER "${deploytarget} deps")
      endif()
    endif() 

  endforeach()

  add_library(${libname} INTERFACE)
  target_link_libraries(${libname} INTERFACE ${library_elements})
endfunction()


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