cmake_minimum_required(VERSION 3.25.0)
project(vis_comparator)

set (CMAKE_CXX_STANDARD 17)

include(CMakeExternal.cmake)
include(CMakeTextEmbedding.cmake)

set(DEPS_BASE_DIR "${CMAKE_SOURCE_DIR}/third-party")

find_program(XXD xxd REQUIRED)
set(VISCOMPARATOR_PLOTLYJS_BLOB_H "plotly_3_3_0_min_js.h")
add_custom_command(
  OUTPUT ${VISCOMPARATOR_PLOTLYJS_BLOB_H}
  COMMAND ${CMAKE_COMMAND} -E env
          OUT=${VISCOMPARATOR_PLOTLYJS_BLOB_H}
          sh -c "${XXD} -i -n VisComparator_HTML_Ploty_JS \"${CMAKE_CURRENT_SOURCE_DIR}/html/third-party/plotly/plotly-3.3.0.min.js\" > \"${VISCOMPARATOR_PLOTLYJS_BLOB_H}\""
  COMMENT "Generating ${VISCOMPARATOR_PLOTLYJS_BLOB_H} from reserve_port with xxd -i"
  VERBATIM
)
add_custom_target(viscomparator_plotly_3_3_0_min_js_h DEPENDS ${VISCOMPARATOR_PLOTLYJS_BLOB_H})

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

# Auto-detect OpenSSL, attempt system install if missing
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
set(POCO_LIBS "PocoNet;PocoNetSSL;PocoUtil;PocoCrypto;PocoFoundation;PocoJSON")
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

set(ZSTD_CMAKE_ARGS
    "-DZSTD_BUILD_PROGRAMS=OFF"
    "-DZSTD_BUILD_SHARED=OFF"
    "-DZSTD_BUILD_STATIC=ON"
    "-DZSTD_BUILD_TESTS=OFF"
    "-DZSTD_MULTITHREAD_SUPPORT=ON"
)
FetchAndCreateExternalLib(
  NAME          ZStd
  OUTPUT_TARGET ZStdTN
  GIT_URL       https://github.com/facebook/zstd
  GIT_TAG       v1.5.7
  CMAKE_PATH    "build/cmake"
  CMAKE_ARGS    ${ZSTD_CMAKE_ARGS}
  LIBTYPE       STATIC
  HEADERSAMPLE  "zstd.h"
  REQUIREDLIBS  "zstd"
  #VERBOSE
)

if (NOT TARGET ZStdSeekable)
  add_library(ZStdSeekable STATIC
      "${${ZStdTN}_SOURCE_DIR}/contrib/seekable_format/zstdseek_compress.c"
      "${${ZStdTN}_SOURCE_DIR}/contrib/seekable_format/zstdseek_decompress.c")
  target_include_directories(ZStdSeekable PRIVATE "${${ZStdTN}_SOURCE_DIR}/lib/common")
  target_include_directories(ZStdSeekable INTERFACE "${${ZStdTN}_SOURCE_DIR}/contrib/seekable_format")
  target_link_libraries(ZStdSeekable PUBLIC ${ZStdTN})
endif()


# The shared EmbeddedFile descriptor is hardcoded as an include by the generated
# aggregate headers (see CMakeTextEmbedding.cmake) and by config.cxx.
file(WRITE "${CMAKE_SOURCE_DIR}/embeded/vis_comparator/embedded_file.h"
        "/* Shared descriptor for files embedded via EmbedDirAsArray (CMakeTextEmbedding.cmake). */\n"
        "#pragma once\n"
        "#include <cstddef>\n"
        "\n"
        "struct EmbeddedFile {\n"
        "  char const* name;  // path relative to the group's base dir (e.g. \"js/ui.js\")\n"
        "  char const* data;\n"
        "  size_t size;\n"
        "};\n")

# Auto-discover and embed whole directories into one aggregated header each.
# Adding/removing a file in either source tree is picked up automatically (no edits here).
set(VISCOMPARATOR_WEBASSETS_HEADER "${CMAKE_SOURCE_DIR}/embeded/vis_comparator/webassets_all.h")
set(VISCOMPARATOR_TEMPLATES_HEADER "${CMAKE_SOURCE_DIR}/embeded/vis_comparator/templates/templates_all.h")

EmbedDirAsArray("${CMAKE_CURRENT_SOURCE_DIR}/html/vis_comparator"
  "${VISCOMPARATOR_WEBASSETS_HEADER}" VisComparator_WebAssets
  "*.html" "*.css" "*.js")
EmbedDirAsArray("${CMAKE_CURRENT_SOURCE_DIR}/samples/users_data/vis_comparator/templates"
  "${VISCOMPARATOR_TEMPLATES_HEADER}" VisComparator_Templates
  "*.json")

set(ANALYZE_SRC
  src/analyze/config.cxx 
  src/utils/rapidjson.cxx src/utils/variables.cxx src/utils/file.cxx src/utils/file_tgz.cxx src/utils/file_tar_zst.cxx src/utils/compress_tar_zst.cxx
  src/analyze/server/config.cxx src/analyze/server/server.cxx src/analyze/server/parts_handler.cxx src/analyze/server/request_handler.cxx
  src/analyze/analyze/config.cxx src/analyze/analyze/data_manager.cxx src/analyze/analyze/statistics.cxx

  ${VISCOMPARATOR_WEBASSETS_HEADER}
  ${VISCOMPARATOR_TEMPLATES_HEADER}

  ${GENERATED_VERSION_C}
)

add_library(vis_comparator.lib STATIC ${ANALYZE_SRC})
target_link_libraries(vis_comparator.lib PUBLIC ${RapidjsonTN} ${PocoTN} ${LibArchiveTN} ZStdSeekable)
target_include_directories(vis_comparator.lib PRIVATE ${CMAKE_SOURCE_DIR} ${CMAKE_CURRENT_BINARY_DIR})
add_dependencies(vis_comparator.lib generate_version viscomparator_plotly_3_3_0_min_js_h)

add_executable(vis_comparator src/analyze/main.cxx)
target_link_libraries(vis_comparator PRIVATE vis_comparator.lib)

add_executable(vis_comparator-static src/analyze/main.cxx)
target_link_libraries(vis_comparator-static PRIVATE vis_comparator.lib)
target_link_options(vis_comparator-static PRIVATE -static-libgcc -static-libstdc++)

