cmake_minimum_required(VERSION 3.5.0)
project(scheduler)

set (CMAKE_CXX_STANDARD 17)

include(CMakeExternal.cmake)
include(CMakeTextEmbedding.cmake)
include(CMakeBinaryEmbedding.cmake)
include(CMakeDirectoryEmbedding.cmake)

set(DEPS_BASE_DIR "${CMAKE_SOURCE_DIR}/third-party")

get_property(IS_MULTI_CONFIG GLOBAL PROPERTY GENERATOR_IS_MULTI_CONFIG)
if(NOT CMAKE_BUILD_TYPE AND NOT IS_MULTI_CONFIG)
  set(CMAKE_BUILD_TYPE "Release" CACHE STRING "Choose the type of build." FORCE)
  set_property(CACHE CMAKE_BUILD_TYPE PROPERTY STRINGS "Debug" "Release" "RelWithDebInfo" "MinSizeRel")
endif()

set(IN_VERSION_C "${CMAKE_CURRENT_SOURCE_DIR}/src/version.c.in")
set(GENERATED_VERSION_C "${CMAKE_BINARY_DIR}/version.c")
if (NOT TARGET generate_version)
  add_custom_target(generate_version ALL
      COMMAND ${CMAKE_COMMAND} -DINPUT=${IN_VERSION_C} -DOUTPUT=${GENERATED_VERSION_C} -P ${CMAKE_CURRENT_SOURCE_DIR}/CMakeGenVersion.cmake
      BYPRODUCTS ${GENERATED_VERSION_C}
      VERBATIM
  )
else()
  set_source_files_properties(${GENERATED_VERSION_C} PROPERTIES GENERATED TRUE)
endif()

FetchAndCreateExternalLib(
  NAME          zlib
  OUTPUT_TARGET zlibTN
  GIT_URL       https://github.com/madler/zlib.git
  GIT_TAG       v1.3.2
  CMAKE_ARGS    "-DZLIB_BUILD_SHARED=OFF;-DZLIB_BUILD_TESTING=OFF"
  LIBTYPE       STATIC
  HEADERSAMPLE  "zlib.h"
  REQUIREDLIBS  "z"
  #VERBOSE
)

set(OPENSSL_SEARCH_ROOT "/usr/lib" CACHE PATH "openssl lib search path")
set(OPENSSL_SEARCH_ROOT_INCLUDE "/usr/include" CACHE PATH "openssl include search path")
set(OPENSSL_MODE "STATIC" CACHE STRING "STATIC or SHARED openssl lib to be used")
set_property(CACHE OPENSSL_MODE PROPERTY STRINGS STATIC SHARED)
GetLibs("OpenSSL" "${OPENSSL_MODE}" "${OPENSSL_SEARCH_ROOT}" "ssl;crypto" FOUND_OPENSSL_LIST HEADERSSEARCHPATH "${OPENSSL_SEARCH_ROOT_INCLUDE}" HEADERSAMPLE "openssl/ssl.h" VERBOSE)
if(NOT FOUND_OPENSSL_LIST STREQUAL "NOT-FOUND")
  CreateExternalLib("OpenSSL" "${FOUND_OPENSSL_LIST}" DEPLOYTARGET "dllSetup")
else()
  message(FATAL_ERROR "Unable to find ${OPENSSL_MODE} lib OpenSSL.")
endif()
PrintTargetProperties(OpenSSL)

set(POCO_CMAKE_ARGS
    "-DENABLE_ENCODINGS=OFF"
    "-DENABLE_XML=OFF"
    "-DENABLE_JSON=ON"
    "-DENABLE_REDIS=OFF"
    "-DENABLE_PROMETHEUS=OFF"
    "-DENABLE_JWT=OFF"
    "-DENABLE_ACTIVERECORD=OFF"
    "-DENABLE_ACTIVERECORD_COMPILER=OFF"
    "-DENABLE_PAGECOMPILER=OFF"
    "-DENABLE_PAGECOMPILER_FILE2PAGE=OFF"
    "-DENABLE_NETSSL=ON"
    "-DENABLE_CRYPTO=ON"
    "-DENABLE_DATA=OFF"
    "-DENABLE_DATA_MYSQL=OFF"
    "-DENABLE_DATA_ODBC=OFF"
    "-DENABLE_DATA_POSTGRESQL=OFF"
    "-DENABLE_DATA_SQLITE=OFF"
    "-DENABLE_ZIP=OFF"
    "-DENABLE_MONGODB=OFF"
    "-DBUILD_SHARED_LIBS=OFF"
    "-DOPENSSL_INCLUDE_DIR=${MYLIBSEARCH_OpenSSL_HEADERS}"
    "-DOPENSSL_CRYPTO_LIBRARY=${MYLIBSEARCH_OpenSSL_crypto}"
    "-DOPENSSL_SSL_LIBRARY=${MYLIBSEARCH_OpenSSL_ssl}"
)
set(POCO_LIBS "PocoNetSSL;PocoNet;PocoUtil;PocoCrypto;PocoFoundation;PocoJSON")
FetchAndCreateExternalLib(
  NAME           Poco
  OUTPUT_TARGET  PocoTN
  GIT_URL        https://github.com/pocoproject/poco.git
  GIT_TAG        poco-1.14.2-release
  CMAKE_ARGS     "${POCO_CMAKE_ARGS}"
  LIBTYPE        STATIC
  REQUIREDLIBS   "${POCO_LIBS}"
  COMPILE_DEFINITIONS "POCO_STATIC;POCO_NO_AUTOMATIC_LIBS"
  LINK_LIBRARIES "OpenSSL"
  #VERBOSE
)

set(RAPIDJSON_CMAKE_ARGS
    "-DBUILD_TESTING=OFF"
    "-DRAPIDJSON_BUILD_ASAN=OFF"
    "-DRAPIDJSON_BUILD_CXX11=OFF"
    "-DRAPIDJSON_BUILD_DOC=OFF"
    "-DRAPIDJSON_BUILD_EXAMPLES=OFF"
    "-DRAPIDJSON_BUILD_THIRDPARTY_GTEST=OFF"
    "-DRAPIDJSON_BUILD_UBSAN=OFF"
)
FetchAndCreateExternalLib(
  NAME          Rapidjson
  OUTPUT_TARGET RapidjsonTN
  GIT_URL       https://github.com/Tencent/rapidjson
  GIT_TAG       v1.1.0
  CMAKE_ARGS    "${RAPIDJSON_CMAKE_ARGS}"
  LIBTYPE       HEADERSONLY
  HEADERSAMPLE "rapidjson/document.h"
  #VERBOSE
)

set(LIBARCHIVE_CMAKE_ARGS
    "-DBUILD_SHARED_LIBS=OFF"
    "-DBUILD_TESTING=OFF"
    "-DENABLE_BZip2=OFF"
    "-DENABLE_LIBXML2=OFF"
    "-DENABLE_LZ4=OFF"
    "-DENABLE_LZMA=OFF"
    "-DENABLE_OPENSSL=OFF"
    "-DENABLE_TEST=OFF"
    "-DENABLE_ZSTD=OFF"
    "-DENABLE_ACL=OFF"
)
AppendCMakeArgs(LIBARCHIVE_CMAKE_ARGS "ZLIB_INCLUDE_DIR;ZLIB_LIBRARY_RELEASE;ZLIB_LIBRARY_DEBUG" ${zlibTN}::z)
FetchAndCreateExternalLib(
  NAME           LibArchive
  OUTPUT_TARGET  LibArchiveTN
  GIT_URL        https://github.com/libarchive/libarchive.git
  GIT_TAG        v3.8.7
  CMAKE_ARGS     ${LIBARCHIVE_CMAKE_ARGS}
  LIBTYPE        STATIC
  HEADERSAMPLE   "archive.h"
  REQUIREDLIBS   "archive"
  LINK_LIBRARIES "${zlibTN}"
  #VERBOSE
)

EmbedTextFileScript("${CMAKE_CURRENT_SOURCE_DIR}/scripts/executor.sh" "${CMAKE_SOURCE_DIR}/embeded/scheduler/scripts/executor_sh.h" Executor_Script)
EmbedTextFileScript("${CMAKE_CURRENT_SOURCE_DIR}/scripts/functions.sh" "${CMAKE_SOURCE_DIR}/embeded/scheduler/scripts/functions_sh.h" Functions_Script)

EmbedTextFileScript("${CMAKE_CURRENT_SOURCE_DIR}/html/board/logsmanager.js" "${CMAKE_SOURCE_DIR}/embeded/scheduler/html/board/logsmanager_js.h" LogsManager_JS)
EmbedTextFileScript("${CMAKE_CURRENT_SOURCE_DIR}/html/board/terminal.js" "${CMAKE_SOURCE_DIR}/embeded/scheduler/html/board/terminal_js.h" Terminal_JS)
EmbedTextFileScript("${CMAKE_CURRENT_SOURCE_DIR}/html/board/clipboard.js" "${CMAKE_SOURCE_DIR}/embeded/scheduler/html/board/clipboard_js.h" Clipboard_JS)
EmbedTextFileScript("${CMAKE_CURRENT_SOURCE_DIR}/html/board/board.html" "${CMAKE_SOURCE_DIR}/embeded/scheduler/html/board/board_html.h" Board_HTML)
EmbedTextFileScript("${CMAKE_CURRENT_SOURCE_DIR}/html/board/board.css" "${CMAKE_SOURCE_DIR}/embeded/scheduler/html/board/board_css.h" Board_CSS)
EmbedTextFileScript("${CMAKE_CURRENT_SOURCE_DIR}/html/board/board.js" "${CMAKE_SOURCE_DIR}/embeded/scheduler/html/board/board_js.h" Board_JS)
EmbedTextFileScript("${CMAKE_CURRENT_SOURCE_DIR}/html/board/taskcard.css" "${CMAKE_SOURCE_DIR}/embeded/scheduler/html/board/taskcard_css.h" TaskCard_CSS)
EmbedTextFileScript("${CMAKE_CURRENT_SOURCE_DIR}/html/board/taskcard.js" "${CMAKE_SOURCE_DIR}/embeded/scheduler/html/board/taskcard_js.h" TaskCard_JS)
EmbedTextFileScript("${CMAKE_CURRENT_SOURCE_DIR}/html/board/launchers/launchers.css" "${CMAKE_SOURCE_DIR}/embeded/scheduler/html/board/launchers/launchers_css.h" Launchers_CSS)
EmbedTextFileScript("${CMAKE_CURRENT_SOURCE_DIR}/html/board/launchers/launchers.js" "${CMAKE_SOURCE_DIR}/embeded/scheduler/html/board/launchers/launchers_js.h" Launchers_JS)
EmbedTextFileScript("${CMAKE_CURRENT_SOURCE_DIR}/html/board/task.html" "${CMAKE_SOURCE_DIR}/embeded/scheduler/html/board/task_html.h" Task_HTML)
EmbedTextFileScript("${CMAKE_CURRENT_SOURCE_DIR}/html/board/task.css" "${CMAKE_SOURCE_DIR}/embeded/scheduler/html/board/task_css.h" Task_CSS)
EmbedTextFileScript("${CMAKE_CURRENT_SOURCE_DIR}/html/board/task.js" "${CMAKE_SOURCE_DIR}/embeded/scheduler/html/board/task_js.h" Task_JS)
EmbedTextFileScript("${CMAKE_CURRENT_SOURCE_DIR}/html/board/history.html" "${CMAKE_SOURCE_DIR}/embeded/scheduler/html/board/history_html.h" History_HTML)
EmbedTextFileScript("${CMAKE_CURRENT_SOURCE_DIR}/html/board/history.css" "${CMAKE_SOURCE_DIR}/embeded/scheduler/html/board/history_css.h" History_CSS)
EmbedTextFileScript("${CMAKE_CURRENT_SOURCE_DIR}/html/board/history.js" "${CMAKE_SOURCE_DIR}/embeded/scheduler/html/board/history_js.h" History_JS)

set(SCHEDULER_SRC 
  src/scheduler/config.cxx 
  src/utils/logs.cxx src/utils/rapidjson.cxx src/utils/variables.cxx src/utils/file.cxx src/utils/md5_poco.cxx src/utils/file_compressed.cxx src/utils/dir.cxx
  src/scheduler/server/config.cxx src/scheduler/server/server.cxx src/scheduler/server/parts_handler.cxx src/scheduler/server/request_handler.cxx 
  src/scheduler/schedule/config.cxx src/scheduler/schedule/schedule.cxx src/scheduler/schedule/task.cxx src/scheduler/schedule/step.cxx 
  src/scheduler/schedule/tasksmanager.cxx src/scheduler/schedule/step_configurations.cxx src/scheduler/schedule/publish.cxx
  src/scheduler/schedule/executor/config.cxx src/scheduler/schedule/executor/executor.cxx src/scheduler/schedule/executor/local.cxx 
  src/scheduler/schedule/executor/output_ring.cxx
  src/scheduler/system/linux_cores.cxx src/scheduler/system/linux_process.cxx src/scheduler/system/linux_memory.cxx 
  src/scheduler/system/linux.cxx
  src/scheduler/api/schedule_api.cxx src/scheduler/api/users_api.cxx
  src/scheduler/cache/config.cxx src/scheduler/cache/cache.cxx
  src/scheduler/schedule/monitor/monitor.cxx src/scheduler/schedule/monitor/task.cxx
  src/scheduler/schedule/archiver.cxx
  ${CMAKE_SOURCE_DIR}/embeded/scheduler/scripts/executor_sh.h ${CMAKE_SOURCE_DIR}/embeded/scheduler/scripts/functions_sh.h
  ${CMAKE_SOURCE_DIR}/embeded/scheduler/html/board/logsmanager_js.h ${CMAKE_SOURCE_DIR}/embeded/scheduler/html/board/terminal_js.h ${CMAKE_SOURCE_DIR}/embeded/scheduler/html/board/clipboard_js.h 
  ${CMAKE_SOURCE_DIR}/embeded/scheduler/html/board/board_html.h ${CMAKE_SOURCE_DIR}/embeded/scheduler/html/board/board_css.h ${CMAKE_SOURCE_DIR}/embeded/scheduler/html/board/board_js.h 
  ${CMAKE_SOURCE_DIR}/embeded/scheduler/html/board/taskcard_css.h ${CMAKE_SOURCE_DIR}/embeded/scheduler/html/board/taskcard_js.h 
  ${CMAKE_SOURCE_DIR}/embeded/scheduler/html/board/launchers/launchers_css.h ${CMAKE_SOURCE_DIR}/embeded/scheduler/html/board/launchers/launchers_js.h 
  ${CMAKE_SOURCE_DIR}/embeded/scheduler/html/board/history_html.h ${CMAKE_SOURCE_DIR}/embeded/scheduler/html/board/history_css.h ${CMAKE_SOURCE_DIR}/embeded/scheduler/html/board/history_js.h 
  ${CMAKE_SOURCE_DIR}/embeded/scheduler/html/board/task_html.h ${CMAKE_SOURCE_DIR}/embeded/scheduler/html/board/task_css.h ${CMAKE_SOURCE_DIR}/embeded/scheduler/html/board/task_js.h 
  ${GENERATED_VERSION_C}
)

add_library(scheduler.lib STATIC ${SCHEDULER_SRC})
target_link_libraries(scheduler.lib PUBLIC ${RapidjsonTN} ${PocoTN} ${LibArchiveTN})
target_include_directories(scheduler.lib PRIVATE ${CMAKE_SOURCE_DIR})
add_dependencies(scheduler.lib generate_version)

add_executable(scheduler src/scheduler/main.cxx)
target_link_libraries(scheduler PRIVATE scheduler.lib)

add_executable(scheduler-static src/scheduler/main.cxx)
target_link_libraries(scheduler-static PRIVATE scheduler.lib)
target_link_options(scheduler-static PRIVATE -static-libgcc -static-libstdc++)

add_executable(testcpu src/cpu.cxx src/scheduler/system/linux_cores.cxx)

add_executable(testFilesRing src/test_files_ring.cxx src/scheduler/schedule/executor/output_ring.cxx src/utils/logs.cxx )
add_executable(testOutputRing src/test_output_ring.cxx src/scheduler/schedule/executor/output_ring.cxx src/utils/logs.cxx )
