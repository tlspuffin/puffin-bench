cmake_minimum_required(VERSION 3.25.0)
project(restsrv)

include(FetchContent)

set (CMAKE_CXX_STANDARD 17)

include(CMakeUtils.cmake)
include(CMakeExternal.cmake)

#GetLibs(ZStd STATIC ${ZSTD_PATH} "zstdseek;zstd" ZStdLibs)
#CreateExternalLib(ZStd "${ZStdLibs}" DEPLOYTARGET setupDLL)

#if (DEFINED LIBARCHIVE_PATH)
#    GetLibs(LibArchive STATIC ${LIBARCHIVE_PATH} "archive" LibArchiveInfos)
#    CreateExternalLib(LibArchive "${LibArchiveInfos}" DEPLOYTARGET setupDLL)
#    set(ZLIB_USE_STATIC_LIBS ON)
#    find_package(ZLIB)
#    target_link_libraries(LibArchive INTERFACE ZLIB::ZLIB)
#    target_compile_definitions(LibArchive INTERFACE LIBARCHIVE_STATIC)
#    add_library(LibArchive::LibArchive ALIAS LibArchive)
#else()
#    find_package(LibArchive)
#endif()

block()
FetchContent_Declare(
  Poco
  GIT_REPOSITORY https://github.com/pocoproject/poco.git
  GIT_TAG        poco-1.14.2-release
)
set(BUILD_SHARED_LIBS OFF CACHE BOOL "" FORCE)
set(ENABLE_TESTS OFF CACHE BOOL "" FORCE)
set(ENABLE_SAMPLES OFF CACHE BOOL "" FORCE)
set(ENABLE_ENCODINGS OFF CACHE BOOL "" FORCE)
set(ENABLE_XML OFF CACHE BOOL "" FORCE)
set(ENABLE_ZIP OFF CACHE BOOL "" FORCE)
set(ENABLE_PAGECOMPILER OFF CACHE BOOL "" FORCE)
set(ENABLE_PAGECOMPILER_FILE2PAGE OFF CACHE BOOL "" FORCE)
set(ENABLE_DATA OFF CACHE BOOL "" FORCE)
set(ENABLE_DATA_SQLITE OFF CACHE BOOL "" FORCE)
set(ENABLE_DATA_MYSQL OFF CACHE BOOL "" FORCE)
set(ENABLE_DATA_POSTGRESQL OFF CACHE BOOL "" FORCE)
set(ENABLE_DATA_ODBC OFF CACHE BOOL "" FORCE)
set(ENABLE_MONGODB OFF CACHE BOOL "" FORCE)
set(ENABLE_REDIS OFF CACHE BOOL "" FORCE)
set(ENABLE_PDF OFF CACHE BOOL "" FORCE)
set(ENABLE_ACTIVERECORD OFF CACHE BOOL "" FORCE)
set(ENABLE_ACTIVERECORD_COMPILER OFF CACHE BOOL "" FORCE)
set(ENABLE_PROMETHEUS OFF CACHE BOOL "" FORCE)
FetchContent_MakeAvailable(Poco)
endblock()

block()
FetchContent_Declare(
  LibArchive
  GIT_REPOSITORY https://github.com/libarchive/libarchive.git
  GIT_TAG        v3.8.6
)
set(ENABLE_TAR OFF CACHE BOOL "" FORCE)
set(ENABLE_CPIO OFF CACHE BOOL "" FORCE)
set(ENABLE_CAT OFF CACHE BOOL "" FORCE)
set(ENABLE_UNZIP OFF CACHE BOOL "" FORCE)
set(ENABLE_TEST OFF CACHE BOOL "" FORCE)
set(BUILD_SHARED_LIBS OFF CACHE BOOL "" FORCE)
FetchContent_MakeAvailable(LibArchive)
endblock()

FetchExternalProject(
  NAME       RapidJSON
  GIT_URL    https://github.com/Tencent/rapidjson.git
  GIT_TAG    v1.1.0
  CMAKE_ARGS -DRAPIDJSON_BUILD_DOC=OFF
             -DRAPIDJSON_BUILD_EXAMPLES=OFF
             -DRAPIDJSON_BUILD_TESTS=OFF
)
GetLibs(RapidJSON HEADERSONLY ${RapidJSON_INSTALL_DIR} "rapidjson/rapidjson.h" _rapidjson_libs)
CreateExternalLib(RapidJSON "${_rapidjson_libs}")

block()
FetchContent_Declare(
  ZStd
  GIT_REPOSITORY https://github.com/facebook/zstd.git
  GIT_TAG        v1.5.7
  SOURCE_SUBDIR  build/cmake
)
set(ZSTD_BUILD_PROGRAMS OFF CACHE BOOL "" FORCE)
set(ZSTD_BUILD_TESTS OFF CACHE BOOL "" FORCE)
set(ZSTD_BUILD_SHARED OFF CACHE BOOL "" FORCE)
set(ZSTD_BUILD_STATIC ON  CACHE BOOL "" FORCE)
FetchContent_MakeAvailable(ZStd)
add_library(zstdseek STATIC ${zstd_SOURCE_DIR}/contrib/seekable_format/zstdseek_compress.c ${zstd_SOURCE_DIR}/contrib/seekable_format/zstdseek_decompress.c)
target_include_directories(zstdseek PUBLIC ${zstd_SOURCE_DIR}/contrib/seekable_format ${zstd_SOURCE_DIR}/lib/common)
target_link_libraries(zstdseek PUBLIC libzstd_static)
endblock()

set(CMAKE_RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}" CACHE STRING "" FORCE)

add_executable(analyze_results src/analyze_results.cxx)
target_link_libraries(analyze_results PRIVATE RapidJSON)
add_executable(analyze_results-static src/analyze_results.cxx)
target_link_libraries(analyze_results-static PRIVATE RapidJSON)
target_link_options(analyze_results-static PRIVATE -static)

set(ANALYZE_SRC
  src/analyze/main.cxx
  src/utils/rapidjson.cxx src/utils/variables.cxx src/utils/file.cxx src/utils/file_tgz.cxx src/utils/file_tar_zst.cxx src/utils/compress_tar_zst.cxx
  src/analyze/server/config.cxx src/analyze/server/server.cxx src/analyze/server/parts_handler.cxx src/analyze/server/request_handler.cxx
  src/analyze/analyze/config.cxx src/analyze/analyze/data_manager.cxx src/analyze/analyze/statistics.cxx
)

add_executable(analyze ${ANALYZE_SRC})
target_link_libraries(analyze PRIVATE RapidJSON Poco::NetSSL Poco::Crypto Poco::Net Poco::Util Poco::Foundation Poco::JSON zstdseek archive_static)
target_include_directories(analyze PRIVATE ${CMAKE_CURRENT_BINARY_DIR})

add_executable(analyze-static ${ANALYZE_SRC})
target_link_libraries(analyze-static PRIVATE RapidJSON Poco::NetSSL Poco::Crypto Poco::Net Poco::Util Poco::Foundation Poco::JSON zstdseek archive_static)
target_include_directories(analyze-static PRIVATE ${CMAKE_CURRENT_BINARY_DIR})
target_link_options(analyze-static PRIVATE -static-libgcc -static-libstdc++)

