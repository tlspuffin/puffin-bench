cmake_minimum_required(VERSION 3.5.0)
project(restsrv)

set (CMAKE_CXX_STANDARD 17)

include(CMakeUtils.cmake)

include(CMakeLists.conf)

find_program(XXD xxd REQUIRED)

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

if (DEFINED LIBARCHIVE_PATH)
    GetLibs(LibArchive STATIC ${LIBARCHIVE_PATH} "archive" LibArchiveInfos)
    CreateExternalLib(LibArchive "${LibArchiveInfos}" DEPLOYTARGET setupDLL)
    set(ZLIB_USE_STATIC_LIBS ON)
    find_package(ZLIB)
    target_link_libraries(LibArchive INTERFACE ZLIB::ZLIB)
    target_compile_definitions(LibArchive INTERFACE LIBARCHIVE_STATIC)
    add_library(LibArchive::LibArchive ALIAS LibArchive)
else()
    find_package(LibArchive)
endif()

#EmbedTextFileScript("${CMAKE_SOURCE_DIR}/html/publisher/index.html" "${CMAKE_SOURCE_DIR}/src/embeded/publisher/index_html.h" Publisher_Index)
#EmbedTextFileScript("${CMAKE_SOURCE_DIR}/html/publisher/index.css" "${CMAKE_SOURCE_DIR}/src/embeded/publisher/index_css.h" Publisher_CSS)
#EmbedTextFileScript("${CMAKE_SOURCE_DIR}/html/publisher/index.js" "${CMAKE_SOURCE_DIR}/src/embeded/publisher/index_js.h" Publisher_JS)
EmbedTextFileScript("${CMAKE_SOURCE_DIR}/scripts/tlspuffin_history.sh" "${CMAKE_SOURCE_DIR}/src/embeded/publisher/tlspuffin_history_sh.h" Publisher_Trigger_tlspuffin_history)

set(PUBLISHER_SRC
  src/utils/rapidjson.cxx src/utils/time.cxx src/utils/file_tgz.cxx src/utils/variables.cxx
  src/publisher/config.cxx 
  src/publisher/server/config.cxx src/publisher/server/server.cxx 
  src/publisher/server/parts_handler.cxx src/publisher/server/request_handler.cxx 
  src/publisher/publish/config.cxx src/publisher/publish/index.cxx src/publisher/publish/publish.cxx 
  src/publisher/publish/publish_action.cxx src/publisher/publish/publish_action_perf.cxx src/publisher/publish/publish_action_vuln.cxx 
  src/publisher/publish/publish_action_perf_summary.cxx src/publisher/publish/publish_action_vuln2.cxx 
  src/publisher/publish/publish_action_vuln3.cxx
  #src/embeded/publisher/index_html.h src/embeded/publisher/index_css.h src/embeded/publisher/index_js.h
  src/embeded/publisher/tlspuffin_history_sh.h
)

add_executable(publisher src/publisher/main.cxx ${PUBLISHER_SRC})
target_link_libraries(publisher PRIVATE Poco LibArchive::LibArchive)
target_include_directories(publisher PRIVATE ${RAPIDJSON_PATH})

add_executable(publisher-static src/publisher/main.cxx ${PUBLISHER_SRC})
target_link_libraries(publisher-static PRIVATE Poco LibArchive::LibArchive)
target_include_directories(publisher-static PRIVATE ${RAPIDJSON_PATH})
target_link_options(publisher-static PRIVATE -static)

add_executable(test00 src/test00.cxx ${PUBLISHER_SRC})
target_link_libraries(test00 PRIVATE Poco LibArchive::LibArchive)
target_include_directories(test00 PRIVATE ${RAPIDJSON_PATH})
