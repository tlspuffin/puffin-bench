cmake_minimum_required(VERSION 3.5.0)
project(gitrestapi)

set (CMAKE_CXX_STANDARD 17)

include(CMakeExternal.cmake)
include(CMakeTextEmbedding.cmake)

set(DEPS_BASE_DIR "${CMAKE_SOURCE_DIR}/third-party")

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

EmbedTextFileScript("${CMAKE_CURRENT_SOURCE_DIR}/scripts/tlspuffin_history.sh" "${CMAKE_SOURCE_DIR}/embeded/git_restapi/tlspuffin_history_sh.h" TLSPuffinHistory_Script)

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

set(SRV_SRC 
  src/git_restapi/config.cxx
  src/git_restapi/server/server.cxx src/git_restapi/server/config.cxx 
  src/git_restapi/server/request_handler.cxx src/git_restapi/server/parts_handler.cxx
  src/git_restapi/git/config.cxx src/git_restapi/git/git_api.cxx
  src/git_restapi/api/api.cxx
  src/utils/logs.cxx src/utils/rapidjson.cxx src/utils/dir.cxx src/utils/httpsclient.cxx
  ${CMAKE_SOURCE_DIR}/embeded/git_restapi/tlspuffin_history_sh.h
  ${GENERATED_VERSION_C}
)

add_library(git_restapi.lib STATIC ${SRV_SRC})
target_link_libraries(git_restapi.lib PUBLIC ${RapidjsonTN} ${PocoTN})
target_include_directories(git_restapi.lib PRIVATE ${CMAKE_SOURCE_DIR})
add_dependencies(git_restapi.lib generate_version)

add_executable(git_restapi src/git_restapi/main.cxx )
target_link_libraries(git_restapi PRIVATE git_restapi.lib)

add_executable(git_restapi-static src/git_restapi/main.cxx )
target_link_libraries(git_restapi-static PRIVATE git_restapi.lib)
target_link_options(git_restapi-static PRIVATE -static-libgcc -static-libstdc++)


