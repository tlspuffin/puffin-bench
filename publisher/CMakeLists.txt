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


EmbedTextFile("scripts/executor.sh" 
  "${CMAKE_CURRENT_SOURCE_DIR}/src/scheduler/schedule/executor/embeded/executor_sh.h" Executor_Script)
EmbedTextFile("scripts/get_file.sh" 
  "${CMAKE_CURRENT_SOURCE_DIR}/src/scheduler/schedule/executor/embeded/get_file_sh.h" GetFile_Script)

set(SRV_SRC 
  src/scheduler/main.cxx src/scheduler/config.cxx 
  src/scheduler/server/config.cxx src/scheduler/server/server.cxx src/scheduler/server/parts_handler.cxx src/scheduler/server/request_handler.cxx 
  src/scheduler/schedule/config.cxx src/scheduler/schedule/schedule.cxx src/scheduler/schedule/task.cxx src/scheduler/schedule/step.cxx 
  src/scheduler/schedule/tasksmanager.cxx src/scheduler/schedule/step_configurations.cxx src/scheduler/schedule/publish.cxx
  src/scheduler/schedule/executor/config.cxx src/scheduler/schedule/executor/executor.cxx src/scheduler/schedule/executor/local.cxx 
  src/scheduler/schedule/executor/linux_cores.cxx
  src/scheduler/api/schedule_api.cxx
  src/scheduler/cache/config.cxx src/scheduler/cache/cache.cxx
)

add_executable(srv ${SRV_SRC})
target_link_libraries(srv PRIVATE Poco)
target_include_directories(srv PRIVATE ${RAPIDJSON_PATH})

add_executable(srv-static ${SRV_SRC})
target_link_libraries(srv-static PRIVATE Poco)
target_include_directories(srv-static PRIVATE ${RAPIDJSON_PATH})
target_link_options(srv-static PRIVATE -static)

add_executable(testcpu src/cpu.cxx src/scheduler/schedule/executor/linux_cores.cxx)

EmbedTextFile("${CMAKE_CURRENT_SOURCE_DIR}/src/publisher/publish/index.html" 
  "${CMAKE_CURRENT_SOURCE_DIR}/src/publisher/publish/embeded/index_html.h" Publisher_Index)
EmbedTextFile("${CMAKE_CURRENT_SOURCE_DIR}/src/publisher/publish/index.css" 
  "${CMAKE_CURRENT_SOURCE_DIR}/src/publisher/publish/embeded/index_css.h" Publisher_CSS)
EmbedTextFile("${CMAKE_CURRENT_SOURCE_DIR}/src/publisher/publish/index.js" 
  "${CMAKE_CURRENT_SOURCE_DIR}/src/publisher/publish/embeded/index_js.h" Publisher_JS)

set(PUBLISHER_SRC
  src/publisher/main.cxx src/publisher/config.cxx 
  src/publisher/server/config.cxx src/publisher/server/server.cxx 
  src/publisher/server/parts_handler.cxx src/publisher/server/request_handler.cxx 
  src/publisher/publish/config.cxx src/publisher/publish/publish.cxx
)

add_executable(publisher ${PUBLISHER_SRC})
target_link_libraries(publisher PRIVATE Poco)
target_include_directories(publisher PRIVATE ${RAPIDJSON_PATH})

add_executable(publisher-static ${PUBLISHER_SRC})
target_link_libraries(publisher-static PRIVATE Poco)
target_include_directories(publisher-static PRIVATE ${RAPIDJSON_PATH})
target_link_options(publisher-static PRIVATE -static)
