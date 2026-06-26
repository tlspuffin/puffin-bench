cmake_minimum_required(VERSION 3.5.0)
project(publisher)

set (CMAKE_CXX_STANDARD 17)

include(CMakeExternal.cmake)
include(CMakeTextEmbedding.cmake)
include(CMakeBinaryEmbedding.cmake)

set(DEPS_BASE_DIR "${CMAKE_SOURCE_DIR}/third-party")

get_property(IS_MULTI_CONFIG GLOBAL PROPERTY GENERATOR_IS_MULTI_CONFIG)
if(NOT CMAKE_BUILD_TYPE AND NOT IS_MULTI_CONFIG)
  set(CMAKE_BUILD_TYPE "Release" CACHE STRING "Choose the type of build." FORCE)
  set_property(CACHE CMAKE_BUILD_TYPE PROPERTY STRINGS "Debug" "Release" "RelWithDebInfo" "MinSizeRel")
endif()

EmbedBinaryFile("${CMAKE_CURRENT_SOURCE_DIR}/html/third-party/plotly/plotly-3.3.0.min.js" "${CMAKE_SOURCE_DIR}/embeded/publisher/html/third-party/plotly/plotly_3_3_0_min_js.h" Publisher_HTML_Ploty_JS)

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

EmbedTextFileScript("${CMAKE_CURRENT_SOURCE_DIR}/html/publisher/summary_config.js" "${CMAKE_SOURCE_DIR}/embeded/publisher/html/summary_config_js.h" Publisher_HTML_SummaryConfig_JS)
EmbedTextFileScript("${CMAKE_CURRENT_SOURCE_DIR}/html/publisher/summary.html" "${CMAKE_SOURCE_DIR}/embeded/publisher/html/summary_html.h" Publisher_HTML_Summary_HTML)
EmbedTextFileScript("${CMAKE_CURRENT_SOURCE_DIR}/html/publisher/summary.css" "${CMAKE_SOURCE_DIR}/embeded/publisher/html/summary_css.h" Publisher_HTML_Summary_CSS)
EmbedTextFileScript("${CMAKE_CURRENT_SOURCE_DIR}/html/publisher/summary.js" "${CMAKE_SOURCE_DIR}/embeded/publisher/html/summary_js.h" Publisher_HTML_Summary_JS)
EmbedTextFileScript("${CMAKE_CURRENT_SOURCE_DIR}/html/publisher/summary_render.js" "${CMAKE_SOURCE_DIR}/embeded/publisher/html/summary_render_js.h" Publisher_HTML_SummaryRender_JS)
EmbedTextFileScript("${CMAKE_CURRENT_SOURCE_DIR}/html/publisher/summary_data.js" "${CMAKE_SOURCE_DIR}/embeded/publisher/html/summary_data_js.h" Publisher_HTML_SummaryData_JS)
EmbedTextFileScript("${CMAKE_CURRENT_SOURCE_DIR}/html/publisher/summary_metrics.js" "${CMAKE_SOURCE_DIR}/embeded/publisher/html/summary_metrics_js.h" Publisher_HTML_SummaryMetrics_JS)
EmbedTextFileScript("${CMAKE_CURRENT_SOURCE_DIR}/html/publisher/summary_metricscampaign.js" "${CMAKE_SOURCE_DIR}/embeded/publisher/html/summary_metricscampaign_js.h" Publisher_HTML_SummaryMetricsCampaign_JS)
EmbedTextFileScript("${CMAKE_CURRENT_SOURCE_DIR}/html/publisher/summary_graph.js" "${CMAKE_SOURCE_DIR}/embeded/publisher/html/summary_graph_js.h" Publisher_HTML_SummaryGraph_JS)
EmbedTextFileScript("${CMAKE_CURRENT_SOURCE_DIR}/html/publisher/summary_managegraphs.js" "${CMAKE_SOURCE_DIR}/embeded/publisher/html/summary_managegraphs_js.h" Publisher_HTML_SummaryManageGraphs_JS)
EmbedTextFileScript("${CMAKE_CURRENT_SOURCE_DIR}/html/publisher/summary_graphoverview.js" "${CMAKE_SOURCE_DIR}/embeded/publisher/html/summary_graphoverview_js.h" Publisher_HTML_SummaryGraphOverview_JS)
EmbedTextFileScript("${CMAKE_CURRENT_SOURCE_DIR}/html/publisher/summary_graphoverview.css" "${CMAKE_SOURCE_DIR}/embeded/publisher/html/summary_graphoverview_css.h" Publisher_HTML_SummaryGraphOverview_CSS)
EmbedTextFileScript("${CMAKE_CURRENT_SOURCE_DIR}/html/publisher/summary_graphcompare.js" "${CMAKE_SOURCE_DIR}/embeded/publisher/html/summary_graphcompare_js.h" Publisher_HTML_SummaryGraphCompare_JS)
EmbedTextFileScript("${CMAKE_CURRENT_SOURCE_DIR}/html/publisher/summary_graphmetrics.js" "${CMAKE_SOURCE_DIR}/embeded/publisher/html/summary_graphmetrics_js.h" Publisher_HTML_SummaryGraphMetrics_JS)
EmbedTextFileScript("${CMAKE_CURRENT_SOURCE_DIR}/html/publisher/summary_graphmetrics.css" "${CMAKE_SOURCE_DIR}/embeded/publisher/html/summary_graphmetrics_css.h" Publisher_HTML_SummaryGraphMetrics_CSS)

set(PUBLISHER_SRC
  src/utils/logs.cxx src/utils/rapidjson.cxx src/utils/file_compressed.cxx src/utils/compress_tar_zst.cxx src/utils/dir.cxx src/utils/variables.cxx
  src/publisher/config.cxx 
  src/publisher/server/config.cxx src/publisher/server/server.cxx 
  src/publisher/server/parts_handler.cxx src/publisher/server/request_handler.cxx 
  src/publisher/publish/config.cxx src/publisher/publish/publish.cxx src/publisher/publish/project.cxx src/publisher/publish/index.cxx 
  src/publisher/publish/rule.cxx src/publisher/publish/rule_mergeJSON.cxx
  src/publisher/publish/zst/generate_perf_zst.cxx 
  ${CMAKE_SOURCE_DIR}/embeded/publisher/html/summary_html.h ${CMAKE_SOURCE_DIR}/embeded/publisher/html/summary_css.h 
  ${CMAKE_SOURCE_DIR}/embeded/publisher/html/summary_js.h ${CMAKE_SOURCE_DIR}/embeded/publisher/html/summary_render_js.h ${CMAKE_SOURCE_DIR}/embeded/publisher/html/summary_data_js.h 
  ${CMAKE_SOURCE_DIR}/embeded/publisher/html/summary_metrics_js.h ${CMAKE_SOURCE_DIR}/embeded/publisher/html/summary_metricscampaign_js.h 
  ${CMAKE_SOURCE_DIR}/embeded/publisher/html/summary_graph_js.h ${CMAKE_SOURCE_DIR}/embeded/publisher/html/summary_managegraphs_js.h 
  ${CMAKE_SOURCE_DIR}/embeded/publisher/html/summary_graphoverview_js.h ${CMAKE_SOURCE_DIR}/embeded/publisher/html/summary_graphoverview_css.h 
  ${CMAKE_SOURCE_DIR}/embeded/publisher/html/summary_graphcompare_js.h
  ${CMAKE_SOURCE_DIR}/embeded/publisher/html/summary_graphmetrics_js.h ${CMAKE_SOURCE_DIR}/embeded/publisher/html/summary_graphmetrics_css.h 
  ${CMAKE_SOURCE_DIR}/embeded/publisher/html/summary_config_js.h
  ${CMAKE_SOURCE_DIR}/embeded/publisher/html/third-party/plotly/plotly_3_3_0_min_js.h ${GENERATED_VERSION_C}
)

add_library(publisher.lib STATIC ${PUBLISHER_SRC})
target_link_libraries(publisher.lib PUBLIC ${RapidjsonTN} ${PocoTN} ${LibArchiveTN} ZStdSeekable)
target_include_directories(publisher.lib PRIVATE ${CMAKE_SOURCE_DIR})
add_dependencies(publisher.lib generate_version)

add_executable(publisher src/publisher/main.cxx)
target_link_libraries(publisher PRIVATE publisher.lib)

add_executable(publisher-static src/publisher/main.cxx)
target_link_libraries(publisher-static PRIVATE publisher.lib)
target_link_options(publisher-static PRIVATE -static-libgcc -static-libstdc++)
