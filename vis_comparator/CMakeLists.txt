cmake_minimum_required(VERSION 3.5.0)
project(restsrv)

set (CMAKE_CXX_STANDARD 17)

include(CMakeUtils.cmake)

include(CMakeLists.conf)

if(DEFINED OPENSSL_PATH)
  GetLibs(openssl STATIC ${OPENSSL_PATH}  "ssl;crypto" openssllibs VERBOSE)
  CreateExternalLib(openssl "${openssllibs}" DEPLOYTARGET setupDLL)
endif()

GetLibs(Poco STATIC ${POCO_PATH} "PocoNetSSL;PocoCrypto;PocoNet;PocoUtil;PocoFoundation;PocoJSON" Pocolibs VERBOSE)
CreateExternalLib(Poco "${Pocolibs}" DEPLOYTARGET setupDLL)
if(DEFINED OPENSSL_PATH)
  target_link_libraries(Poco INTERFACE openssl)
else()
  target_link_libraries(Poco INTERFACE ssl crypto)
endif()

GetLibs(ZStd STATIC ${ZSTD_PATH} "zstd;zstdseek" ZStdLibs)
CreateExternalLib(ZStd "${ZStdLibs}" DEPLOYTARGET setupDLL)

find_package(LibArchive)

add_executable(analyze_results src/analyze_results.cxx)
target_include_directories(analyze_results PRIVATE ${RAPIDJSON_PATH})
add_executable(analyze_results-static src/analyze_results.cxx)
target_include_directories(analyze_results-static PRIVATE ${RAPIDJSON_PATH})
target_link_options(analyze_results-static PRIVATE -static)

set(ANALYZE_SRC
  src/analyze/main.cxx
  src/utils/rapidjson.cxx src/utils/variables.cxx src/utils/file.cxx src/utils/file_tgz.cxx src/utils/file_tar_zst.cxx src/utils/compress_tar_zst.cxx
  src/analyze/server/config.cxx src/analyze/server/server.cxx src/analyze/server/parts_handler.cxx src/analyze/server/request_handler.cxx 
  src/analyze/analyze/data_manager.cxx src/analyze/analyze/data.cxx src/analyze/analyze/statistics.cxx
)

add_executable(analyze ${ANALYZE_SRC})
target_link_libraries(analyze PRIVATE Poco ZStd LibArchive::LibArchive)
target_include_directories(analyze PRIVATE ${RAPIDJSON_PATH} ${CMAKE_CURRENT_BINARY_DIR})

